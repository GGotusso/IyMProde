-- =====================================================================
--  FANTASY · Ajuste de puntaje (v2)
--  Cambios pedidos:
--    - Valla invicta: SOLO el arquero (antes DEF también).
--    - Se elimina el +2 por jugar 60'+ minutos.
--    - Nuevo: al arquero, -3 por CADA gol recibido (ps.conceded).
--  Solo reemplaza la vista de puntos; las vistas que dependen de ella
--  (fantasy_scored / leaderboard / card) no cambian de columnas.
--  Pegar en Supabase → SQL Editor → Run. Seguro de re-correr.
-- =====================================================================

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
