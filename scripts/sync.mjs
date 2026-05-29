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
    home_crest: m.homeTeam?.crest || null,
    away_crest: m.awayTeam?.crest || null,
    source: "api",
    sort_order:
      (STAGE_SORT[stage] ?? 9) * 10000 + (m.matchday ?? 0) * 100 + (m.id % 100),
  };
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
