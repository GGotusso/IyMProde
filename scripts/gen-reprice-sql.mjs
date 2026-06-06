// Genera supabase/migracion-fantasy-reprice.sql: re-precia los equipos que YA
// estaban en la DB (los 35 que NO toca migracion-fantasy-squads.sql) aplicando
// la curva de balance (reprice.mjs) sobre su precio actual (db-players-snapshot).
// UPDATEs con valor ABSOLUTO → idempotente (re-correrlo da el mismo resultado).
import { readFileSync, writeFileSync } from "node:fs";
import { balance } from "./reprice.mjs";

const snap = JSON.parse(readFileSync(new URL("./data/db-players-snapshot.json", import.meta.url), "utf8"));

// Equipos que (re)inserta la migración de squads — esos ya salen balanceados de ahí.
const SQUADS_TEAMS = new Set(["Belgium", "Bosnia-Herzegovina", "Colombia", "Curaçao",
  "Czechia", "Egypt", "France", "Iran", "New Zealand", "Senegal", "Uruguay",
  "Uzbekistan", "United States"]);

const esc = (s) => String(s).replace(/'/g, "''");

const rows = snap.filter((p) => !SQUADS_TEAMS.has(p.team));
// Agrupa por nuevo precio para emitir un UPDATE por valor (SQL compacto).
const byNew = new Map();
for (const p of rows) {
  const np = balance(p.price);
  if (Number(np) === Number(p.price)) continue; // sin cambio, no hace falta UPDATE
  (byNew.get(np) || byNew.set(np, []).get(np)).push(p);
}

let body = "";
for (const np of [...byNew.keys()].sort((a, b) => a - b)) {
  const ps = byNew.get(np);
  const conds = ps.map((p) => `(team = '${esc(p.team)}' and name = '${esc(p.name)}')`);
  body += `\nupdate public.fantasy_players set price = ${np} where\n  ${conds.join("\n  or ")};\n`;
}

const sql = `-- =====================================================================
--  FANTASY · Balance global de precios (equipos ya existentes en la DB)
--  Aplica la curva de reprice.mjs (techo ~21M, piso 4.5) sobre el precio
--  actual de cada jugador, preservando el orden por mérito. Objetivo: que no
--  se pueda armar un plantel "todas estrellas" (máx ~3 cracks ≥15M en un XI).
--
--  Solo toca los 35 equipos que YA estaban cargados; los 13 de
--  migracion-fantasy-squads.sql ya salen balanceados de esa migración.
--  Idempotente (valores absolutos): re-correrlo no acumula.
--  Pegar en Supabase → SQL Editor → Run.
-- =====================================================================

begin;
${body}
commit;

-- Control:  select price, count(*) from public.fantasy_players group by price order by price;
`;

writeFileSync(new URL("../supabase/migracion-fantasy-reprice.sql", import.meta.url), sql);
console.log(`OK · ${rows.length} jugadores (35 equipos) · ${byNew.size} valores de precio → supabase/migracion-fantasy-reprice.sql`);
