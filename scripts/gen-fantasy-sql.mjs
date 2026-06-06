// Genera el SQL para:
//   1) borrar el plantel JUVENIL erróneo de United States + el "Meme" de Iraq,
//   2) insertar a mano los 12 equipos faltantes + el plantel SENIOR real de USA,
// tomando los jugadores del SquadList oficial FIFA (parse-squads.mjs).
// Precio = misma lógica del seed (fantasy-prices.json). Foto = bandera del país.
import { readFileSync, writeFileSync } from "node:fs";
import { parseSquads } from "./parse-squads.mjs";

// --- precios (réplica de fantasy-sync.mjs) ---
const norm = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "")
  .toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
function pkey(name) {
  const parts = norm(name).split(" ").filter(Boolean);
  if (parts.length < 2) return parts.join(" ");
  return parts[0][0] + " " + parts[parts.length - 1];
}
const pj = JSON.parse(readFileSync(new URL("./data/fantasy-prices.json", import.meta.url), "utf8"));
const byFull = new Map(), byInitial = new Map();
for (const p of pj.players || []) { byFull.set(norm(p.name), p.price); byInitial.set(pkey(p.name), p.price); }
const defaults = pj.defaults || { GK: 4.5, DEF: 4.5, MID: 5, FWD: 5.5 };
const priceFor = (name, pos) => byFull.get(norm(name)) ?? byInitial.get(pkey(name)) ?? defaults[pos];

// --- foto = bandera (flagcdn, ISO-2) ---
const FLAG = {
  "Belgium": "be", "Bosnia-Herzegovina": "ba", "Colombia": "co", "Curaçao": "cw",
  "Czechia": "cz", "Egypt": "eg", "France": "fr", "Iran": "ir", "New Zealand": "nz",
  "Senegal": "sn", "Uruguay": "uy", "Uzbekistan": "uz", "United States": "us",
};
const flagUrl = (team) => `https://flagcdn.com/w320/${FLAG[team]}.png`;

const TEAMS = Object.keys(FLAG); // 12 faltantes + United States (re-armado)

const squads = parseSquads();
const sqlEsc = (s) => String(s).replace(/'/g, "''");

const rows = [];
for (const team of TEAMS) {
  const sq = squads[team] || [];
  if (sq.length !== 26) console.error(`⚠ ${team}: ${sq.length} jugadores (esperaba 26)`);
  for (const p of sq) {
    rows.push(`  ('${sqlEsc(p.name)}', '${sqlEsc(team)}', '${p.pos}', ${priceFor(p.name, p.pos)}, '${flagUrl(team)}')`);
  }
}

const sql = `-- =====================================================================
--  FANTASY · Poblar 12 equipos faltantes + corregir United States
--  Generado desde SquadLists-English.pdf (lista FIFA oficial 2026).
--  Seguro de correr: solo toca fantasy_players. Pegar en Supabase → SQL Editor.
--
--  1) Borra el plantel JUVENIL erróneo de USA (la API trajo el sub-20) y el
--     "Meme" de Iraq (no está en la convocatoria FIFA).
--  2) Inserta a mano los 12 equipos que faltaban + el plantel SENIOR de USA.
--     Foto = bandera del país (flagcdn). api_player_id queda NULL: estos
--     jugadores no tienen stats automáticas hasta cruzarlos con la API.
-- =====================================================================

begin;

-- 1) limpieza
delete from public.fantasy_players where team = 'United States';
delete from public.fantasy_players
 where team = 'Iraq' and name = 'Meme';

-- 2) alta (name, team, position, price, photo)
insert into public.fantasy_players (name, team, position, price, photo) values
${rows.join(",\n")};

commit;

-- Control rápido:
--   select team, count(*) from public.fantasy_players group by team order by team;
`;

writeFileSync(new URL("../supabase/migracion-fantasy-squads.sql", import.meta.url), sql);
console.log(`OK · ${rows.length} jugadores en ${TEAMS.length} equipos → supabase/migracion-fantasy-squads.sql`);

// resumen de precios por equipo (top 3) para control
for (const team of TEAMS) {
  const sq = (squads[team] || []).map((p) => ({ ...p, price: priceFor(p.name, p.pos) }))
    .sort((a, b) => b.price - a.price);
  console.log(`  ${team.padEnd(20)} top: ${sq.slice(0, 3).map((p) => `${p.name} ${p.price}`).join(" · ")}`);
}
