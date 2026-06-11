-- =====================================================================
--  FIX AUDITORÍA (jun 2026) · pegar TODO en Supabase -> SQL Editor -> Run
--  Seguro de correr: no borra partidos ni pronósticos.
--
--  1) match_predictions: "column reference home_goals is ambiguous".
--     Las columnas de salida de la función se llaman igual que las de la
--     tabla matches; hay que calificar con alias en el SELECT ... INTO.
--  2) special_results: buscaba la final por id = 'FINAL' y las semis por
--     id in ('SF-1','SF-2'), pero esos ids eran del seed; el sync los
--     reemplazó por ids 'api-...'. Campeón / finalistas / semifinalistas
--     no iban a puntuar NUNCA. Ahora se busca por stage.
--  3) matches.winner: nueva columna (la llena el sync desde la API) para
--     poder determinar el campeón si la final termina empatada y se
--     define por penales.
-- =====================================================================

-- ---------- (3) columna winner ----------
alter table public.matches add column if not exists winner text;

-- ---------- (1) fix ambigüedad en match_predictions ----------
create or replace function public.match_predictions(p_match_id text)
returns table(player_name text, home_goals int, away_goals int, points int)
language plpgsql security definer set search_path = public as $$
declare
  v_kick timestamptz;
  v_h    int;
  v_a    int;
begin
  -- OJO: home_goals/away_goals también son columnas de salida de la función;
  -- hay que calificar con el alias de la tabla para que no sean ambiguas.
  select m.kickoff, m.home_goals, m.away_goals into v_kick, v_h, v_a
    from matches m where m.id = p_match_id;

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

-- ---------- (2) special_results por stage (no por id del seed) ----------
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
