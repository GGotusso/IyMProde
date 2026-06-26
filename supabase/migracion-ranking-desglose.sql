-- =====================================================================
--  MIGRACION: desglose de puntos desde el ranking
--  Seguro de correr: NO borra nada. Pegar en Supabase -> SQL Editor -> Run.
--
--  Devuelve, para un jugador, todos los partidos ya puntuados separados en
--  exacto/signo/error y los especiales que efectivamente sumaron puntos.
-- =====================================================================

create or replace function public.player_score_breakdown(p_player_id uuid)
returns table(
  item_type  text,        -- 'match' | 'special'
  category   text,        -- 'exacto' | 'signo' | 'error' | 'especial'
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
  with match_rows as (
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
      1000 + row_number() over (order by m.kickoff asc, m.id asc)::int as sort_order
    from public.predictions pr
    join public.matches m on m.id = pr.match_id
    where pr.player_id = p_player_id
      and m.home_goals is not null
      and m.away_goals is not null
  ),
  special_rows(item_type, category, label, result, prediction, points, kickoff, sort_order) as (
    -- Campeon (15)
    select
      'special'::text,
      'especial'::text,
      'Campeon'::text,
      r.champion::text,
      (sp.picks->>0)::text,
      15::int,
      null::timestamptz,
      10::int
    from public.special_predictions sp
    cross join public.special_results r
    where sp.player_id = p_player_id
      and sp.market = 'champion'
      and r.champion is not null
      and sp.picks->>0 = r.champion

    union all

    -- Finalistas (6 cada uno)
    select
      'special'::text,
      'especial'::text,
      'Finalista'::text,
      array_to_string(r.finalists, ', ')::text,
      e.value::text,
      6::int,
      null::timestamptz,
      20::int
    from public.special_predictions sp
    cross join public.special_results r
    cross join lateral jsonb_array_elements_text(sp.picks) e(value)
    where sp.player_id = p_player_id
      and sp.market = 'finalists'
      and e.value = any(coalesce(r.finalists, array[]::text[]))

    union all

    -- Semifinalistas (4 cada uno)
    select
      'special'::text,
      'especial'::text,
      'Semifinalista'::text,
      array_to_string(r.semifinalists, ', ')::text,
      e.value::text,
      4::int,
      null::timestamptz,
      30::int
    from public.special_predictions sp
    cross join public.special_results r
    cross join lateral jsonb_array_elements_text(sp.picks) e(value)
    where sp.player_id = p_player_id
      and sp.market = 'semifinalists'
      and e.value = any(coalesce(r.semifinalists, array[]::text[]))

    union all

    -- Goleador (10)
    select
      'special'::text,
      'especial'::text,
      'Goleador'::text,
      r.top_scorer::text,
      (sp.picks->>0)::text,
      10::int,
      null::timestamptz,
      40::int
    from public.special_predictions sp
    cross join public.special_results r
    where sp.player_id = p_player_id
      and sp.market = 'top_scorer'
      and r.top_scorer is not null
      and sp.picks->>0 = r.top_scorer

    union all

    -- Primero de grupo (3)
    select
      'special'::text,
      'especial'::text,
      ('1ro Grupo ' || substring(sp.market from 7))::text,
      gt.team::text,
      (sp.picks->>0)::text,
      3::int,
      null::timestamptz,
      (100 + ascii(substring(sp.market from 7)))::int
    from public.special_predictions sp
    join public.group_table gt
      on gt.group_name = substring(sp.market from 7)
     and gt.pos = 1
    where sp.player_id = p_player_id
      and sp.market like 'group\_%'
      and gt.group_done
      and sp.picks->>0 = gt.team

    union all

    -- Segundo de grupo (2)
    select
      'special'::text,
      'especial'::text,
      ('2do Grupo ' || substring(sp.market from 7))::text,
      gt.team::text,
      (sp.picks->>1)::text,
      2::int,
      null::timestamptz,
      (200 + ascii(substring(sp.market from 7)))::int
    from public.special_predictions sp
    join public.group_table gt
      on gt.group_name = substring(sp.market from 7)
     and gt.pos = 2
    where sp.player_id = p_player_id
      and sp.market like 'group\_%'
      and gt.group_done
      and sp.picks->>1 = gt.team
  )
  select
    u.item_type, u.category, u.label, u.result, u.prediction,
    u.points, u.kickoff, u.sort_order
  from (
    select * from special_rows
    union all
    select * from match_rows
  ) u
  order by u.sort_order asc;
end;
$$;

grant execute on function public.player_score_breakdown(uuid) to anon, authenticated;
