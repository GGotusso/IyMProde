-- Diagnóstico de posibles registros duplicados.
-- Pegar en el SQL Editor de Supabase. Son SOLO lecturas (no modifican nada).

-- 1) Duplicados exactos por nombre normalizado.
--    Por la constraint UNIQUE(name_key) esto NO debería devolver filas nunca.
--    Si devuelve algo, hay un problema serio de integridad.
select name_key, count(*) as veces, array_agg(name) as nombres
from players
group by name_key
having count(*) > 1;

-- 2) Casi-duplicados: misma persona con tilde/espacios/puntuación distinta.
--    Normaliza fuerte: minúsculas, quita tildes comunes y deja solo letras/números.
select
  translate(
    regexp_replace(lower(name), '[^a-z0-9áéíóúñü]', '', 'g'),
    'áéíóúñü', 'aeioun u'
  ) as clave_fuerte,
  count(*) as veces,
  array_agg(name order by created_at) as nombres,
  array_agg(created_at order by created_at) as fechas
from players
group by 1
having count(*) > 1;

-- 3) Similitud difusa (typos / abreviaciones): "Gonza" vs "Gonzalo", "Juani" vs "Juan".
--    Requiere la extensión pg_trgm (Supabase la trae; esto la activa si falta).
create extension if not exists pg_trgm;
select a.name as nombre_a, b.name as nombre_b,
       round(similarity(a.name_key, b.name_key)::numeric, 2) as parecido,
       a.created_at as alta_a, b.created_at as alta_b
from players a
join players b on a.id < b.id
where similarity(a.name_key, b.name_key) > 0.4
order by parecido desc;

-- 4) Cuentas "fantasma": jugadores sin ningún pronóstico (suelen ser el duplicado abandonado).
-- (predictions no tiene columna "id": su PK es (player_id, match_id))
select p.name, p.created_at, count(pr.match_id) as pronosticos
from players p
left join predictions pr on pr.player_id = p.id
group by p.id, p.name, p.created_at
having count(pr.match_id) = 0
order by p.created_at;
