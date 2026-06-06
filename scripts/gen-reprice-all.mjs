// Re-precia TODO el catálogo (48 equipos) en una sola migración idempotente.
// Para cada jugador del roster real (db-roster-now.json):
//   base = base-prices-extra.json[equipo][nombre]   (curado a mano, por equipo)
//        ?? fantasy-prices.json (estrellas / default por posición)
//   precio_final = balance(base)   (curva de reprice.mjs)
// Emite UPDATE ... where id in (...) agrupando por precio → SQL compacto.
// Idempotente: valores absolutos por id. Normaliza ademas el estado (equipos
// nuevos que habian quedado sin balancear).
import { readFileSync, writeFileSync } from "node:fs";
import { balance } from "./reprice.mjs";

const here = (p) => new URL(p, import.meta.url);
const roster = JSON.parse(readFileSync(here("./data/db-roster-now.json"), "utf8"));
const extra = JSON.parse(readFileSync(here("./data/base-prices-extra.json"), "utf8"));
const pj = JSON.parse(readFileSync(here("./data/fantasy-prices.json"), "utf8"));

const norm = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "")
  .toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const pkey = (name) => {
  const a = norm(name).split(" ").filter(Boolean);
  return a.length < 2 ? a.join(" ") : a[0][0] + " " + a[a.length - 1];
};

// Tabla de estrellas (JSON) → base price.
const byFull = new Map(), byInitial = new Map();
for (const p of pj.players || []) { byFull.set(norm(p.name), p.price); byInitial.set(pkey(p.name), p.price); }
const defaults = pj.defaults || { GK: 4.5, DEF: 4.5, MID: 5, FWD: 5.5 };
const priceForJSON = (name, pos) => byFull.get(norm(name)) ?? byInitial.get(pkey(name)) ?? defaults[pos];

// Curado por equipo (base-prices-extra) → mapa norm(nombre)->precio por equipo.
const extraByTeam = {};
for (const [team, players] of Object.entries(extra)) {
  if (team.startsWith("_")) continue;
  extraByTeam[team] = {};
  for (const [name, price] of Object.entries(players)) extraByTeam[team][norm(name)] = price;
}

// Asigna base y precio final a cada jugador.
const byPrice = new Map();   // precio_final -> [ids]
let matchedExtra = 0, fromJson = 0, def = 0;
for (const p of roster) {
  const exMap = extraByTeam[p.team];
  let base = exMap ? exMap[norm(p.name)] : undefined;
  if (base != null) matchedExtra++;
  else {
    const j = priceForJSON(p.name, p.position);
    base = j;
    if (j === defaults[p.position]) def++; else fromJson++;
  }
  const final = balance(base);
  (byPrice.get(final) || byPrice.set(final, []).get(final)).push(p.id);
}

const esc = (s) => String(s).replace(/'/g, "''");
let body = "";
for (const price of [...byPrice.keys()].sort((a, b) => a - b)) {
  const ids = byPrice.get(price).map((id) => `'${esc(id)}'`);
  body += `\nupdate public.fantasy_players set price = ${price} where id in (\n  ${ids.join(", ")}\n);\n`;
}

const sql = `-- =====================================================================
--  FANTASY · Re-precio GLOBAL de todo el catálogo (48 equipos)
--  Sube de precio a los jugadores reconocibles que quedaban al piso (según
--  fama, club/liga y peso mediático), preservando el orden por mérito, y
--  aplica la curva de balance (techo ~21M, piso 4.5). Idempotente: setea
--  valores absolutos por id. Normaliza también los equipos que habían
--  quedado sin balancear.
--  Pegar en Supabase → SQL Editor → Run.  (Generado por scripts/gen-reprice-all.mjs)
-- =====================================================================

begin;
${body}
commit;

-- Control:  select price, count(*) from public.fantasy_players group by price order by price desc;
`;

writeFileSync(here("../supabase/migracion-fantasy-reprice-all.sql"), sql);
console.log(`OK · ${roster.length} jugadores · curados a mano: ${matchedExtra} · por JSON: ${fromJson} · default: ${def}`);
console.log(`Buckets de precio: ${byPrice.size} → supabase/migracion-fantasy-reprice-all.sql`);
