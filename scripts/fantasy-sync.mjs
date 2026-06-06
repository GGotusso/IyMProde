// =====================================================================
//  SYNC del MINIGAME FANTASY  ·  fuente: API-Football (api-sports.io)
// ---------------------------------------------------------------------
//  Lo llama scripts/sync.mjs en cada corrida (best-effort: si algo falla,
//  no rompe el sync de partidos).
//
//  ⚠ COMPATIBLE CON EL PLAN FREE (100 req/día). El plan Free NO permite el
//  parámetro `season` para 2026 ("solo 2022–2024") ni `last`/`next`, y el
//  parámetro `date` solo admite hoy ±1 día. Por eso NO usamos `season`:
//
//   A) SIEMBRA del catálogo (incremental, sin `season`):
//      Para cada selección de la fase de grupos (nombre tomado de nuestra
//      tabla `matches`), busca el equipo con `teams?search=` y baja el
//      plantel con `players/squads?team=`. Precio desde
//      scripts/data/fantasy-prices.json. Siembra de a tandas (cap por
//      corrida) para no pasar el límite diario; se completa en pocas corridas.
//
//   B) FIXTURES + STATS (por fecha, sin `season`):
//      Pide `fixtures?date=<hoy ±1>` y filtra liga 1, mapea cada partido a
//      nuestro `matches` (por equipos+fecha) y guarda `apifootball_fixture_id`.
//      Para los FINALIZADOS sin stats, baja `fixtures/players?fixture=` (1
//      request c/u, una vez) y vuelca a `player_stats`.
//
//  Variable de entorno:  APIFOOTBALL_KEY  (si falta, se saltea todo).
// =====================================================================

import { readFileSync } from "node:fs";

const API_BASE = "https://v3.football.api-sports.io";
const WC_LEAGUE_ID = Number(process.env.APIFOOTBALL_LEAGUE || 1); // 1 = World Cup
const THROTTLE_MS = Number(process.env.APIFOOTBALL_THROTTLE_MS || 7000);
const MAX_SEED_TEAMS_PER_RUN = Number(process.env.APIFOOTBALL_SEED_CAP || 20);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- normalización para cruzar nombres entre las dos APIs ---
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
  "cape verde islands": "cabo verde",
  "turkiye": "turkey",
  "congo dr": "dr congo",
  "korea dpr": "north korea",
};
function norm(s) {
  return String(s || "")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}
function normTeam(name) {
  const s = norm(name);
  return TEAM_ALIAS[s] || s;
}
const POS_MAP = {
  Goalkeeper: "GK", Defender: "DEF", Midfielder: "MID", Attacker: "FWD",
};
const FINISHED = new Set(["FT", "AET", "PEN"]);
const ymd = (d) => new Date(d).toISOString().slice(0, 10);

let _calls = 0;
async function apiGet(path) {
  if (_calls++ > 0) await sleep(THROTTLE_MS); // throttle entre llamadas
  const res = await fetch(`${API_BASE}/${path}`, {
    headers: { "x-apisports-key": process.env.APIFOOTBALL_KEY },
  });
  const json = await res.json().catch(() => ({}));
  const remaining = res.headers.get("x-ratelimit-requests-remaining");
  // Los "errors" de plan/cuota vienen con 200 OK: los tratamos como fallo.
  if (!res.ok || (json.errors && Object.keys(json.errors).length)) {
    throw new Error(
      `API-Football /${path}: ${JSON.stringify(json.errors || json).slice(0, 200)}`
    );
  }
  if (remaining != null && Number(remaining) <= 5) {
    console.warn(`[fantasy] ⚠ cuota API-Football casi agotada (restan ${remaining}).`);
  }
  return json.response || [];
}

// --- helpers Supabase REST (service_role: saltea RLS) ---
function sbHeaders(env, extra = {}) {
  return {
    apikey: env.SERVICE_KEY,
    Authorization: `Bearer ${env.SERVICE_KEY}`,
    "Content-Type": "application/json",
    ...extra,
  };
}
async function sbGet(env, pathQuery) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${pathQuery}`, {
    headers: sbHeaders(env),
  });
  if (!res.ok) throw new Error(`Supabase GET ${pathQuery} ${res.status}: ${await res.text()}`);
  return res.json();
}
async function sbUpsert(env, table, rows, onConflict) {
  if (!rows.length) return;
  const res = await fetch(
    `${env.SUPABASE_URL}/rest/v1/${table}?on_conflict=${onConflict}`,
    {
      method: "POST",
      headers: sbHeaders(env, { Prefer: "resolution=merge-duplicates,return=minimal" }),
      body: JSON.stringify(rows),
    }
  );
  if (!res.ok) throw new Error(`Supabase upsert ${table} ${res.status}: ${await res.text()}`);
}

// =====================================================================
//  A) Siembra incremental del catálogo (sin `season`)
// =====================================================================
// API-Football devuelve nombres abreviados ("L. Messi", "K. Mbappé").
// Clave robusta = inicial del nombre + apellido, normalizada:
//   "Lionel Messi" -> "l messi"   ·   "L. Messi" -> "l messi"
function pkey(name) {
  const parts = norm(name).split(" ").filter(Boolean);
  if (parts.length < 2) return parts.join(" ");
  return parts[0][0] + " " + parts[parts.length - 1];
}
function loadPriceTable() {
  const path = new URL("./data/fantasy-prices.json", import.meta.url);
  const j = JSON.parse(readFileSync(path, "utf8"));
  const byFull = new Map();    // por nombre completo normalizado (por si viene completo)
  const byInitial = new Map(); // por inicial + apellido (caso normal de squads)
  for (const p of j.players || []) {
    byFull.set(norm(p.name), p.price);
    byInitial.set(pkey(p.name), p.price);
  }
  return { defaults: j.defaults || { GK: 4.5, DEF: 4.5, MID: 5, FWD: 5.5 }, byFull, byInitial };
}
function priceFor(prices, name, position) {
  return prices.byFull.get(norm(name))
    ?? prices.byInitial.get(pkey(name))
    ?? prices.defaults[position];
}

// Término de búsqueda por selección cuando el nombre no matchea directo.
const SEARCH_TERM = {
  "bosnia herzegovina": "bosnia",
  "czechia": "czech",
  "curacao": "curacao",
  "cote divoire": "ivory coast",
  "north korea": "korea",
  "dr congo": "congo",
};
// Busca el id de una selección por nombre (prioriza equipo NACIONAL).
async function findTeamId(name) {
  const target = normTeam(name);
  // El endpoint search solo admite alfanuméricos y espacios; además sacamos
  // acentos (ej. "Curaçao" -> "Curacao", "Bosnia-Herzegovina" -> "Bosnia").
  const q = (SEARCH_TERM[target] || name)
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9 ]/gi, " ").replace(/\s+/g, " ").trim();
  const res = await apiGet(`teams?search=${encodeURIComponent(q)}`);
  const first = target.split(" ")[0];
  return (
    res.find((r) => r.team.national && normTeam(r.team.name) === target) ||
    res.find((r) => r.team.national && (normTeam(r.team.name).includes(target) || target.includes(normTeam(r.team.name)))) ||
    res.find((r) => r.team.national && normTeam(r.team.name).startsWith(first)) ||
    res.find((r) => normTeam(r.team.name) === target)
  )?.team.id || null;
}

async function seedPlayers(env, matches) {
  // Selecciones objetivo = equipos reales de la fase de grupos.
  const targets = [...new Set(
    matches.filter((m) => m.stage === "group")
      .flatMap((m) => [m.home_team, m.away_team])
      .filter((t) => t && normTeam(t) !== "por definir")
  )];
  if (!targets.length) {
    console.log("[fantasy] Aún no hay equipos de grupos cargados; siembra pospuesta.");
    return;
  }

  // Las que ya sembramos (por nombre de equipo) se saltean.
  const seeded = new Set(
    (await sbGet(env, "fantasy_players?select=team")).map((r) => normTeam(r.team))
  );
  const todo = targets.filter((t) => !seeded.has(normTeam(t)));
  if (!todo.length) return; // catálogo completo

  const prices = loadPriceTable();
  const batch = todo.slice(0, MAX_SEED_TEAMS_PER_RUN);
  console.log(`[fantasy] Sembrando ${batch.length}/${todo.length} selección(es) pendientes…`);

  for (const teamName of batch) {
    try {
      const id = await findTeamId(teamName);
      if (!id) { console.warn(`[fantasy] No encontré la selección "${teamName}".`); continue; }
      const squad = await apiGet(`players/squads?team=${id}`);
      const players = squad?.[0]?.players || [];
      const rows = players.map((p) => {
        const position = POS_MAP[p.position] || "MID";
        return {
          api_player_id: p.id,
          name: p.name,
          team: teamName, // guardamos NUESTRO nombre (matchea con matches en el scoring)
          position,
          price: priceFor(prices, p.name, position),
          photo: p.photo || null,
        };
      });
      await sbUpsert(env, "fantasy_players", rows, "api_player_id");
      console.log(`[fantasy]   ${teamName}: ${rows.length} jugadores.`);
    } catch (e) {
      console.warn(`[fantasy] Plantel "${teamName}" no disponible:`, e.message);
    }
  }
  if (todo.length > batch.length) {
    console.log(`[fantasy] Quedan ${todo.length - batch.length} selección(es) para próximas corridas.`);
  }
}

// =====================================================================
//  B) Mapeo de fixtures + stats por fecha (sin `season`)
// =====================================================================
async function mapAndStats(env, matches) {
  // Índice de nuestros partidos por par de equipos + día.
  const key = (a, b, d) => [normTeam(a), normTeam(b)].sort().join("|") + "|" + d;
  const idx = new Map();
  for (const m of matches) idx.set(key(m.home_team, m.away_team, ymd(m.kickoff)), m);
  const findOurMatch = (home, away, dateIso) => {
    const base = ymd(dateIso);
    let m = idx.get(key(home, away, base));
    if (!m) for (const off of [-1, 1]) {
      m = idx.get(key(home, away, ymd(new Date(Date.parse(dateIso) + off * 86400000))));
      if (m) break;
    }
    return m;
  };

  // Partidos del Mundial en la ventana permitida por Free (hoy ±1).
  const now = Date.now();
  const dates = [-1, 0, 1].map((o) => ymd(new Date(now + o * 86400000)));
  const fixtures = [];
  const seen = new Set();
  for (const d of dates) {
    let day;
    try { day = await apiGet(`fixtures?date=${d}`); }
    catch (e) { console.warn(`[fantasy] fixtures?date=${d}:`, e.message); continue; }
    for (const f of day) {
      if (f.league?.id === WC_LEAGUE_ID && !seen.has(f.fixture.id)) {
        seen.add(f.fixture.id); fixtures.push(f);
      }
    }
  }
  if (!fixtures.length) { console.log("[fantasy] Sin partidos del Mundial en la ventana de fechas."); return; }

  const matchUpdates = [];
  let statsDone = 0;
  for (const f of fixtures) {
    const our = findOurMatch(f.teams.home.name, f.teams.away.name, f.fixture.date);
    if (!our) continue; // todavía no está en nuestra tabla (p.ej. llave sin definir)

    if (!our.apifootball_fixture_id) {
      our.apifootball_fixture_id = String(f.fixture.id);
      matchUpdates.push({ id: our.id, apifootball_fixture_id: String(f.fixture.id) });
    }

    const finished = FINISHED.has(f.fixture.status?.short);
    if (finished && !our.stats_fetched) {
      try {
        const blocks = await apiGet(`fixtures/players?fixture=${f.fixture.id}`);
        const rows = [];
        for (const block of blocks) {
          const isHome = block.team?.id === f.teams.home.id;
          const conceded = isHome ? (f.goals.away ?? 0) : (f.goals.home ?? 0);
          for (const pl of block.players || []) {
            const st = pl.statistics?.[0] || {};
            const g = st.goals || {}, c = st.cards || {}, pen = st.penalty || {}, ga = st.games || {};
            rows.push({
              match_id: our.id,
              api_player_id: pl.player?.id,
              minutes: ga.minutes || 0,
              goals: g.total || 0,
              assists: g.assists || 0,
              yellow: c.yellow || 0,
              red: c.red || 0,
              pen_missed: pen.missed || 0,
              pen_saved: pen.saved || 0,
              own_goals: 0, // API-Football no expone autogoles por jugador acá
              conceded: conceded ?? 0,
            });
          }
        }
        await sbUpsert(env, "player_stats", rows, "match_id,api_player_id");
        await sbUpsert(env, "matches", [{ id: our.id, stats_fetched: true }], "id");
        statsDone++;
        console.log(`[fantasy]   stats ${our.id}: ${rows.length} jugadores.`);
      } catch (e) {
        console.warn(`[fantasy] stats fixture ${f.fixture.id} (${our.id}):`, e.message);
      }
    }
  }
  await sbUpsert(env, "matches", matchUpdates, "id");
  console.log(`[fantasy] Fixtures mapeados: ${matchUpdates.length} · stats nuevas: ${statsDone}.`);
}

// =====================================================================
//  Orquestador (lo llama sync.mjs). Best-effort.
// =====================================================================
export async function syncFantasy(env) {
  if (!process.env.APIFOOTBALL_KEY) {
    console.log("[fantasy] APIFOOTBALL_KEY no configurada, salteado.");
    return;
  }
  try {
    const matches = await sbGet(
      env,
      "matches?select=id,stage,home_team,away_team,kickoff,home_goals,away_goals," +
        "apifootball_fixture_id,stats_fetched"
    );
    await seedPlayers(env, matches);
    await mapAndStats(env, matches);
    console.log("[fantasy] Listo ✅");
  } catch (e) {
    console.warn("[fantasy] No se pudo sincronizar el fantasy:", e.message);
  }
}
