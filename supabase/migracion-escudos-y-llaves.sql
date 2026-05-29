-- =====================================================================
--  MIGRACIÓN: escudos + bloqueo de eliminatorias (+ fix pgcrypto)
--  Seguro de correr: NO borra partidos ni pronósticos.
--  Pegar en Supabase -> SQL Editor -> Run.
-- =====================================================================

-- 1) Columnas para los escudos
alter table public.matches add column if not exists home_crest text;
alter table public.matches add column if not exists away_crest text;

-- 2) Fix pgcrypto (gen_salt/crypt viven en el schema "extensions")
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
  if length(trim(coalesce(p_name,''))) < 2 then raise exception 'NOMBRE_CORTO'; end if;
  if length(coalesce(p_pin,'')) < 4 then raise exception 'PIN_CORTO'; end if;

  select * into v_player from players where name_key = _norm(p_name);
  if found then
    if v_player.pin_hash <> crypt(p_pin, v_player.pin_hash) then
      raise exception 'PIN_INCORRECTO';
    end if;
    update players set session_token = v_token where id = v_player.id;
    return query select v_player.id, v_player.name, v_token, v_player.is_admin;
  else
    select count(*) into v_count from players;
    insert into players(name, name_key, pin_hash, session_token, is_admin)
    values (trim(p_name), _norm(p_name), crypt(p_pin, gen_salt('bf')),
            v_token, (v_count = 0))
    returning id, players.name, players.is_admin
      into v_player.id, v_player.name, v_player.is_admin;
    return query select v_player.id, v_player.name, v_token, v_player.is_admin;
  end if;
end;
$$;

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
  update players set session_token = v_token where id = v_player.id;
  return query select v_player.id, v_player.name, v_token, v_player.is_admin;
end;
$$;

-- 3) Bloqueo de eliminatorias: solo se habilitan 2 días antes del partido
create or replace function public.save_predictions(
  p_token uuid, p_items jsonb
) returns int
language plpgsql security definer set search_path = public as $$
declare
  v_player players%rowtype;
  v_item   jsonb;
  v_mid    text;
  v_home   int;
  v_away   int;
  v_kick   timestamptz;
  v_stage  text;
  v_saved  int := 0;
  c_knockout_window constant interval := interval '2 days';
begin
  v_player := _player_by_token(p_token);

  for v_item in select * from jsonb_array_elements(p_items) loop
    v_mid  := v_item->>'match_id';
    v_home := (v_item->>'home')::int;
    v_away := (v_item->>'away')::int;

    if v_home is null or v_away is null or v_home < 0 or v_away < 0
       or v_home > 99 or v_away > 99 then continue; end if;

    select kickoff, stage into v_kick, v_stage from matches where id = v_mid;
    if v_kick is null or v_kick <= now() then continue; end if;       -- inexistente o ya empezó
    if v_stage <> 'group' and now() < v_kick - c_knockout_window then continue; end if; -- aún no se habilita

    insert into predictions(player_id, match_id, home_goals, away_goals, updated_at)
    values (v_player.id, v_mid, v_home, v_away, now())
    on conflict (player_id, match_id)
    do update set home_goals = excluded.home_goals,
                  away_goals = excluded.away_goals,
                  updated_at = now();
    v_saved := v_saved + 1;
  end loop;
  return v_saved;
end;
$$;
