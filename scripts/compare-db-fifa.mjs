// Compara los jugadores actuales en la DB (fplayers_tmp.json) contra el squad
// oficial FIFA (SquadLists). Reporta, por equipo, los jugadores de la DB que
// NO aparecen en la lista FIFA (candidatos a eliminar: no van al Mundial).
//
// Matching tolerante (para NO marcar de más):
//  - normalización fuerte (acentos + ß/ø/å/æ/ð/þ/đ/ł/œ → ascii)
//  - comparación por TOKENS de apellido (la DB trae "Inicial. Apellido")
//  - distancia de edición ≤1 para tolerar transliteraciones (Rüdiger=Ruediger,
//    Nübel=Nuebel, Groß=Gross), solo en tokens largos (≥5) para evitar choques.
import { readFileSync } from "node:fs";
import { parseSquads } from "./parse-squads.mjs";

const db = JSON.parse(readFileSync(new URL("./data/db-players-snapshot.json", import.meta.url), "utf8"));
const fifa = parseSquads();

const SPECIAL = { "ß": "ss", "ø": "o", "å": "a", "æ": "ae", "ð": "d", "þ": "th", "đ": "d", "ł": "l", "œ": "oe", "ı": "i", "ø": "o", "ƒ": "f" };
const norm = (s) => String(s || "")
  .normalize("NFD").replace(/[̀-ͯ]/g, "")
  .toLowerCase()
  .replace(/[ßøåæðþđłœıƒ]/g, (c) => SPECIAL[c] || c)
  .replace(/[^a-z ]/g, " ").replace(/\s+/g, " ").trim();

const tokens = (s) => norm(s).split(" ").filter((t) => t.length >= 3);

function lev(a, b) {
  const m = a.length, n = b.length;
  if (Math.abs(m - n) > 1) return 2; // nos basta saber si ≤1
  const dp = Array.from({ length: m + 1 }, (_, i) => i);
  for (let j = 1; j <= n; j++) {
    let prev = dp[0]; dp[0] = j;
    for (let i = 1; i <= m; i++) {
      const tmp = dp[i];
      dp[i] = Math.min(dp[i] + 1, dp[i - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[m];
}

// Conjunto de tokens de apellido del squad FIFA (de todos los nombres).
function fifaTokens(players) {
  const set = new Set();
  for (const p of players) for (const t of tokens(p.name)) set.add(t);
  return set;
}

const byTeam = {};
for (const p of db) (byTeam[p.team] ||= []).push(p);

let total = 0;
const flagged = [];
for (const team of Object.keys(byTeam).sort()) {
  const squad = fifa[team];
  if (!squad) { console.log(`\n### ${team}: SIN squad FIFA (revisar) ###`); continue; }
  const fset = fifaTokens(squad);
  const flist = [...fset];
  const missing = [];
  for (const p of byTeam[team]) {
    const tks = tokens(p.name);
    const matched = tks.some((t) =>
      fset.has(t) || (t.length >= 5 && flist.some((f) => f.length >= 5 && lev(t, f) <= 1)));
    if (!matched) missing.push(p);
  }
  if (missing.length) {
    console.log(`\n### ${team} — ${missing.length} ###`);
    for (const p of missing) {
      console.log(`  - ${p.position.padEnd(4)} ${p.name}`);
      flagged.push({ team, name: p.name, position: p.position });
      total++;
    }
  }
}
console.log(`\n=== TOTAL candidatos a eliminar: ${total} ===`);
