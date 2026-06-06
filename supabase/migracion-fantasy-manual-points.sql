-- =====================================================================
--  FANTASY · Carga MANUAL de puntos (fallback del automático)
--  Si la sincronización con API-Football no trae las stats de un partido,
--  el admin puede asignar puntos a mano por jugador y por partido.
--  Se vincula por footballer_id (UUID) porque los jugadores cargados a mano
--  no tienen api_player_id. Fluye al ranking y se duplica si es capitán.
--  Pegar en Supabase → SQL Editor → Run. Seguro de re-correr.
-- =====================================================================

create table if not exists public.fantasy_manual_points (
  match_id      text not null references public.matches(id) on delete cascade,
  footballer_id uuid not null references public.fantasy_players(id) on delete cascade,
  points        int  not null default 0,
  primary key (match_id, footballer_id)
);

alter table public.fantasy_manual_points enable row level security;
drop policy if exists fmp_read on public.fantasy_manual_points;
create policy fmp_read on public.fantasy_manual_points
  for select to anon, authenticated using (true);

-- =====================================================================
--  Vista de puntos: automático (player_stats) + manual.
--  El manual TIENE PRIORIDAD: si hay carga manual para (partido, jugador),
--  se ignora el automático de esa fila (no se duplica).
--  Incluye la fórmula vigente (valla invicta solo ARQ, ARQ -3 por gol).
-- =====================================================================
create or replace view public.fantasy_player_points as
  -- automático (desde stats reales), salvo que exista override manual
  select
    ps.match_id,
    fp.id            as footballer_id,
    fp.api_player_id,
    (
        ps.goals * (case fp.position when 'FWD' then 4 when 'MID' then 5 else 6 end)
      + ps.assists * 3
      + (case when fp.position = 'GK' and ps.minutes >= 60 and ps.conceded = 0
              then 4 else 0 end)
      - ps.yellow * 1
      - ps.red * 3
      - ps.pen_missed * 2
      + ps.pen_saved * 5
      - ps.own_goals * 2
      - (case when fp.position = 'GK' then ps.conceded * 3 else 0 end)
    )::int as points
  from public.player_stats ps
  join public.fantasy_players fp on fp.api_player_id = ps.api_player_id
  where not exists (
    select 1 from public.fantasy_manual_points mp
    where mp.match_id = ps.match_id and mp.footballer_id = fp.id
  )
  union all
  -- manual (cargado por el admin)
  select
    mp.match_id,
    mp.footballer_id,
    fp.api_player_id,
    mp.points
  from public.fantasy_manual_points mp
  join public.fantasy_players fp on fp.id = mp.footballer_id;

grant select on public.fantasy_player_points to anon, authenticated;
grant select on public.fantasy_manual_points to anon, authenticated;

-- =====================================================================
--  RPCs (solo admin): set / delete puntos manuales
-- =====================================================================
create or replace function public.fantasy_set_manual_points(
  p_token uuid, p_match_id text, p_footballer uuid, p_points int
) returns void
language plpgsql security definer set search_path = public as $$
declare v_player players%rowtype;
begin
  v_player := _player_by_token(p_token);
  if not v_player.is_admin then raise exception 'NO_AUTORIZADO'; end if;
  if not exists (select 1 from matches where id = p_match_id) then raise exception 'PARTIDO_INEXISTENTE'; end if;
  if not exists (select 1 from fantasy_players where id = p_footballer) then raise exception 'JUGADOR_INEXISTENTE'; end if;
  insert into fantasy_manual_points(match_id, footballer_id, points)
  values (p_match_id, p_footballer, coalesce(p_points, 0))
  on conflict (match_id, footballer_id) do update set points = excluded.points;
end;
$$;

create or replace function public.fantasy_del_manual_points(
  p_token uuid, p_match_id text, p_footballer uuid
) returns void
language plpgsql security definer set search_path = public as $$
declare v_player players%rowtype;
begin
  v_player := _player_by_token(p_token);
  if not v_player.is_admin then raise exception 'NO_AUTORIZADO'; end if;
  delete from fantasy_manual_points where match_id = p_match_id and footballer_id = p_footballer;
end;
$$;

grant execute on function
  public.fantasy_set_manual_points(uuid,text,uuid,int),
  public.fantasy_del_manual_points(uuid,text,uuid)
to anon, authenticated;
