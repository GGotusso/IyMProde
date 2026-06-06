-- =====================================================================
--  FANTASY · RPCs de administración del catálogo de jugadores
--  Alta / baja / edición (nombre, equipo, posición, precio, foto).
--  Solo admin. Pegar en Supabase → SQL Editor → Run. Seguro de re-correr.
-- =====================================================================

-- Alta de un jugador nuevo. Devuelve el id creado.
create or replace function public.fantasy_add_player(
  p_token uuid, p_name text, p_team text, p_position text,
  p_price numeric, p_photo text default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_player players%rowtype; v_id uuid;
begin
  v_player := _player_by_token(p_token);
  if not v_player.is_admin then raise exception 'NO_AUTORIZADO'; end if;
  if coalesce(btrim(p_name), '') = '' then raise exception 'NOMBRE_VACIO'; end if;
  if coalesce(btrim(p_team), '') = '' then raise exception 'EQUIPO_VACIO'; end if;
  if p_position not in ('GK','DEF','MID','FWD') then raise exception 'POSICION_INVALIDA'; end if;
  if p_price is null or p_price <= 0 then raise exception 'PRECIO_INVALIDO'; end if;
  insert into fantasy_players(name, team, position, price, photo)
  values (btrim(p_name), btrim(p_team), p_position, p_price, nullif(btrim(p_photo), ''))
  returning id into v_id;
  return v_id;
end;
$$;

-- Edición completa de un jugador (cualquier campo).
create or replace function public.fantasy_update_player(
  p_token uuid, p_footballer uuid, p_name text, p_team text,
  p_position text, p_price numeric, p_photo text default null
) returns void
language plpgsql security definer set search_path = public as $$
declare v_player players%rowtype;
begin
  v_player := _player_by_token(p_token);
  if not v_player.is_admin then raise exception 'NO_AUTORIZADO'; end if;
  if coalesce(btrim(p_name), '') = '' then raise exception 'NOMBRE_VACIO'; end if;
  if coalesce(btrim(p_team), '') = '' then raise exception 'EQUIPO_VACIO'; end if;
  if p_position not in ('GK','DEF','MID','FWD') then raise exception 'POSICION_INVALIDA'; end if;
  if p_price is null or p_price <= 0 then raise exception 'PRECIO_INVALIDO'; end if;
  update fantasy_players
     set name = btrim(p_name), team = btrim(p_team), position = p_position,
         price = p_price, photo = nullif(btrim(p_photo), '')
   where id = p_footballer;
  if not found then raise exception 'JUGADOR_INEXISTENTE'; end if;
end;
$$;

-- Baja de un jugador (borra también su presencia en planteles ya armados).
create or replace function public.fantasy_delete_player(
  p_token uuid, p_footballer uuid
) returns void
language plpgsql security definer set search_path = public as $$
declare v_player players%rowtype;
begin
  v_player := _player_by_token(p_token);
  if not v_player.is_admin then raise exception 'NO_AUTORIZADO'; end if;
  delete from fantasy_players where id = p_footballer;  -- fantasy_squads cae por FK on delete cascade
  if not found then raise exception 'JUGADOR_INEXISTENTE'; end if;
end;
$$;

grant execute on function
  public.fantasy_add_player(uuid,text,text,text,numeric,text),
  public.fantasy_update_player(uuid,uuid,text,text,text,numeric,text),
  public.fantasy_delete_player(uuid,uuid)
to anon, authenticated;
