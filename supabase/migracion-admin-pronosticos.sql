-- =====================================================================
--  MIGRACIÓN: el admin puede cargar el pronóstico de OTRO jugador
--  (para el amigo que se olvidó y el partido ya está 🔒 bloqueado).
--  Seguro de correr: NO borra nada. Pegar en Supabase -> SQL Editor -> Run.
--
--  A diferencia de save_predictions, acá NO se valida el kickoff: el
--  admin saltea el bloqueo a propósito. Solo puede llamarla un admin
--  (token de sesión + is_admin), igual que el resto del panel.
-- =====================================================================

-- Guardar/pisar el pronóstico de un jugador para un partido.
create or replace function public.admin_set_prediction(
  p_token uuid, p_player_id uuid, p_match_id text, p_home int, p_away int
) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform _require_admin(p_token);

  if p_home is null or p_away is null
     or p_home < 0 or p_away < 0 or p_home > 99 or p_away > 99 then
    raise exception 'MARCADOR_INVALIDO';
  end if;
  if not exists (select 1 from players where id = p_player_id) then
    raise exception 'JUGADOR_INEXISTENTE';
  end if;
  if not exists (select 1 from matches where id = p_match_id) then
    raise exception 'PARTIDO_INEXISTENTE';
  end if;

  insert into predictions(player_id, match_id, home_goals, away_goals, updated_at)
  values (p_player_id, p_match_id, p_home, p_away, now())
  on conflict (player_id, match_id)
  do update set home_goals = excluded.home_goals,
                away_goals = excluded.away_goals,
                updated_at = now();
end;
$$;

-- Leer el pronóstico actual de un jugador para un partido (para precargar
-- el formulario y avisar antes de pisar algo ya cargado).
create or replace function public.admin_get_prediction(
  p_token uuid, p_player_id uuid, p_match_id text
) returns table(home_goals int, away_goals int)
language plpgsql security definer set search_path = public as $$
begin
  perform _require_admin(p_token);
  -- (columnas calificadas con alias: los nombres de salida coinciden con
  --  los de la tabla y serían ambiguos)
  return query
    select pr.home_goals, pr.away_goals
    from predictions pr
    where pr.player_id = p_player_id and pr.match_id = p_match_id;
end;
$$;

grant execute on function
  public.admin_set_prediction(uuid, uuid, text, int, int),
  public.admin_get_prediction(uuid, uuid, text)
to anon, authenticated;
