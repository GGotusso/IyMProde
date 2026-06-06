-- =====================================================================
--  MIGRACIÓN: MINIGAME FANTASY  ·  "Mi Plantel Mundial"
--  Seguro de correr: NO borra partidos, pronósticos ni jugadores (usuarios).
--  Pegar en Supabase -> SQL Editor -> Run.
--
--  Jugabilidad (resumen):
--   - Cada futbolista del Mundial tiene posición, precio y stats.
--   - Cada usuario tiene 100M de presupuesto y arma un plantel de 11
--     (ARQ 1 / DEF 3-5 / MED 2-5 / DEL 1-3 → cubre 4-4-2, 4-3-3, 3-5-2…).
--   - El plantel se puede rehacer LIBRE en cada FASE del Mundial
--     (1 Grupos, 2 16avos, 3 Octavos, 4 Cuartos, 5 Semis+Final), con
--     deadline = primer partido de esa fase.
--   - Capitán = puntos x2.
--   - Puntaje por rendimiento real (lo carga el sync desde API-Football).
-- =====================================================================

create extension if not exists pgcrypto;

-- =====================================================================
--  TABLAS
-- =====================================================================

-- Catálogo de futbolistas (lo siembra el sync desde API-Football una vez).
-- price viene de un JSON de valor de mercado + ajuste manual del admin.
create table if not exists public.fantasy_players (
  id            uuid primary key default gen_random_uuid(),
  api_player_id bigint unique,                       -- id de API-Football (join con stats)
  name          text not null,
  team          text not null,
  position      text not null check (position in ('GK','DEF','MID','FWD')),
  price         numeric not null default 4,          -- en "millones" (presupuesto = 100)
  photo         text
);
create index if not exists idx_fplayers_team on public.fantasy_players(team);
create index if not exists idx_fplayers_pos  on public.fantasy_players(position);

-- Stats por jugador y por partido (las escribe el sync, 1 request por
-- partido FINALIZADO). conceded = goles que recibió el equipo del jugador
-- (para la valla invicta).
create table if not exists public.player_stats (
  match_id      text   not null references public.matches(id) on delete cascade,
  api_player_id bigint not null,
  minutes       int not null default 0,
  goals         int not null default 0,
  assists       int not null default 0,
  yellow        int not null default 0,
  red           int not null default 0,
  pen_missed    int not null default 0,
  pen_saved     int not null default 0,
  own_goals     int not null default 0,
  conceded      int not null default 0,
  primary key (match_id, api_player_id)
);
create index if not exists idx_pstats_player on public.player_stats(api_player_id);

-- Plantel de cada usuario por fase (1..5). Un futbolista por fila.
create table if not exists public.fantasy_squads (
  player_id     uuid    not null references public.players(id) on delete cascade,
  phase         int     not null check (phase between 1 and 5),
  footballer_id uuid    not null references public.fantasy_players(id) on delete cascade,
  is_captain    boolean not null default false,
  primary key (player_id, phase, footballer_id)
);

-- Columnas nuevas en matches: id de fixture de API-Football + flag de
-- "ya bajé las stats de este partido" (para no volver a pedirlo nunca).
alter table public.matches add column if not exists apifootball_fixture_id text;
alter table public.matches add column if not exists stats_fetched          boolean not null default false;

-- =====================================================================
--  RLS  (mismo patrón del proyecto: lectura pública de lo no sensible,
--        escritura solo por RPC SECURITY DEFINER)
-- =====================================================================
alter table public.fantasy_players enable row level security;
alter table public.player_stats    enable row level security;
alter table public.fantasy_squads  enable row level security;

drop policy if exists fplayers_read on public.fantasy_players;
create policy fplayers_read on public.fantasy_players for select to anon, authenticated using (true);

drop policy if exists pstats_read on public.player_stats;
create policy pstats_read on public.player_stats for select to anon, authenticated using (true);

-- fantasy_squads: sin políticas => deny-all para anon. Se accede por RPC
-- (mío) y por las vistas (que corren como owner y saltean RLS).

-- =====================================================================
--  MAPEO DE FASES Y DEADLINES
-- =====================================================================

-- Etapa de un partido -> fase del fantasy (1..5).
create or replace function public.fantasy_phase(p_stage text)
returns int language sql immutable as $$
  select case p_stage
    when 'group' then 1
    when 'R32'   then 2
    when 'R16'   then 3
    when 'QF'    then 4
    else 5                      -- SF, TP, FINAL
  end;
$$;

-- Deadline de cada fase = primer kickoff de sus partidos.
create or replace view public.fantasy_phase_deadline as
select public.fantasy_phase(stage) as phase, min(kickoff) as deadline
from public.matches
group by public.fantasy_phase(stage);

grant select on public.fantasy_phase_deadline to anon, authenticated;

-- =====================================================================
--  SCORING
--  Gol ponderado por posición + asist 3 + valla invicta 4 (solo ARQ)
--  - amarilla 1 - roja 3 - penal errado 2 + penal atajado 5 - gol en contra 2
--  - ARQ: -3 por cada gol recibido
-- =====================================================================

-- Puntos de un futbolista en un partido (sin contar capitán).
create or replace view public.fantasy_player_points as
select
  ps.match_id,
  fp.id            as footballer_id,
  fp.api_player_id,
  (
      ps.goals * (case fp.position when 'FWD' then 4 when 'MID' then 5 else 6 end)
    + ps.assists * 3
    -- valla invicta: solo ARQUERO que jugó 60'+ sin recibir goles
    + (case when fp.position = 'GK' and ps.minutes >= 60 and ps.conceded = 0
            then 4 else 0 end)
    - ps.yellow * 1
    - ps.red * 3
    - ps.pen_missed * 2
    + ps.pen_saved * 5
    - ps.own_goals * 2
    -- arquero: -3 por cada gol que le metan
    - (case when fp.position = 'GK' then ps.conceded * 3 else 0 end)
  )::int as points
from public.player_stats ps
join public.fantasy_players fp on fp.api_player_id = ps.api_player_id;

grant select on public.fantasy_player_points to anon, authenticated;

-- Puntos que cada usuario realmente cobra: solo de los futbolistas que tenía
-- en su plantel DE ESA FASE, en partidos de esa fase, capitán x2.
create or replace view public.fantasy_scored as
select
  fs.player_id,
  fs.phase,
  fs.footballer_id,
  fs.is_captain,
  fpp.match_id,
  (fpp.points * (case when fs.is_captain then 2 else 1 end))::int as points
from public.fantasy_squads fs
join public.fantasy_player_points fpp on fpp.footballer_id = fs.footballer_id
join public.matches m on m.id = fpp.match_id
where public.fantasy_phase(m.stage) = fs.phase;

grant select on public.fantasy_scored to anon, authenticated;

-- Ranking del fantasy (independiente del prode de marcadores).
create or replace view public.fantasy_leaderboard as
select
  p.id   as player_id,
  p.name as player_name,
  coalesce(sum(fsc.points), 0)::int as points
from public.players p
left join public.fantasy_scored fsc on fsc.player_id = p.id
group by p.id, p.name
order by points desc, p.name asc;

grant select on public.fantasy_leaderboard to anon, authenticated;

-- Carta de stats acumuladas por futbolista (para el catálogo y el detalle).
create or replace view public.fantasy_player_card as
select
  fp.id as footballer_id, fp.api_player_id, fp.name, fp.team, fp.position,
  fp.price, fp.photo,
  coalesce(sum(ps.goals),   0)::int as goals,
  coalesce(sum(ps.assists), 0)::int as assists,
  coalesce(sum(ps.minutes), 0)::int as minutes,
  coalesce(sum(ps.yellow),  0)::int as yellow,
  coalesce(sum(ps.red),     0)::int as red,
  coalesce((select sum(pp.points) from public.fantasy_player_points pp
            where pp.footballer_id = fp.id), 0)::int as total_points
from public.fantasy_players fp
left join public.player_stats ps on ps.api_player_id = fp.api_player_id
group by fp.id;

grant select on public.fantasy_player_card to anon, authenticated;

-- =====================================================================
--  RPC  ·  guardar / leer plantel  +  override de precio (admin)
-- =====================================================================

-- Guardar el plantel de una fase. p_picks = array de footballer_id (uuid).
-- Valida: 11 jugadores, formación, presupuesto (<=100) y deadline de la fase.
create or replace function public.fantasy_save_squad(
  p_token uuid, p_phase int, p_picks jsonb, p_captain uuid
) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_player   players%rowtype;
  v_deadline timestamptz;
  v_total    numeric;
  v_gk int; v_def int; v_mid int; v_fwd int; v_found int;
begin
  v_player := _player_by_token(p_token);

  if p_phase < 1 or p_phase > 5 then raise exception 'FASE_INVALIDA'; end if;

  select deadline into v_deadline from fantasy_phase_deadline where phase = p_phase;
  if v_deadline is not null and now() >= v_deadline then
    raise exception 'FASE_CERRADA';
  end if;

  if jsonb_array_length(p_picks) <> 11 then raise exception 'PLANTEL_INCOMPLETO'; end if;

  -- Resumen del plantel elegido (precio total + conteo por posición).
  select
    coalesce(sum(price), 0),
    coalesce(sum((position = 'GK')::int), 0),
    coalesce(sum((position = 'DEF')::int), 0),
    coalesce(sum((position = 'MID')::int), 0),
    coalesce(sum((position = 'FWD')::int), 0),
    count(*)
  into v_total, v_gk, v_def, v_mid, v_fwd, v_found
  from fantasy_players
  where id in (select x::uuid from jsonb_array_elements_text(p_picks) x);

  -- Que existan los 11 (sin ids inexistentes ni duplicados).
  if v_found <> 11 then raise exception 'PICKS_INVALIDOS'; end if;

  if v_total > 100 then raise exception 'PRESUPUESTO_EXCEDIDO'; end if;

  if v_gk <> 1 or v_def < 3 or v_def > 5 or v_mid < 2 or v_mid > 5
     or v_fwd < 1 or v_fwd > 3 then
    raise exception 'FORMACION_INVALIDA';
  end if;

  if p_captain is null
     or not exists (select 1 from jsonb_array_elements_text(p_picks) x
                    where x::uuid = p_captain) then
    raise exception 'CAPITAN_INVALIDO';
  end if;

  -- Reemplazar el plantel de la fase.
  delete from fantasy_squads where player_id = v_player.id and phase = p_phase;
  insert into fantasy_squads(player_id, phase, footballer_id, is_captain)
  select v_player.id, p_phase, x::uuid, (x::uuid = p_captain)
  from jsonb_array_elements_text(p_picks) x;
end;
$$;

-- Leer mi plantel de una fase.
create or replace function public.fantasy_my_squad(p_token uuid, p_phase int)
returns table(footballer_id uuid, is_captain boolean)
language plpgsql security definer set search_path = public as $$
declare v_player players%rowtype;
begin
  v_player := _player_by_token(p_token);
  return query
    select fs.footballer_id, fs.is_captain
    from fantasy_squads fs
    where fs.player_id = v_player.id and fs.phase = p_phase;
end;
$$;

-- Ajustar el precio de un futbolista (solo admin).
create or replace function public.fantasy_set_price(
  p_token uuid, p_footballer uuid, p_price numeric
) returns void
language plpgsql security definer set search_path = public as $$
declare v_player players%rowtype;
begin
  v_player := _player_by_token(p_token);
  if not v_player.is_admin then raise exception 'NO_AUTORIZADO'; end if;
  update fantasy_players set price = p_price where id = p_footballer;
  if not found then raise exception 'JUGADOR_INEXISTENTE'; end if;
end;
$$;

grant execute on function
  public.fantasy_save_squad(uuid,int,jsonb,uuid),
  public.fantasy_my_squad(uuid,int),
  public.fantasy_set_price(uuid,uuid,numeric)
to anon, authenticated;

-- Listo. Corré después el sync (scripts/sync.mjs) con APIFOOTBALL_KEY para
-- sembrar fantasy_players y empezar a bajar player_stats.
