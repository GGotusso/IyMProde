-- =====================================================================
--  MIGRACIÓN: sesiones multi-dispositivo
-- ---------------------------------------------------------------------
--  PROBLEMA: players.session_token es UN SOLO token por jugador. Cada
--  login (join_group / login) genera un token nuevo y pisa el anterior,
--  así que loguearte en el celular invalida la sesión de la web (y
--  viceversa). Al día siguiente, el dispositivo "perdedor" abre con un
--  token viejo -> SESION_INVALIDA -> queda en un estado vacío raro.
--
--  SOLUCIÓN: una tabla de sesiones que admite varios tokens activos por
--  jugador (uno por dispositivo). Los tokens viejos (guardados en
--  players.session_token antes de esta migración) SIGUEN funcionando:
--  _player_by_token los acepta y los migra al vuelo, así nadie se
--  desloguea al correr esto.
--
--  Seguro de correr: NO borra datos ni desloguea a nadie.
--  Pegar en Supabase -> SQL Editor -> Run.
-- =====================================================================

-- 1) Tabla de sesiones (varios tokens por jugador).
create table if not exists public.player_sessions (
  token        uuid primary key default gen_random_uuid(),
  player_id    uuid not null references public.players(id) on delete cascade,
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);
create index if not exists idx_player_sessions_player
  on public.player_sessions(player_id);

alter table public.player_sessions enable row level security;
-- sin políticas para anon => deny-all; todo pasa por RPC (security definer)

-- 2) Migrar los tokens activos actuales para que ninguna sesión se corte.
insert into public.player_sessions(token, player_id)
select session_token, id from public.players
where session_token is not null
on conflict (token) do nothing;

-- 3) Resolver token -> jugador desde player_sessions, con fallback legacy.
create or replace function public._player_by_token(p_token uuid)
returns players language plpgsql security definer set search_path = public as $$
declare v_player players%rowtype;
begin
  select p.* into v_player
    from public.player_sessions s
    join public.players p on p.id = s.player_id
   where s.token = p_token;
  if found then
    update public.player_sessions set last_seen_at = now() where token = p_token;
    return v_player;
  end if;

  -- compatibilidad con sesiones previas a la migración
  select * into v_player from public.players where session_token = p_token;
  if found then
    insert into public.player_sessions(token, player_id)
      values (p_token, v_player.id) on conflict (token) do nothing;
    return v_player;
  end if;

  raise exception 'SESION_INVALIDA';
end;
$$;

-- 4) join_group: abre una sesión NUEVA por dispositivo (no pisa las demás).
create or replace function public.join_group(
  p_code text, p_name text, p_pin text
) returns table(player_id uuid, name text, token uuid, is_admin boolean)
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_code   text;
  v_player players%rowtype;
  v_token  uuid := gen_random_uuid();
  v_count  int;
begin
  select value into v_code from settings where key = 'group_code';
  if v_code is null or p_code is distinct from v_code then
    raise exception 'CODIGO_INVALIDO';
  end if;
  if length(trim(coalesce(p_name,''))) < 2 then
    raise exception 'NOMBRE_CORTO';
  end if;
  if length(coalesce(p_pin,'')) < 4 then
    raise exception 'PIN_CORTO';
  end if;

  select * into v_player from players where name_key = _norm(p_name);

  if found then
    -- nombre existente: es un re-login, valida PIN
    if v_player.pin_hash <> crypt(p_pin, v_player.pin_hash) then
      raise exception 'PIN_INCORRECTO';
    end if;
  else
    select count(*) into v_count from players;
    insert into players(name, name_key, pin_hash, is_admin)
    values (trim(p_name), _norm(p_name), crypt(p_pin, gen_salt('bf')), (v_count = 0))
    returning * into v_player;
  end if;

  insert into player_sessions(token, player_id) values (v_token, v_player.id);
  return query select v_player.id, v_player.name, v_token, v_player.is_admin;
end;
$$;

-- 5) login: idem, una sesión nueva sin tocar las demás.
create or replace function public.login(
  p_name text, p_pin text
) returns table(player_id uuid, name text, token uuid, is_admin boolean)
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_player players%rowtype;
  v_token  uuid := gen_random_uuid();
begin
  select * into v_player from players where name_key = _norm(p_name);
  if not found or v_player.pin_hash <> crypt(p_pin, v_player.pin_hash) then
    raise exception 'CREDENCIALES_INVALIDAS';
  end if;
  insert into player_sessions(token, player_id) values (v_token, v_player.id);
  return query select v_player.id, v_player.name, v_token, v_player.is_admin;
end;
$$;
