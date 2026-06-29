-- =====================================================================
--  MIGRACIÓN: panel de admin (gestión de jugadores)
--  Seguro de correr: NO borra datos. Pegar en Supabase -> SQL Editor -> Run.
--
--  Todas las funciones validan que QUIEN LLAMA sea admin (token + is_admin).
--  Borrar un jugador elimina en cascada sus pronosticos
--  (FK on delete cascade ya definidas en el schema).
-- =====================================================================

-- Helper interno: exige que el token pertenezca a un admin.
create or replace function public._require_admin(p_token uuid)
returns players language plpgsql security definer set search_path = public as $$
declare v_me players%rowtype;
begin
  v_me := _player_by_token(p_token);          -- lanza SESION_INVALIDA si no existe
  if not v_me.is_admin then raise exception 'NO_ADMIN'; end if;
  return v_me;
end;
$$;

-- Lista de jugadores con sus datos para el panel.
create or replace function public.admin_list_players(p_token uuid)
returns table(
  id uuid, name text, is_admin boolean, created_at timestamptz,
  points int, exact_hits int, preds int
)
language plpgsql security definer set search_path = public as $$
begin
  perform _require_admin(p_token);
  return query
    select p.id, p.name, p.is_admin, p.created_at,
           coalesce(lb.points, 0)::int,
           coalesce(lb.exact_hits, 0)::int,
           (select count(*)::int from predictions pr where pr.player_id = p.id)
    from players p
    left join leaderboard lb on lb.player_id = p.id
    order by p.created_at asc;
end;
$$;

-- Borrar un jugador (no podés borrarte a vos mismo).
create or replace function public.admin_delete_player(p_token uuid, p_player_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_me players%rowtype;
begin
  v_me := _require_admin(p_token);
  if p_player_id = v_me.id then raise exception 'NO_TE_PODES_BORRAR'; end if;
  delete from players where id = p_player_id;
end;
$$;

-- Hacer / sacar admin (no se puede dejar al grupo sin admins).
create or replace function public.admin_set_admin(p_token uuid, p_player_id uuid, p_value boolean)
returns void language plpgsql security definer set search_path = public as $$
declare v_admins int; v_target_admin boolean;
begin
  perform _require_admin(p_token);
  if p_value is false then
    select is_admin into v_target_admin from players where id = p_player_id;
    if v_target_admin then
      select count(*) into v_admins from players where is_admin = true;
      if v_admins <= 1 then raise exception 'ULTIMO_ADMIN'; end if;
    end if;
  end if;
  update players set is_admin = p_value where id = p_player_id;
end;
$$;

-- Resetear el PIN de un jugador (útil si un amigo lo olvidó).
create or replace function public.admin_reset_pin(p_token uuid, p_player_id uuid, p_new_pin text)
returns void language plpgsql security definer set search_path = public, extensions as $$
begin
  perform _require_admin(p_token);
  if length(coalesce(p_new_pin, '')) < 4 then raise exception 'PIN_CORTO'; end if;
  update players set pin_hash = crypt(p_new_pin, gen_salt('bf')) where id = p_player_id;
end;
$$;

-- Renombrar un jugador.
create or replace function public.admin_rename_player(p_token uuid, p_player_id uuid, p_new_name text)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform _require_admin(p_token);
  if length(trim(coalesce(p_new_name, ''))) < 2 then raise exception 'NOMBRE_CORTO'; end if;
  update players set name = trim(p_new_name), name_key = _norm(p_new_name)
    where id = p_player_id;
exception when unique_violation then raise exception 'NOMBRE_EXISTE';
end;
$$;

grant execute on function
  public.admin_list_players(uuid),
  public.admin_delete_player(uuid, uuid),
  public.admin_set_admin(uuid, uuid, boolean),
  public.admin_reset_pin(uuid, uuid, text),
  public.admin_rename_player(uuid, uuid, text)
  to anon, authenticated;
