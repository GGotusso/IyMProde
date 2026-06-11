-- =====================================================================
--  MIGRACIÓN: pronósticos ESPECIALES (campeón, finalistas, semis, goleador)
--  Seguro de correr: NO borra partidos ni pronósticos existentes.
--  Pegar en Supabase -> SQL Editor -> Run.
--  Puntaje (editá los números si querés): campeón 15, finalista 6,
--  semifinalista 4, goleador 10. Se cierran al inicio del Mundial.
-- =====================================================================

-- 1) Tabla de pronósticos especiales
create table if not exists public.special_predictions (
  player_id  uuid not null references public.players(id) on delete cascade,
  market     text not null,            -- 'champion' | 'finalists' | 'semifinalists' | 'top_scorer'
  picks      jsonb not null,           -- array de strings (equipos o nombre del goleador)
  updated_at timestamptz not null default now(),
  primary key (player_id, market)
);
alter table public.special_predictions enable row level security;
-- sin políticas para anon => deny-all; todo pasa por RPC (security definer)

-- 2) Respuestas reales (derivadas de los partidos y de la caché de goleadores)
--    IMPORTANTE: se busca por STAGE y no por id ('FINAL'/'SF-1'): el sync
--    reemplaza los partidos seed por filas con id 'api-...' y los ids viejos
--    desaparecen. 'winner' resuelve el campeón cuando la final va a penales.
alter table public.matches add column if not exists winner text;

create or replace view public.special_results as
select
  (select case when m.home_goals > m.away_goals then m.home_team
               when m.away_goals > m.home_goals then m.away_team
               else m.winner end
     from public.matches m where m.stage = 'FINAL'
     order by (m.source = 'api') desc limit 1)                          as champion,
  (select array_remove(array[m.home_team, m.away_team], 'Por definir')
     from public.matches m where m.stage = 'FINAL'
     order by (m.source = 'api') desc limit 1)                          as finalists,
  (select array_remove(array_agg(t), 'Por definir')
     from (select unnest(array[home_team, away_team]) t
             from public.matches where stage = 'SF') x)                 as semifinalists,
  (select data->0->'player'->>'name'
     from public.meta_cache where key = 'scorers')                      as top_scorer;

-- 2b) Tabla de posiciones por grupo (para puntuar 1º y 2º).
--     'group_done' = true cuando ya se jugaron los 6 partidos del grupo.
create or replace view public.group_table as
with teams as (
  select distinct group_name, team from (
    select group_name, home_team team from public.matches where stage='group'
    union select group_name, away_team    from public.matches where stage='group'
  ) z
),
played as (
  select group_name, team, sum(pts) pts, sum(gd) gd, sum(gf) gf from (
    select group_name, home_team team,
           (case when home_goals>away_goals then 3 when home_goals=away_goals then 1 else 0 end) pts,
           (home_goals-away_goals) gd, home_goals gf
      from public.matches where stage='group' and home_goals is not null
    union all
    select group_name, away_team,
           (case when away_goals>home_goals then 3 when away_goals=home_goals then 1 else 0 end),
           (away_goals-home_goals), away_goals
      from public.matches where stage='group' and home_goals is not null
  ) s group by group_name, team
),
agg as (
  select t.group_name, t.team,
         coalesce(p.pts,0) pts, coalesce(p.gd,0) gd, coalesce(p.gf,0) gf
  from teams t left join played p on p.group_name=t.group_name and p.team=t.team
),
done as (
  select group_name from public.matches where stage='group'
  group by group_name having count(*) = count(home_goals)
)
select a.group_name, a.team,
  row_number() over (partition by a.group_name
                     order by a.pts desc, a.gd desc, a.gf desc, a.team asc) as pos,
  (a.group_name in (select group_name from done)) as group_done
from agg a;

-- 3) Puntos especiales por jugador (mercados fijos + 1º/2º de cada grupo)
create or replace view public.special_points as
select player_id, sum(points)::int as points from (
  -- campeón (15)
  select sp.player_id,
    case when r.champion is not null and sp.picks->>0 = r.champion then 15 else 0 end as points
  from public.special_predictions sp cross join public.special_results r
  where sp.market = 'champion'
  union all
  -- finalistas (6 c/u)
  select sp.player_id,
    coalesce((select count(*) from jsonb_array_elements_text(sp.picks) e
              where e.value = any(r.finalists)), 0) * 6
  from public.special_predictions sp cross join public.special_results r
  where sp.market = 'finalists'
  union all
  -- semifinalistas (4 c/u)
  select sp.player_id,
    coalesce((select count(*) from jsonb_array_elements_text(sp.picks) e
              where e.value = any(r.semifinalists)), 0) * 4
  from public.special_predictions sp cross join public.special_results r
  where sp.market = 'semifinalists'
  union all
  -- goleador (10)
  select sp.player_id,
    case when r.top_scorer is not null and sp.picks->>0 = r.top_scorer then 10 else 0 end
  from public.special_predictions sp cross join public.special_results r
  where sp.market = 'top_scorer'
  union all
  -- 1º (3) y 2º (2) de cada grupo
  select sp.player_id,
    (case when gt1.group_done and sp.picks->>0 = gt1.team then 3 else 0 end)
    + (case when gt2.group_done and sp.picks->>1 = gt2.team then 2 else 0 end)
  from public.special_predictions sp
  left join public.group_table gt1 on gt1.group_name = substring(sp.market from 7) and gt1.pos = 1
  left join public.group_table gt2 on gt2.group_name = substring(sp.market from 7) and gt2.pos = 2
  where sp.market like 'group\_%'
) x group by player_id;

-- 4) Ranking final = puntos de partidos + puntos especiales
drop view if exists public.leaderboard;
create view public.leaderboard as
select
  p.id   as player_id,
  p.name as player_name,
  (coalesce(mp.points, 0) + coalesce(sp.points, 0))::int as points,
  coalesce(mp.exact_hits, 0)::int     as exact_hits,
  coalesce(mp.scored_matches, 0)::int as scored_matches
from public.players p
left join (
  select player_id,
         sum(points)            as points,
         sum((points = 3)::int) as exact_hits,
         count(match_id)        as scored_matches
  from public.scored group by player_id
) mp on mp.player_id = p.id
left join public.special_points sp on sp.player_id = p.id
order by points desc, exact_hits desc, p.name asc;

grant select on public.leaderboard to anon, authenticated;

-- 5) RPC: guardar especiales (valida cantidad y fecha límite = inicio del Mundial)
create or replace function public.save_special(
  p_token uuid, p_market text, p_picks jsonb
) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_player players%rowtype;
  v_count  int;
  v_deadline timestamptz;
begin
  v_player := _player_by_token(p_token);

  select min(kickoff) into v_deadline from matches;
  if v_deadline is not null and now() >= v_deadline then
    raise exception 'ESPECIALES_CERRADOS';
  end if;

  if p_market not in ('champion','finalists','semifinalists','top_scorer')
     and p_market !~ '^group_[A-L]$' then
    raise exception 'MERCADO_INVALIDO';
  end if;

  v_count := jsonb_array_length(p_picks);
  if (p_market = 'champion'       and v_count <> 1)
  or (p_market = 'top_scorer'     and v_count <> 1)
  or (p_market = 'finalists'      and v_count <> 2)
  or (p_market = 'semifinalists'  and v_count <> 4)
  or (p_market ~ '^group_[A-L]$'  and v_count <> 2) then
    raise exception 'CANTIDAD_INVALIDA';
  end if;

  insert into special_predictions(player_id, market, picks, updated_at)
  values (v_player.id, p_market, p_picks, now())
  on conflict (player_id, market)
  do update set picks = excluded.picks, updated_at = now();
end;
$$;

-- 6) RPC: leer mis especiales
create or replace function public.my_specials(p_token uuid)
returns table(market text, picks jsonb)
language plpgsql security definer set search_path = public as $$
declare v_player players%rowtype;
begin
  v_player := _player_by_token(p_token);
  return query
    select sp.market, sp.picks from special_predictions sp
    where sp.player_id = v_player.id;
end;
$$;

grant execute on function
  public.save_special(uuid,text,jsonb),
  public.my_specials(uuid)
to anon, authenticated;
