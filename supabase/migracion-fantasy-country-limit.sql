-- =====================================================================
--  FANTASY · Límite de 2 jugadores por país (selección)
--  Reemplaza fantasy_save_squad agregando la validación: no se pueden
--  elegir más de 2 jugadores del mismo equipo nacional.
--  Pegar en Supabase → SQL Editor → Run. Seguro de re-correr.
-- =====================================================================
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

  if v_found <> 11 then raise exception 'PICKS_INVALIDOS'; end if;

  if v_total > 100 then raise exception 'PRESUPUESTO_EXCEDIDO'; end if;

  if v_gk <> 1 or v_def < 3 or v_def > 5 or v_mid < 2 or v_mid > 5
     or v_fwd < 1 or v_fwd > 3 then
    raise exception 'FORMACION_INVALIDA';
  end if;

  -- Máximo 2 jugadores por país.
  if exists (
    select 1 from fantasy_players
    where id in (select x::uuid from jsonb_array_elements_text(p_picks) x)
    group by team having count(*) > 2
  ) then
    raise exception 'LIMITE_PAIS';
  end if;

  if p_captain is null
     or not exists (select 1 from jsonb_array_elements_text(p_picks) x
                    where x::uuid = p_captain) then
    raise exception 'CAPITAN_INVALIDO';
  end if;

  delete from fantasy_squads where player_id = v_player.id and phase = p_phase;
  insert into fantasy_squads(player_id, phase, footballer_id, is_captain)
  select v_player.id, p_phase, x::uuid, (x::uuid = p_captain)
  from jsonb_array_elements_text(p_picks) x;
end;
$$;
