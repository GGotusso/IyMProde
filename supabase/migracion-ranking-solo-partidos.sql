-- =====================================================================
--  MIGRACION: ranking solo por pronosticos de partidos
--  Seguro de correr: no borra datos ni tablas.
--
--  Objetivo:
--  - El ranking general vuelve a sumar solamente public.scored.
--  - El desglose del ranking devuelve solamente partidos.
--  - Los datos historicos de especiales, si existen, quedan guardados pero
--    ya no afectan ninguna suma del ranking.
-- =====================================================================

drop view if exists public.leaderboard;
create view public.leaderboard as
select
  p.id   as player_id,
  p.name as player_name,
  coalesce(sum(s.points), 0)::int            as points,
  coalesce(sum((s.points = 3)::int), 0)::int as exact_hits,
  coalesce(count(s.match_id), 0)::int        as scored_matches
from public.players p
left join public.scored s on s.player_id = p.id
group by p.id, p.name
order by points desc, exact_hits desc, p.name asc;

grant select on public.leaderboard to anon, authenticated;

create or replace function public.player_score_breakdown(p_player_id uuid)
returns table(
  item_type  text,
  category   text,
  label      text,
  result     text,
  prediction text,
  points     int,
  kickoff    timestamptz,
  sort_order int
)
language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from public.players p where p.id = p_player_id) then
    return;
  end if;

  return query
    select
      'match'::text as item_type,
      case
        when public.calc_points(pr.home_goals, pr.away_goals, m.home_goals, m.away_goals) = 3 then 'exacto'
        when public.calc_points(pr.home_goals, pr.away_goals, m.home_goals, m.away_goals) = 1 then 'signo'
        else 'error'
      end::text as category,
      (m.home_team || ' vs ' || m.away_team)::text as label,
      (m.home_goals::text || '-' || m.away_goals::text)::text as result,
      (pr.home_goals::text || '-' || pr.away_goals::text)::text as prediction,
      public.calc_points(pr.home_goals, pr.away_goals, m.home_goals, m.away_goals)::int as points,
      m.kickoff,
      row_number() over (order by m.kickoff asc, m.id asc)::int as sort_order
    from public.predictions pr
    join public.matches m on m.id = pr.match_id
    where pr.player_id = p_player_id
      and m.home_goals is not null
      and m.away_goals is not null
    order by m.kickoff asc, m.id asc;
end;
$$;

grant execute on function public.player_score_breakdown(uuid) to anon, authenticated;
