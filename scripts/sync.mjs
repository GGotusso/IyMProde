// =====================================================================
//  Sincronizador de partidos/resultados del Mundial 2026
// ---------------------------------------------------------------------
//  Lo corre GitHub Actions 1 vez por día (y se puede correr a mano).
//  - Pide el fixture + resultados a una API de fútbol (football-data.org).
//  - Hace UPSERT en la tabla `matches` de Supabase (vía service_role key,
//    que saltea RLS). Esto trae equipos, fechas, resolución de llaves de
//    eliminatoria y marcadores finales — todo automático.
//
//  ¿Por qué API y no "scrapear" HTML? Una API es estable, legal y
//  devuelve datos limpios. Scrapear webs se rompe cuando cambian el HTML
//  y suele violar los términos de uso.
//
//  Variables de entorno necesarias (las pone GitHub Actions desde Secrets):
//    SUPABASE_URL                -> https://xxxx.supabase.co
//    SUPABASE_SERVICE_ROLE_KEY   -> Settings > API > service_role (SECRETA)
//    FOOTBALL_DATA_TOKEN         -> token gratis de football-data.org
//    ODDS_API_KEY (opcional)     -> the-odds-api.com (cuotas 1X2). Sin esto,
//                                   el sync corre igual pero sin cuotas.
//    SEASON (opcional)           -> 2026 por defecto
//
//  Uso:  node scripts/sync.mjs
// =====================================================================

// Carga .env si existe (solo para correr localmente; en Actions usa Secrets).
import { readFileSync, existsSync } from "node:fs";
for (const envPath of [".env", new URL("../.env", import.meta.url).pathname]) {
  try {
    if (!existsSync(envPath)) continue;
    for (const line of readFileSync(envPath, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
    break;
  } catch { /* ignorar */ }
}

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const FD_TOKEN = process.env.FOOTBALL_DATA_TOKEN;
const SEASON = process.env.SEASON || "2026";
const COMPETITION = process.env.COMPETITION || "WC"; // World Cup
const ODDS_API_KEY = process.env.ODDS_API_KEY; // the-odds-api.com (opcional)

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("Faltan SUPABASE_URL y/o SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}
if (!FD_TOKEN) {
  console.error("Falta FOOTBALL_DATA_TOKEN (token gratis de football-data.org)");
  process.exit(1);
}

// --- mapeo de etapas de la API -> nuestras etapas ---
const STAGE_MAP = {
  GROUP_STAGE: "group",
  LAST_32: "R32", ROUND_OF_32: "R32",
  LAST_16: "R16", ROUND_OF_16: "R16",
  QUARTER_FINALS: "QF", QUARTER_FINAL: "QF",
  SEMI_FINALS: "SF", SEMI_FINAL: "SF",
  THIRD_PLACE: "TP", THIRD_PLACE_FINAL: "TP", PLAY_OFF_FOR_THIRD_PLACE: "TP",
  FINAL: "FINAL",
};
const STAGE_SORT = { group: 0, R32: 1, R16: 2, QF: 3, SF: 4, TP: 5, FINAL: 6 };

async function fdGet(path) {
  const url = `https://api.football-data.org/v4/competitions/${COMPETITION}/${path}`;
  const res = await fetch(url, { headers: { "X-Auth-Token": FD_TOKEN } });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`football-data.org /${path} ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

async function fetchMatches() {
  const json = await fdGet(`matches?season=${SEASON}`);
  return json.matches || [];
}

function mapMatch(m) {
  const stage = STAGE_MAP[m.stage] || (m.group ? "group" : "FINAL");
  const groupName = m.group ? String(m.group).replace(/^GROUP_?/i, "") : null;
  const finished = m.status === "FINISHED" || m.status === "AWARDED";
  const ft = m.score?.fullTime || {};
  // Cuotas: solo si vienen como números (en planes sin odds llega un mensaje).
  const o = m.odds || {};
  const num = (v) => (typeof v === "number" && isFinite(v) ? v : null);
  return {
    id: `api-${m.id}`,
    stage,
    group_name: stage === "group" ? groupName : null,
    matchday: m.matchday ?? null,
    home_team: m.homeTeam?.name || m.homeTeam?.shortName || "Por definir",
    away_team: m.awayTeam?.name || m.awayTeam?.shortName || "Por definir",
    kickoff: m.utcDate,
    home_goals: finished ? (ft.home ?? null) : null,
    away_goals: finished ? (ft.away ?? null) : null,
    odds_home: num(o.homeWin),
    odds_draw: num(o.draw),
    odds_away: num(o.awayWin),
    odds_best: null,
    home_crest: m.homeTeam?.crest || null,
    away_crest: m.awayTeam?.crest || null,
    source: "api",
    sort_order:
      (STAGE_SORT[stage] ?? 9) * 10000 + (m.matchday ?? 0) * 100 + (m.id % 100),
  };
}

// =====================================================================
//  CUOTAS 1X2  (The Odds API)  — best-effort, no rompe el sync si falla.
// ---------------------------------------------------------------------
//  Pide las cuotas del Mundial a the-odds-api.com (agrega varias casas),
//  promedia el precio decimal de cada casa y lo matchea a nuestros
//  partidos por pareja de equipos + fecha. La key 'soccer_fifa_world_cup'
//  cubre los partidos del torneo.
// =====================================================================

// Normaliza un nombre de equipo para poder comparar entre las dos APIs
// (saca acentos/puntuación y unifica alias típicos).
const TEAM_ALIAS = {
  "usa": "united states",
  "united states of america": "united states",
  "south korea": "korea republic",
  "republic of korea": "korea republic",
  "ir iran": "iran",
  "ivory coast": "cote divoire",
  "cote d ivoire": "cote divoire",
  "czech republic": "czechia",
  "bosnia and herzegovina": "bosnia herzegovina",
  "cape verde": "cabo verde",
  "turkiye": "turkey",
  "congo dr": "dr congo",
  "korea dpr": "north korea",
};
function normTeam(name) {
  const s = String(name || "")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  return TEAM_ALIAS[s] || s;
}

// Analiza las cuotas 1X2 de todas las casas de un evento de The Odds API.
// Devuelve, por resultado (home/draw/away): el PROMEDIO de todas las casas
// y la MEJOR casa (la que paga más) con su nombre y precio. También los
// nombres normalizados de local/visitante del evento, para alinear después.
function consensusOdds(event) {
  const sums = {}, counts = {}, best = {};
  const add = (k, price, book) => {
    if (typeof price === "number" && isFinite(price) && price > 1) {
      sums[k] = (sums[k] || 0) + price; counts[k] = (counts[k] || 0) + 1;
      if (!best[k] || price > best[k].price) best[k] = { book, price };
    }
  };
  const nh = normTeam(event.home_team), na = normTeam(event.away_team);
  for (const bk of event.bookmakers || []) {
    const mkt = (bk.markets || []).find((m) => m.key === "h2h");
    if (!mkt) continue;
    const book = bk.title || bk.key;
    for (const oc of mkt.outcomes || []) {
      const n = normTeam(oc.name);
      if (n === nh) add("home", oc.price, book);
      else if (n === na) add("away", oc.price, book);
      else if (n === "draw" || n === "empate") add("draw", oc.price, book);
    }
  }
  const avg = (k) => (counts[k] ? Math.round((sums[k] / counts[k]) * 100) / 100 : null);
  return {
    nh, na,
    home: avg("home"), draw: avg("draw"), away: avg("away"),
    best: { home: best.home || null, draw: best.draw || null, away: best.away || null },
  };
}

async function fetchOdds() {
  const url = `https://api.the-odds-api.com/v4/sports/soccer_fifa_world_cup/odds/` +
    `?regions=eu&markets=h2h&oddsFormat=decimal&apiKey=${ODDS_API_KEY}`;
  const res = await fetch(url);
  const remaining = res.headers.get("x-requests-remaining");
  if (!res.ok) {
    throw new Error(`the-odds-api ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const events = await res.json();
  console.log(`[sync] Odds: ${events.length} eventos (cuota API restante: ${remaining ?? "?"}).`);
  return events;
}

// Decide si pedir cuotas en esta corrida, según cuán cerca está el próximo
// partido sin jugar y la hora UTC actual (cadencia adaptativa). Stateless:
// no necesita guardar nada entre corridas; el cron horario hace el resto.
// Correr a mano (workflow_dispatch) o local siempre pide.
function oddsFetchDecision(rows) {
  if (!process.env.GITHUB_ACTIONS || process.env.GITHUB_EVENT_NAME === "workflow_dispatch") {
    return { fetch: true, reason: "corrida manual/local" };
  }
  const now = Date.now();
  const upcoming = rows
    .filter((r) => r.home_goals == null && r.kickoff && Date.parse(r.kickoff) > now)
    .map((r) => (Date.parse(r.kickoff) - now) / 3600000); // horas hasta el KO
  if (!upcoming.length) return { fetch: false, reason: "no hay partidos próximos" };
  const hToNext = Math.min(...upcoming);
  const hour = new Date().getUTCHours();
  let stride, band;
  if (hToNext <= 3)  { stride = 1;  band = "≤3 h"; }
  else if (hToNext <= 24) { stride = 3;  band = "≤24 h"; }
  else if (hToNext <= 72) { stride = 12; band = "≤72 h"; }
  else return { fetch: false, reason: `próximo partido en ${hToNext.toFixed(0)} h (>72 h)` };
  const fetch = hour % stride === 0;
  return { fetch, reason: `próximo partido en ${hToNext.toFixed(1)} h (banda ${band}, cada ${stride} h)` };
}

// Mete las cuotas promedio en las filas correspondientes (mutación in-place).
function mergeOdds(rows, events) {
  const key = (a, b, d) => [normTeam(a), normTeam(b)].sort().join("|") + "|" + d;
  const idx = new Map();
  for (const r of rows) idx.set(key(r.home_team, r.away_team, (r.kickoff || "").slice(0, 10)), r);

  let matched = 0;
  for (const ev of events) {
    const c = consensusOdds(ev);
    if (c.home == null && c.draw == null && c.away == null) continue;
    const d0 = (ev.commence_time || "").slice(0, 10);
    let r = idx.get(key(ev.home_team, ev.away_team, d0));
    // Tolerancia de ±1 día por diferencias de huso horario en la fecha.
    if (!r) for (const off of [-1, 1]) {
      const d = new Date(Date.parse(ev.commence_time) + off * 86400000).toISOString().slice(0, 10);
      r = idx.get(key(ev.home_team, ev.away_team, d));
      if (r) break;
    }
    if (!r) continue;
    // Alinear local/visitante: si nuestro local coincide con el del evento, directo; si no, invertido.
    const flip = normTeam(r.home_team) !== c.nh;
    r.odds_home = flip ? c.away : c.home;
    r.odds_draw = c.draw;
    r.odds_away = flip ? c.home : c.away;
    r.odds_best = {
      home: flip ? c.best.away : c.best.home,
      draw: c.best.draw,
      away: flip ? c.best.home : c.best.away,
    };
    matched++;
  }
  return matched;
}

async function upsert(rows) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/matches?on_conflict=id`,
    {
      method: "POST",
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify(rows),
    }
  );
  if (!res.ok) throw new Error(`Supabase upsert ${res.status}: ${await res.text()}`);
}

// Guarda un dato en la caché (meta_cache) como JSON.
async function setCache(key, data) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/meta_cache?on_conflict=key`,
    {
      method: "POST",
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify({ key, data, updated_at: new Date().toISOString() }),
    }
  );
  if (!res.ok) throw new Error(`Supabase cache ${res.status}: ${await res.text()}`);
}

// Trae posiciones y goleadores (best-effort: si fallan, no rompe el sync).
async function syncExtras() {
  try {
    const standings = await fdGet(`standings?season=${SEASON}`);
    await setCache("standings", standings.standings || []);
    console.log(`[sync] Posiciones guardadas (${(standings.standings || []).length} grupos).`);
  } catch (e) {
    console.warn("[sync] Posiciones no disponibles:", e.message);
  }
  try {
    const scorers = await fdGet(`scorers?season=${SEASON}&limit=20`);
    await setCache("scorers", scorers.scorers || []);
    console.log(`[sync] Goleadores guardados (${(scorers.scorers || []).length}).`);
  } catch (e) {
    console.warn("[sync] Goleadores no disponibles (puede ser plan):", e.message);
  }
}

// Borra las filas placeholder ('seed') una vez que ya hay datos reales de la API.
async function deleteSeedRows() {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/matches?source=eq.seed`,
    {
      method: "DELETE",
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        Prefer: "return=minimal",
      },
    }
  );
  if (!res.ok) throw new Error(`Supabase delete seed ${res.status}: ${await res.text()}`);
}

async function main() {
  console.log(`[sync] Pidiendo fixture ${COMPETITION} temporada ${SEASON}…`);
  const apiMatches = await fetchMatches();
  console.log(`[sync] La API devolvió ${apiMatches.length} partidos.`);

  if (apiMatches.length === 0) {
    console.warn("[sync] Sin partidos. ¿Tu token incluye el Mundial? Nada que hacer.");
    return;
  }

  const rows = apiMatches.map(mapMatch);
  const finished = rows.filter((r) => r.home_goals != null).length;

  // Cuotas 1X2 (best-effort, no rompe el sync si falla). El cron corre cada
  // hora, pero las cuotas se piden con cadencia ADAPTATIVA para quedar lo más
  // "live" posible sin pasarnos de las 500 req/mes del plan gratis:
  //   • hay un partido en ≤ 3 h  -> cada hora        (las cuotas se mueven más cerca del KO)
  //   • hay un partido en ≤ 24 h -> cada 3 h
  //   • hay un partido en ≤ 72 h -> cada 12 h
  //   • no hay partidos próximos -> no se pide nada (ahorra cuota fuera de fechas)
  // En días pico del Mundial esto da ~12-15 llamadas/día → bien por debajo de 500/mes.
  if (ODDS_API_KEY) {
    const dec = oddsFetchDecision(rows);
    if (dec.fetch) {
      try {
        const matched = mergeOdds(rows, await fetchOdds());
        console.log(`[sync] Cuotas asignadas a ${matched} partidos. (${dec.reason})`);
      } catch (e) {
        console.warn("[sync] Cuotas no disponibles:", e.message);
      }
    } else {
      console.log(`[sync] Cuotas: salteado (${dec.reason}).`);
    }
  } else {
    console.log("[sync] Cuotas: ODDS_API_KEY no configurada, salteado.");
  }

  await upsert(rows);
  console.log(`[sync] Upsert OK: ${rows.length} partidos (${finished} finalizados).`);

  await deleteSeedRows();
  console.log(`[sync] Placeholders 'seed' eliminados.`);

  await syncExtras();
  console.log(`[sync] Listo ✅`);
}

main().catch((e) => {
  console.error("[sync] ERROR:", e.message);
  process.exit(1);
});
