-- =====================================================================
--  MIGRACIÓN: cara a cara (vos vs. otro jugador)
--  Seguro de correr: NO borra nada. Pegar en Supabase -> SQL Editor -> Run.
--
--  Devuelve, partido por partido YA TERMINADO, lo que pronosticó cada uno
--  y los puntos que sacó, para comparar a dos jugadores. Solo incluye
--  partidos con resultado (sin spoilers: lo no jugado no aparece).
-- =====================================================================

create or replace function public.head_to_head(p_token uuid, p_other uuid)
returns table(
  match_id    text,
  kickoff     timestamptz,
  stage       text,
  home_team   text,
  away_team   text,
  home_goals  int,
  away_goals  int,
  my_home     int,
  my_away     int,
  my_points   int,
  their_home  int,
  their_away  int,
  their_points int
)
language plpgsql security definer set search_path = public as $$
declare v_me players%rowtype;
begin
  v_me := _player_by_token(p_token);   -- valida la sesión (lanza SESION_INVALIDA)

  return query
    select
      m.id, m.kickoff, m.stage,
      m.home_team, m.away_team, m.home_goals, m.away_goals,
      pme.home_goals, pme.away_goals,
      case when pme.player_id is not null
           then public.calc_points(pme.home_goals, pme.away_goals, m.home_goals, m.away_goals) end,
      pth.home_goals, pth.away_goals,
      case when pth.player_id is not null
           then public.calc_points(pth.home_goals, pth.away_goals, m.home_goals, m.away_goals) end
    from matches m
    left join predictions pme on pme.match_id = m.id and pme.player_id = v_me.id
    left join predictions pth on pth.match_id = m.id and pth.player_id = p_other
    where m.home_goals is not null and m.away_goals is not null
      and (pme.player_id is not null or pth.player_id is not null)
    order by m.kickoff asc;
end;
$$;

grant execute on function public.head_to_head(uuid, uuid) to anon, authenticated;
