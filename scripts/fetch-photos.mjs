// Busca foto real de cada jugador de los 13 equipos nuevos en Wikipedia
// (Wikimedia Commons: gratis y hotlinkeable). Usa búsqueda con contexto de
// país para desambiguar homónimos (Luis Suárez Colombia vs Uruguay).
// Acepta solo imágenes de páginas cuyo título se parece al nombre buscado
// (evita fotos de personas equivocadas). Escribe scripts/data/fantasy-photos.json
// como mapa "Team|Name" -> url. Lo que no encuentra queda sin foto (cae a bandera).
import { writeFileSync } from "node:fs";
import { parseSquads } from "./parse-squads.mjs";

const TEAMS = ["Belgium", "Bosnia-Herzegovina", "Colombia", "Curaçao", "Czechia",
  "Egypt", "France", "Iran", "New Zealand", "Senegal", "Uruguay", "Uzbekistan", "United States"];

// País para el término de búsqueda (desambiguación).
const COUNTRY = {
  "Belgium": "Belgium", "Bosnia-Herzegovina": "Bosnia", "Colombia": "Colombia",
  "Curaçao": "Curacao", "Czechia": "Czech", "Egypt": "Egypt", "France": "France",
  "Iran": "Iran", "New Zealand": "New Zealand", "Senegal": "Senegal",
  "Uruguay": "Uruguay", "Uzbekistan": "Uzbekistan", "United States": "United States",
};

const norm = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "")
  .toLowerCase().replace(/[^a-z ]/g, " ").replace(/\s+/g, " ").trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ¿El título de la página se parece al nombre? Como la query ya filtra por país
// + "footballer", basta con que el apellido (último token) aparezca en el título.
function titleLooksRight(query, title) {
  const q = norm(query).split(" ");
  const t = new Set(norm(title).split(" "));
  return t.has(q[q.length - 1]);
}

async function apiGet(url, tries = 4) {
  for (let i = 0; i < tries; i++) {
    const r = await fetch(url, { headers: { "User-Agent": "ProdeMundial2026/1.0 (https://github.com/GGotusso/IyMProde)" } });
    const txt = await r.text();
    if (r.ok && txt.startsWith("{")) return JSON.parse(txt);
    await sleep(2000 * (i + 1)); // backoff ante "too many requests" / maxlag
  }
  return null;
}

async function findPhoto(name, country) {
  const q = `${name} ${country} footballer`;
  const u = "https://en.wikipedia.org/w/api.php?action=query&format=json&redirects=1&maxlag=5" +
    "&generator=search&gsrlimit=3&prop=pageimages&pithumbsize=200" +
    "&gsrsearch=" + encodeURIComponent(q);
  const j = await apiGet(u);
  if (!j) return null;
  const pages = Object.values(j?.query?.pages || {})
    .sort((a, b) => (a.index || 99) - (b.index || 99));
  for (const p of pages) {
    if (p.thumbnail?.source && titleLooksRight(name, p.title)) return p.thumbnail.source;
  }
  return null;
}

const squads = parseSquads();
const out = {};
let found = 0, total = 0;
for (const team of TEAMS) {
  for (const p of squads[team] || []) {
    total++;
    let url = null;
    try { url = await findPhoto(p.name, COUNTRY[team]); } catch { /* ignore */ }
    if (url) { out[`${team}|${p.name}`] = url; found++; }
    process.stdout.write(`\r${team.padEnd(20)} ${found}/${total}   `);
    await sleep(550);
  }
}
writeFileSync(new URL("./data/fantasy-photos.json", import.meta.url), JSON.stringify(out, null, 2));
console.log(`\nFotos encontradas: ${found}/${total} → scripts/data/fantasy-photos.json`);
