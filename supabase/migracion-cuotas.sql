-- =====================================================================
--  MIGRACIÓN: cuotas 1X2 (The Odds API) + mejor casa por resultado
--  Seguro de correr: NO borra partidos ni pronósticos.
--  Pegar en Supabase -> SQL Editor -> Run.
-- ---------------------------------------------------------------------
--  Las columnas odds_home/draw/away ya existían (promedio de casas).
--  Esta migración agrega odds_best: la MEJOR casa por resultado (la que
--  más paga), como JSON:
--    {"home":{"book":"Bet365","price":1.55},
--     "draw":{"book":"Pinnacle","price":4.40},
--     "away":{"book":"Marathon","price":7.90}}
--  Las llena scripts/sync.mjs en cada sincronización.
-- =====================================================================

alter table public.matches add column if not exists odds_home numeric;
alter table public.matches add column if not exists odds_draw numeric;
alter table public.matches add column if not exists odds_away numeric;
alter table public.matches add column if not exists odds_best jsonb;
