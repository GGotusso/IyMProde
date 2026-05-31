-- =====================================================================
--  MIGRACIÓN: ver los pronósticos de los demás (solo tras el cierre)
--  Seguro de correr: NO borra nada. Pegar en Supabase -> SQL Editor -> Run.
--
--  Devuelve, para un partido YA EMPEZADO, lo que pronosticó cada jugador
--  y cuántos puntos sacó. Si el partido todavía no arrancó, devuelve vacío
--  (no se puede espiar a los demás antes del cierre).
-- =====================================================================

create or replace function public.match_predictions(p_match_id text)
returns table(player_name text, home_goals int, away_goals int, points int)
language plpgsql security definer set search_path = public as $$
declare
  v_kick timestamptz;
  v_h    int;
  v_a    int;
begin
  select kickoff, home_goals, away_goals into v_kick, v_h, v_a
    from matches where id = p_match_id;

  -- Sin spoilers: si el partido no empezó (o no existe), no devolvemos nada.
  if v_kick is null or v_kick > now() then
    return;
  end if;

  return query
    select p.name,
           pr.home_goals,
           pr.away_goals,
           public.calc_points(pr.home_goals, pr.away_goals, v_h, v_a)
    from predictions pr
    join players p on p.id = pr.player_id
    where pr.match_id = p_match_id
    order by public.calc_points(pr.home_goals, pr.away_goals, v_h, v_a) desc,
             p.name asc;
end;
$$;

grant execute on function public.match_predictions(text) to anon, authenticated;
