-- =====================================================================
--  PRODE MUNDIAL 2026  ·  Esquema completo de Supabase (Postgres)
-- ---------------------------------------------------------------------
--  Cómo usarlo:
--    1) Creá un proyecto gratis en https://supabase.com
--    2) Entrá a  SQL Editor  ->  New query
--    3) Pegá TODO este archivo y dale "Run".
--    4) (Opcional) Editá la sección CONFIGURACIÓN de abajo (código del
--       grupo, PIN de admin y los equipos de cada grupo del sorteo).
--    5) Volvé a correr SOLO el bloque que cambiaste si querés re-sembrar.
--
--  Seguridad: las tablas tienen RLS (deny-all) para el rol anónimo.
--  El frontend NUNCA escribe en las tablas directo: usa funciones RPC
--  (SECURITY DEFINER) que validan el PIN/token del lado del servidor.
--  La "anon key" de Supabase es pública por diseño: no pasa nada con
--  que viaje en el frontend de GitHub Pages.
-- =====================================================================

create extension if not exists pgcrypto;

-- =====================================================================
--  TABLAS
-- =====================================================================

-- Config global (código del grupo, PIN de admin, etc.)
create table if not exists public.settings (
  key   text primary key,
  value text not null
);

-- Jugadores (amigos). El PIN se guarda hasheado con bcrypt.
create table if not exists public.players (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  name_key      text not null unique,          -- nombre normalizado (lower/trim)
  pin_hash      text not null,
  session_token uuid,                          -- legacy: ver player_sessions
  is_admin      boolean not null default false,
  created_at    timestamptz not null default now()
);

-- Sesiones activas: varios tokens por jugador (uno por dispositivo). Así
-- loguearte en el celular NO invalida la sesión de la web y viceversa.
create table if not exists public.player_sessions (
  token        uuid primary key default gen_random_uuid(),
  player_id    uuid not null references public.players(id) on delete cascade,
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);
create index if not exists idx_player_sessions_player
  on public.player_sessions(player_id);

-- Partidos del torneo (fuente de la verdad de fixture + resultados).
create table if not exists public.matches (
  id          text primary key,                -- ej: 'G-A-1', 'R16-3', 'FINAL'
  stage       text not null,                    -- 'group','R32','R16','QF','SF','TP','FINAL'
  group_name  text,                             -- 'A'..'L' (solo fase de grupos)
  matchday    int,                              -- 1..3 (solo fase de grupos)
  home_team   text not null,
  away_team   text not null,
  kickoff     timestamptz not null,
  home_goals  int,                              -- null = aún no jugado
  away_goals  int,
  sort_order  int not null default 0,
  source      text not null default 'seed',     -- 'seed' (placeholder) | 'api' (sync automático)
  odds_home   numeric,                           -- cuota victoria local (1), promedio de casas
  odds_draw   numeric,                           -- cuota empate (X), promedio de casas
  odds_away   numeric,                            -- cuota victoria visitante (2), promedio de casas
  odds_best   jsonb,                              -- mejor casa por resultado: {"home":{"book":"Bet365","price":1.55}, "draw":{...}, "away":{...}}
  home_crest  text,                               -- URL del escudo local
  away_crest  text,                               -- URL del escudo visitante
  winner      text                                -- ganador (resuelve penales en eliminatorias)
);

-- (Si ya creaste la tabla antes, esto agrega las columnas que falten)
alter table public.matches add column if not exists source     text not null default 'seed';
alter table public.matches add column if not exists odds_home  numeric;
alter table public.matches add column if not exists odds_draw  numeric;
alter table public.matches add column if not exists odds_away  numeric;
alter table public.matches add column if not exists odds_best  jsonb;
alter table public.matches add column if not exists home_crest text;
alter table public.matches add column if not exists away_crest text;
alter table public.matches add column if not exists winner     text;

-- Pronósticos de cada jugador para cada partido.
create table if not exists public.predictions (
  player_id  uuid not null references public.players(id) on delete cascade,
  match_id   text not null references public.matches(id) on delete cascade,
  home_goals int  not null,
  away_goals int  not null,
  updated_at timestamptz not null default now(),
  primary key (player_id, match_id)
);

-- Caché de datos de la API (posiciones, goleadores, etc.) en JSON.
create table if not exists public.meta_cache (
  key        text primary key,                 -- 'standings', 'scorers', ...
  data       jsonb not null,
  updated_at timestamptz not null default now()
);

create index if not exists idx_matches_kickoff on public.matches(kickoff);
create index if not exists idx_predictions_match on public.predictions(match_id);

-- =====================================================================
--  RLS  (bloquea acceso directo de 'anon'; todo pasa por funciones RPC)
-- =====================================================================
alter table public.settings    enable row level security;
alter table public.players     enable row level security;
alter table public.predictions enable row level security;
alter table public.matches     enable row level security;
alter table public.meta_cache  enable row level security;

-- Solo lectura pública del fixture/resultados (no expone datos sensibles).
drop policy if exists matches_read on public.matches;
create policy matches_read on public.matches for select to anon, authenticated using (true);

-- Lectura pública de la caché de la API (posiciones, goleadores).
drop policy if exists meta_read on public.meta_cache;
create policy meta_read on public.meta_cache for select to anon, authenticated using (true);

-- settings / players / predictions: sin políticas => deny-all para anon.
-- (Las funciones SECURITY DEFINER corren como owner y saltean RLS.)

-- =====================================================================
--  SCORING (3 exacto / 1 signo / 0) y RANKING
-- =====================================================================

-- Puntos de un pronóstico contra un resultado.
create or replace function public.calc_points(
  p_home int, p_away int, r_home int, r_away int
) returns int language sql immutable as $$
  select case
    when r_home is null or r_away is null then 0
    when p_home = r_home and p_away = r_away then 3            -- marcador exacto
    when sign(p_home - p_away) = sign(r_home - r_away) then 1  -- acertó el signo
    else 0
  end;
$$;

-- Detalle de puntos por jugador/partido (incluye semana ISO del partido).
create or replace view public.scored as
  select
    pr.player_id,
    p.name              as player_name,
    pr.match_id,
    m.kickoff,
    extract(isoyear from m.kickoff)::int as iso_year,
    extract(week    from m.kickoff)::int as iso_week,
    public.calc_points(pr.home_goals, pr.away_goals, m.home_goals, m.away_goals) as points
  from public.predictions pr
  join public.matches m on m.id = pr.match_id
  join public.players p on p.id = pr.player_id
  where m.home_goals is not null and m.away_goals is not null;

-- Ranking final (total acumulado).
create or replace view public.leaderboard as
  select
    p.id   as player_id,
    p.name as player_name,
    coalesce(sum(s.points), 0)                       as points,
    coalesce(sum((s.points = 3)::int), 0)            as exact_hits,
    coalesce(count(s.match_id), 0)                   as scored_matches
  from public.players p
  left join public.scored s on s.player_id = p.id
  group by p.id, p.name
  order by points desc, exact_hits desc, p.name asc;

-- Ranking semanal (una fila por jugador y semana).
create or replace view public.leaderboard_weekly as
  select
    s.iso_year,
    s.iso_week,
    s.player_id,
    s.player_name,
    sum(s.points)            as points,
    sum((s.points = 3)::int) as exact_hits
  from public.scored s
  group by s.iso_year, s.iso_week, s.player_id, s.player_name
  order by s.iso_year, s.iso_week, points desc, exact_hits desc, s.player_name;

grant select on public.leaderboard, public.leaderboard_weekly to anon, authenticated;

-- =====================================================================
--  FUNCIONES RPC  (lo único que el frontend puede ejecutar para escribir)
-- =====================================================================

-- Normaliza nombres para evitar duplicados por mayúsculas/espacios.
create or replace function public._norm(t text)
returns text language sql immutable as $$ select lower(trim(t)); $$;

-- Unirse al grupo / registrarse. Si el nombre ya existe, valida el PIN
-- (sirve también como "volver a entrar"). El primer jugador = admin.
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

  -- una sesión nueva por dispositivo (no pisa las de otros dispositivos)
  insert into player_sessions(token, player_id) values (v_token, v_player.id);
  return query select v_player.id, v_player.name, v_token, v_player.is_admin;
end;
$$;

-- Login de un jugador existente.
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

-- Resuelve un token a un jugador (helper interno).
create or replace function public._player_by_token(p_token uuid)
returns players language plpgsql security definer set search_path = public as $$
declare v_player players%rowtype;
begin
  select p.* into v_player
    from player_sessions s join players p on p.id = s.player_id
   where s.token = p_token;
  if found then
    update player_sessions set last_seen_at = now() where token = p_token;
    return v_player;
  end if;
  -- compatibilidad con sesiones previas a player_sessions
  select * into v_player from players where session_token = p_token;
  if found then
    insert into player_sessions(token, player_id)
      values (p_token, v_player.id) on conflict (token) do nothing;
    return v_player;
  end if;
  raise exception 'SESION_INVALIDA';
end;
$$;

-- Guardar/actualizar pronósticos en lote.
-- p_items: jsonb array -> [{"match_id":"G-A-1","home":2,"away":1}, ...]
-- Rechaza partidos cuyo kickoff ya pasó (deadline).
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
  c_knockout_window constant interval := interval '2 days'; -- se habilita 2 días antes
begin
  v_player := _player_by_token(p_token);

  for v_item in select * from jsonb_array_elements(p_items) loop
    v_mid  := v_item->>'match_id';
    v_home := (v_item->>'home')::int;
    v_away := (v_item->>'away')::int;

    if v_home is null or v_away is null or v_home < 0 or v_away < 0
       or v_home > 99 or v_away > 99 then
      continue;
    end if;

    select kickoff, stage into v_kick, v_stage from matches where id = v_mid;
    if v_kick is null or v_kick <= now() then
      continue; -- partido inexistente o ya cerrado (empezó)
    end if;
    -- eliminatorias: solo se habilitan 2 días antes del partido
    if v_stage <> 'group' and now() < v_kick - c_knockout_window then
      continue;
    end if;

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

-- Mis pronósticos (para precargar la pantalla).
create or replace function public.my_predictions(p_token uuid)
returns table(match_id text, home_goals int, away_goals int)
language plpgsql security definer set search_path = public as $$
declare v_player players%rowtype;
begin
  v_player := _player_by_token(p_token);
  return query
    select pr.match_id, pr.home_goals, pr.away_goals
    from predictions pr where pr.player_id = v_player.id;
end;
$$;

-- Cargar/actualizar un resultado (solo admin).
create or replace function public.set_result(
  p_token uuid, p_match_id text, p_home int, p_away int
) returns void
language plpgsql security definer set search_path = public as $$
declare v_player players%rowtype;
begin
  v_player := _player_by_token(p_token);
  if not v_player.is_admin then raise exception 'NO_AUTORIZADO'; end if;

  update matches
     set home_goals = p_home, away_goals = p_away
   where id = p_match_id;
  if not found then raise exception 'PARTIDO_INEXISTENTE'; end if;
end;
$$;

-- Editar equipos de un partido (solo admin) — útil para cargar el sorteo
-- o resolver llaves de eliminatoria ("Por definir" -> equipo real).
create or replace function public.set_teams(
  p_token uuid, p_match_id text, p_home text, p_away text
) returns void
language plpgsql security definer set search_path = public as $$
declare v_player players%rowtype;
begin
  v_player := _player_by_token(p_token);
  if not v_player.is_admin then raise exception 'NO_AUTORIZADO'; end if;
  update matches set home_team = p_home, away_team = p_away where id = p_match_id;
  if not found then raise exception 'PARTIDO_INEXISTENTE'; end if;
end;
$$;

-- Permisos de ejecución para el rol anónimo (frontend).
grant execute on function
  public.join_group(text,text,text),
  public.login(text,text),
  public.save_predictions(uuid,jsonb),
  public.my_predictions(uuid),
  public.set_result(uuid,text,int,int),
  public.set_teams(uuid,text,text,text)
to anon, authenticated;

-- =====================================================================
--  CONFIGURACIÓN  ·  EDITÁ ESTO
-- =====================================================================

-- Código del grupo que compartís con tus amigos para que entren.
insert into public.settings(key, value) values ('group_code', 'MUNDIAL2026')
on conflict (key) do update set value = excluded.value;

-- =====================================================================
--  SEMBRADO DEL FIXTURE  (12 grupos x 4 equipos + eliminatorias)
-- ---------------------------------------------------------------------
--  IMPORTANTE: estos equipos son un PLACEHOLDER editable. Reemplazalos
--  por el sorteo oficial (podés hacerlo acá y re-correr, o desde la
--  pantalla de Admin del frontend). El Mundial 2026 tiene 48 equipos en
--  12 grupos (A..L); avanzan 1°, 2° y los 8 mejores 3°.
-- =====================================================================
do $$
declare
  -- 12 grupos (A..L) x 4 equipos.  <-- EDITÁ ESTOS NOMBRES con el sorteo
  g text[][] := array[
    array['México','Por definir A2','Por definir A3','Por definir A4'],        -- A (anfitrión MEX)
    array['Canadá','Por definir B2','Por definir B3','Por definir B4'],         -- B (anfitrión CAN)
    array['Estados Unidos','Por definir C2','Por definir C3','Por definir C4'], -- C (anfitrión USA)
    array['Argentina','Por definir D2','Por definir D3','Por definir D4'],      -- D
    array['Francia','Por definir E2','Por definir E3','Por definir E4'],        -- E
    array['Brasil','Por definir F2','Por definir F3','Por definir F4'],         -- F
    array['Inglaterra','Por definir G2','Por definir G3','Por definir G4'],     -- G
    array['España','Por definir H2','Por definir H3','Por definir H4'],         -- H
    array['Portugal','Por definir I2','Por definir I3','Por definir I4'],       -- I
    array['Países Bajos','Por definir J2','Por definir J3','Por definir J4'],   -- J
    array['Alemania','Por definir K2','Por definir K3','Por definir K4'],       -- K
    array['Bélgica','Por definir L2','Por definir L3','Por definir L4']         -- L
  ];
  letters text[] := array['A','B','C','D','E','F','G','H','I','J','K','L'];
  -- pares round-robin para 4 equipos (índices 1..4) por jornada
  rr int[][] := array[ array[1,2], array[3,4], array[1,3], array[4,2], array[1,4], array[2,3] ];
  md int[]   := array[1,1,2,2,3,3];
  gi int; mi int; n int;
  home text; away text; letter text;
  base date := date '2026-06-11';   -- inicio fase de grupos
  kick timestamptz;
begin
  -- limpiar para re-sembrar
  delete from public.matches;

  -- ---- Fase de grupos: 12 grupos x 6 partidos = 72 ----
  for gi in 1..12 loop
    letter := letters[gi];
    for mi in 1..6 loop
      home := g[gi][ rr[mi][1] ];
      away := g[gi][ rr[mi][2] ];
      -- fechas escalonadas: jornada 1 (11-16), 2 (17-22), 3 (23-27)
      kick := (base + ((md[mi]-1)*6 + ((gi-1) % 6)) * interval '1 day')
              + interval '16 hours';
      insert into public.matches(id, stage, group_name, matchday,
                                 home_team, away_team, kickoff, sort_order)
      values (format('G-%s-%s', letter, mi), 'group', letter, md[mi],
              home, away, kick, gi*10 + mi);
    end loop;
  end loop;

  -- ---- Eliminatorias (placeholders 'Por definir') ----
  -- Dieciseisavos (R32): 16 partidos
  for n in 1..16 loop
    insert into public.matches(id, stage, home_team, away_team, kickoff, sort_order)
    values (format('R32-%s', n), 'R32', 'Por definir', 'Por definir',
            (date '2026-06-28' + ((n-1)/2) * interval '1 day') + interval '17 hours',
            1000 + n);
  end loop;
  -- Octavos (R16): 8
  for n in 1..8 loop
    insert into public.matches(id, stage, home_team, away_team, kickoff, sort_order)
    values (format('R16-%s', n), 'R16', 'Por definir', 'Por definir',
            (date '2026-07-04' + ((n-1)/2) * interval '1 day') + interval '17 hours',
            2000 + n);
  end loop;
  -- Cuartos (QF): 4
  for n in 1..4 loop
    insert into public.matches(id, stage, home_team, away_team, kickoff, sort_order)
    values (format('QF-%s', n), 'QF', 'Por definir', 'Por definir',
            (date '2026-07-09' + ((n-1)/2) * interval '1 day') + interval '17 hours',
            3000 + n);
  end loop;
  -- Semis (SF): 2
  for n in 1..2 loop
    insert into public.matches(id, stage, home_team, away_team, kickoff, sort_order)
    values (format('SF-%s', n), 'SF', 'Por definir', 'Por definir',
            (date '2026-07-14' + (n-1) * interval '1 day') + interval '20 hours',
            4000 + n);
  end loop;
  -- Tercer puesto
  insert into public.matches(id, stage, home_team, away_team, kickoff, sort_order)
  values ('TP', 'TP', 'Por definir', 'Por definir',
          timestamptz '2026-07-18 16:00', 5000);
  -- Final
  insert into public.matches(id, stage, home_team, away_team, kickoff, sort_order)
  values ('FINAL', 'FINAL', 'Por definir', 'Por definir',
          timestamptz '2026-07-19 16:00', 6000);
end;
$$;

-- Listo. 104 partidos sembrados (72 grupos + 32 eliminatorias).
