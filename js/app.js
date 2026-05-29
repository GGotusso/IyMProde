// =====================================================================
//  Prode Mundial 2026 · lógica del frontend (sin framework, sin build)
// =====================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js";

const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ---------- estado de sesión (persistido en localStorage) ----------
const SESSION_KEY = "prode2026.session";
let session = loadSession();        // { player_id, name, token, is_admin }
let matches = [];                   // cache del fixture
let myPreds = new Map();            // match_id -> {home, away}
const dirty = new Map();            // cambios sin guardar

function loadSession() {
  try { return JSON.parse(localStorage.getItem(SESSION_KEY)); }
  catch { return null; }
}
function saveSession(s) {
  session = s;
  localStorage.setItem(SESSION_KEY, JSON.stringify(s));
}
function clearSession() {
  session = null;
  localStorage.removeItem(SESSION_KEY);
}

// ---------- helpers DOM ----------
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));
const el = (tag, props = {}, ...kids) => {
  const n = Object.assign(document.createElement(tag), props);
  for (const k of kids) n.append(k?.nodeType ? k : document.createTextNode(k ?? ""));
  return n;
};

const STAGE_LABELS = {
  group: "Fase de grupos", R32: "Dieciseisavos", R16: "Octavos",
  QF: "Cuartos", SF: "Semifinales", TP: "Tercer puesto", FINAL: "Final",
};
const STAGE_ORDER = ["group", "R32", "R16", "QF", "SF", "TP", "FINAL"];

const fmtDate = (iso) =>
  new Date(iso).toLocaleString("es-AR", {
    weekday: "short", day: "2-digit", month: "short",
    hour: "2-digit", minute: "2-digit",
  });
const fmtDay = (iso) =>
  new Date(iso).toLocaleString("es-AR", { day: "2-digit", month: "short" });

// Eliminatorias: los pronósticos se habilitan 2 días antes del partido
// (antes los equipos suelen estar "Por definir").
const KNOCKOUT_WINDOW_MS = 2 * 24 * 60 * 60 * 1000;
const started = (m) => new Date(m.kickoff) <= new Date();
const opensAt = (m) =>
  m.stage === "group" ? null : new Date(new Date(m.kickoff) - KNOCKOUT_WINDOW_MS);
const notYetOpen = (m) => m.stage !== "group" && Date.now() < new Date(m.kickoff) - KNOCKOUT_WINDOW_MS;
// Un partido se puede pronosticar si no empezó y (es de grupos o ya se habilitó).
const canPredict = (m) => !started(m) && !notYetOpen(m);

// <img> del escudo (o nada si no hay).
function crestImg(url) {
  if (!url) return document.createTextNode("");
  return el("img", { className: "crest", src: url, alt: "", loading: "lazy" });
}

// =====================================================================
//  ARRANQUE
// =====================================================================
init();

async function init() {
  bindLogin();
  bindNav();
  bindRankingTabs();
  $("#logout-btn").addEventListener("click", logout);
  $("#save-btn").addEventListener("click", savePredictions);

  if (SUPABASE_URL.includes("TU-PROYECTO")) {
    $("#conn-status").textContent =
      "⚠ Falta configurar Supabase en js/config.js";
  }

  if (session?.token) {
    await enterApp();
  } else {
    showLogin();
  }
}

// =====================================================================
//  LOGIN
// =====================================================================
function showLogin() {
  $("#topbar").classList.add("hidden");
  $$(".view").forEach((v) => v.classList.add("hidden"));
  $("#view-login").classList.remove("hidden");
}

function bindLogin() {
  $("#login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const code = $("#f-code").value.trim();
    const name = $("#f-name").value.trim();
    const pin = $("#f-pin").value.trim();
    const errBox = $("#login-error");
    errBox.classList.add("hidden");

    const { data, error } = await sb.rpc("join_group", {
      p_code: code, p_name: name, p_pin: pin,
    });
    if (error) {
      errBox.textContent = friendlyError(error.message);
      errBox.classList.remove("hidden");
      return;
    }
    const row = Array.isArray(data) ? data[0] : data;
    saveSession({
      player_id: row.player_id, name: row.name,
      token: row.token, is_admin: row.is_admin,
    });
    await enterApp();
  });
}

function friendlyError(msg = "") {
  if (msg.includes("CODIGO_INVALIDO")) return "Código de grupo incorrecto.";
  if (msg.includes("PIN_INCORRECTO")) return "Ese nombre ya existe y el PIN no coincide.";
  if (msg.includes("PIN_CORTO")) return "El PIN debe tener al menos 4 caracteres.";
  if (msg.includes("NOMBRE_CORTO")) return "El nombre es muy corto.";
  if (msg.includes("CREDENCIALES")) return "Nombre o PIN incorrectos.";
  if (msg.includes("SESION_INVALIDA")) return "Tu sesión expiró, volvé a entrar.";
  return "Error: " + msg;
}

function logout() {
  clearSession();
  showLogin();
}

// =====================================================================
//  ENTRAR A LA APP
// =====================================================================
async function enterApp() {
  $("#topbar").classList.remove("hidden");
  $("#user-name").textContent = "👋 " + session.name;
  $("#nav-admin").classList.toggle("hidden", !session.is_admin);

  await loadMatches();
  await loadMyPredictions();
  showView("predictions");
}

async function loadMatches() {
  const { data, error } = await sb
    .from("matches")
    .select("*")
    .order("sort_order", { ascending: true });
  if (error) { console.error(error); return; }
  matches = data || [];
  buildStageFilter();
}

async function loadMyPredictions() {
  myPreds.clear();
  const { data, error } = await sb.rpc("my_predictions", { p_token: session.token });
  if (error) {
    if (error.message.includes("SESION_INVALIDA")) { logout(); }
    return;
  }
  for (const p of data || []) {
    myPreds.set(p.match_id, { home: p.home_goals, away: p.away_goals });
  }
}

// =====================================================================
//  NAVEGACIÓN ENTRE VISTAS
// =====================================================================
function bindNav() {
  $$(".nav-btn").forEach((b) =>
    b.addEventListener("click", () => showView(b.dataset.view)));
}

function showView(view) {
  $$(".view").forEach((v) => v.classList.add("hidden"));
  $("#view-" + view).classList.remove("hidden");
  $$(".nav-btn").forEach((b) =>
    b.classList.toggle("active", b.dataset.view === view));

  if (view === "predictions") renderPredictions();
  if (view === "ranking") renderRanking();
  if (view === "mundial") renderMundial();
  if (view === "admin") renderAdmin();
}

// =====================================================================
//  PRONÓSTICOS
// =====================================================================
function buildStageFilter() {
  const sel = $("#stage-filter");
  sel.innerHTML = "";
  sel.append(el("option", { value: "all" }, "Todas las fases"));
  // grupos individuales
  const groups = [...new Set(matches.filter((m) => m.stage === "group")
    .map((m) => m.group_name))].filter(Boolean).sort();
  for (const g of groups) sel.append(el("option", { value: "group:" + g }, "Grupo " + g));
  // etapas de eliminatoria
  for (const st of STAGE_ORDER) {
    if (st === "group") continue;
    if (matches.some((m) => m.stage === st))
      sel.append(el("option", { value: st }, STAGE_LABELS[st]));
  }
  sel.onchange = renderPredictions;
}

function groupByStage(list) {
  const groups = {};
  for (const m of list) (groups[m.stage] ||= []).push(m);
  return groups;
}

// Renderiza la lista de partidos con títulos: la fase de grupos se separa por
// "Grupo A", "Grupo B", …; las eliminatorias por su etapa. rowFn arma cada fila.
function renderMatchSections(wrap, list, rowFn) {
  const byStage = groupByStage(list);
  for (const st of STAGE_ORDER) {
    if (!byStage[st]) continue;
    if (st === "group") {
      const groups = [...new Set(byStage.group.map((m) => m.group_name))]
        .filter(Boolean).sort();
      for (const g of groups) {
        wrap.append(el("div", { className: "stage-title" }, "Grupo " + g));
        for (const m of byStage.group.filter((x) => x.group_name === g)) wrap.append(rowFn(m));
      }
    } else {
      wrap.append(el("div", { className: "stage-title" }, STAGE_LABELS[st]));
      for (const m of byStage[st]) wrap.append(rowFn(m));
    }
  }
}

function renderPredictions() {
  const filter = $("#stage-filter").value;
  let list = matches;
  if (filter.startsWith("group:")) {
    const g = filter.slice(6);
    list = matches.filter((m) => m.stage === "group" && m.group_name === g);
  } else if (filter !== "all") {
    list = matches.filter((m) => m.stage === filter);
  }
  const wrap = $("#matches-list");
  wrap.innerHTML = "";
  dirty.clear();
  renderMatchSections(wrap, list, matchRow);
  updateStatus("");
}

function matchRow(m) {
  const editable = canPredict(m);
  const pred = myPreds.get(m.id);
  const played = m.home_goals != null && m.away_goals != null;

  const row = el("div", { className: "match" + (editable ? "" : " locked") });

  const homeInput = el("input", {
    type: "number", min: 0, max: 99, inputmode: "numeric",
    value: pred ? pred.home : "", disabled: !editable,
  });
  const awayInput = el("input", {
    type: "number", min: 0, max: 99, inputmode: "numeric",
    value: pred ? pred.away : "", disabled: !editable,
  });
  const onChange = () => {
    const h = homeInput.value === "" ? null : +homeInput.value;
    const a = awayInput.value === "" ? null : +awayInput.value;
    if (h != null && a != null) dirty.set(m.id, { home: h, away: a });
    else dirty.delete(m.id);
  };
  homeInput.addEventListener("input", onChange);
  awayInput.addEventListener("input", onChange);

  row.append(
    el("div", { className: "team home" },
      el("span", { className: "name" }, m.home_team), crestImg(m.home_crest)),
    el("div", { className: "score-box" },
      homeInput, el("span", { className: "sep" }, "–"), awayInput),
    el("div", { className: "team away" },
      crestImg(m.away_crest), el("span", { className: "name" }, m.away_team)),
  );

  const meta = el("div", { className: "match-meta" });
  meta.append(el("span", {}, fmtDate(m.kickoff)));
  const right = el("span", {});
  if (played) {
    const pts = pred ? points(pred, m) : 0;
    right.append(el("span", { className: "badge" }, `Final ${m.home_goals}-${m.away_goals}`));
    if (pred) right.append(" ", el("span", { className: "badge points" }, `+${pts}`));
  } else if (started(m)) {
    right.append(el("span", { className: "badge lock" }, "🔒 Cerrado"));
  } else if (notYetOpen(m)) {
    right.append(el("span", { className: "badge lock" }, "🔒 Se habilita " + fmtDay(opensAt(m))));
  }
  meta.append(right);
  row.append(meta);
  return row;
}

function points(pred, m) {
  if (m.home_goals == null) return 0;
  if (pred.home === m.home_goals && pred.away === m.away_goals) return 3;
  if (Math.sign(pred.home - pred.away) === Math.sign(m.home_goals - m.away_goals)) return 1;
  return 0;
}

async function savePredictions() {
  if (dirty.size === 0) { updateStatus("No hay cambios para guardar.", "ok"); return; }
  const items = [...dirty.entries()].map(([match_id, v]) => ({
    match_id, home: v.home, away: v.away,
  }));
  updateStatus("Guardando…");
  const { data, error } = await sb.rpc("save_predictions", {
    p_token: session.token, p_items: items,
  });
  if (error) {
    if (error.message.includes("SESION_INVALIDA")) return logout();
    updateStatus("Error al guardar: " + error.message, "err");
    return;
  }
  for (const [id, v] of dirty) myPreds.set(id, v);
  dirty.clear();
  updateStatus(`✅ Guardado (${data} partido${data === 1 ? "" : "s"}).`, "ok");
}

function updateStatus(text, kind) {
  const s = $("#pred-status");
  if (!text) { s.classList.add("hidden"); return; }
  s.textContent = text;
  s.className = "status" + (kind ? " " + kind : "");
  s.classList.remove("hidden");
}

// =====================================================================
//  RANKING
// =====================================================================
let rankMode = "final";

function bindRankingTabs() {
  $$(".tab").forEach((t) =>
    t.addEventListener("click", () => {
      $$(".tab").forEach((x) => x.classList.remove("active"));
      t.classList.add("active");
      rankMode = t.dataset.rank;
      $("#week-filter").classList.toggle("hidden", rankMode !== "weekly");
      renderRanking();
    }));
  $("#week-filter").addEventListener("change", renderRanking);
}

async function renderRanking() {
  const wrap = $("#ranking-table");
  wrap.innerHTML = `<div class="spinner">Cargando…</div>`;

  if (rankMode === "final") {
    const { data, error } = await sb
      .from("leaderboard").select("*").order("points", { ascending: false });
    if (error) { wrap.innerHTML = `<p class="error">${error.message}</p>`; return; }
    renderRankTable(wrap, data, ["Pos", "Jugador", "Exactos", "Puntos"],
      (r) => [r.exact_hits, r.points], r => r.player_id);
  } else {
    const { data, error } = await sb.from("leaderboard_weekly").select("*");
    if (error) { wrap.innerHTML = `<p class="error">${error.message}</p>`; return; }
    const weeks = [...new Set((data || []).map((r) => `${r.iso_year}-${r.iso_week}`))].sort();
    const sel = $("#week-filter");
    if (sel.options.length !== weeks.length) {
      sel.innerHTML = "";
      weeks.forEach((w, i) => {
        const [y, wk] = w.split("-");
        sel.append(el("option", { value: w }, `Semana ${i + 1} (sem. ${wk}/${y})`));
      });
      if (weeks.length) sel.value = weeks[weeks.length - 1];
    }
    const cur = sel.value || weeks[weeks.length - 1];
    const rows = (data || [])
      .filter((r) => `${r.iso_year}-${r.iso_week}` === cur)
      .sort((a, b) => b.points - a.points || b.exact_hits - a.exact_hits);
    if (!rows.length) { wrap.innerHTML = `<p class="muted">Todavía no hay puntos en esta semana.</p>`; return; }
    renderRankTable(wrap, rows, ["Pos", "Jugador", "Exactos", "Puntos"],
      (r) => [r.exact_hits, r.points], r => r.player_id);
  }
}

function renderRankTable(wrap, rows, headers, cols, idOf) {
  if (!rows?.length) { wrap.innerHTML = `<p class="muted">Sin datos todavía.</p>`; return; }
  const table = el("table", { className: "rank" });
  const thead = el("tr");
  headers.forEach((h, i) =>
    thead.append(el("th", i >= headers.length - 2 ? { style: "text-align:right" } : {}, h)));
  table.append(el("thead", {}, thead));
  const tbody = el("tbody");
  rows.forEach((r, i) => {
    const tr = el("tr", idOf(r) === session.player_id ? { className: "me" } : {});
    tr.append(el("td", { className: "pos" }, String(i + 1)));
    tr.append(el("td", {}, r.player_name));
    const [exact, pts] = cols(r);
    tr.append(el("td", { style: "text-align:right" }, String(exact)));
    tr.append(el("td", { className: "pts" }, String(pts)));
    tbody.append(tr);
  });
  table.append(tbody);
  wrap.innerHTML = "";
  wrap.append(table);
}

// =====================================================================
//  MUNDIAL · próximos partidos + cuotas + posiciones + goleadores
// =====================================================================
async function renderMundial() {
  renderUpcoming();
  const { data, error } = await sb
    .from("meta_cache").select("key,data,updated_at");
  const cache = {};
  let updatedAt = null;
  if (!error) for (const r of data || []) {
    cache[r.key] = r.data;
    if (!updatedAt || r.updated_at > updatedAt) updatedAt = r.updated_at;
  }
  renderStandings(cache.standings);
  renderScorers(cache.scorers);
  $("#meta-updated").textContent = updatedAt
    ? "Datos de la API actualizados: " + fmtDate(updatedAt)
    : "Los datos de la API aparecen tras la primera sincronización.";
}

function renderUpcoming() {
  const wrap = $("#upcoming-list");
  wrap.innerHTML = "";
  const now = new Date();
  const next = matches
    .filter((m) => new Date(m.kickoff) > now && m.home_goals == null)
    .sort((a, b) => new Date(a.kickoff) - new Date(b.kickoff))
    .slice(0, 8);
  if (!next.length) { wrap.innerHTML = `<p class="muted">No hay próximos partidos cargados.</p>`; return; }
  for (const m of next) {
    const row = el("div", { className: "match" });
    row.append(
      el("div", { className: "team home" },
        el("span", { className: "name" }, m.home_team), crestImg(m.home_crest)),
      el("div", { className: "score-box vs" }, "vs"),
      el("div", { className: "team away" },
        crestImg(m.away_crest), el("span", { className: "name" }, m.away_team)),
    );
    const meta = el("div", { className: "match-meta" });
    meta.append(el("span", {}, fmtDate(m.kickoff)));
    row.append(meta);
    wrap.append(row);
  }
}

function renderStandings(standings) {
  const wrap = $("#standings-list");
  wrap.innerHTML = "";
  const groups = (standings || []).filter((s) => s.type === "TOTAL" && s.table?.length);
  if (!groups.length) { wrap.innerHTML = `<p class="muted">Las posiciones aparecen cuando arranca el Mundial.</p>`; return; }
  for (const g of groups) {
    const card = el("div", { className: "standings-card" });
    const name = (g.group || "").replace(/_/g, " ");
    card.append(el("div", { className: "stage-title" }, name || "Tabla"));
    const table = el("table", { className: "rank" });
    table.append(el("thead", {}, rowOf("tr",
      th("#"), th("Equipo"), th("PJ", 1), th("DG", 1), th("Pts", 1))));
    const tbody = el("tbody");
    for (const t of g.table) {
      const teamCell = el("td", {});
      const inner = el("div", { className: "team-cell" });
      inner.append(crestImg(t.team?.crest), el("span", {}, t.team?.name || ""));
      teamCell.append(inner);
      tbody.append(rowOf("tr",
        el("td", { className: "pos" }, String(t.position)),
        teamCell,
        el("td", { style: "text-align:right" }, String(t.playedGames)),
        el("td", { style: "text-align:right" }, String(t.goalDifference)),
        el("td", { className: "pts" }, String(t.points)),
      ));
    }
    table.append(tbody);
    card.append(table);
    wrap.append(card);
  }
}

function renderScorers(scorers) {
  const wrap = $("#scorers-list");
  wrap.innerHTML = "";
  if (!scorers?.length) { wrap.innerHTML = `<p class="muted">Tabla de goleadores no disponible (puede depender del plan de la API).</p>`; return; }
  const table = el("table", { className: "rank" });
  table.append(el("thead", {}, rowOf("tr", th("#"), th("Jugador"), th("Equipo"), th("Goles", 1))));
  const tbody = el("tbody");
  scorers.forEach((s, i) => {
    tbody.append(rowOf("tr",
      el("td", { className: "pos" }, String(i + 1)),
      el("td", {}, s.player?.name || ""),
      el("td", {}, s.team?.name || ""),
      el("td", { className: "pts" }, String(s.goals ?? 0)),
    ));
  });
  table.append(tbody);
  wrap.append(table);
}

// helpers de tabla
function th(label, right) { return el("th", right ? { style: "text-align:right" } : {}, label); }
function rowOf(tag, ...cells) { const r = el(tag); cells.forEach((c) => r.append(c)); return r; }

// =====================================================================
//  ADMIN · cargar resultados y resolver equipos
// =====================================================================
function renderAdmin() {
  if (!session.is_admin) { showView("predictions"); return; }
  const wrap = $("#admin-list");
  wrap.innerHTML = "";
  renderMatchSections(wrap, matches, adminRow);
}

function adminRow(m) {
  const row = el("div", { className: "match" });
  const editable = m.stage !== "group"; // permitir resolver llaves

  const homeName = el("input", { type: "text", value: m.home_team, disabled: !editable, style: "width:100%" });
  const awayName = el("input", { type: "text", value: m.away_team, disabled: !editable, style: "width:100%" });
  const hg = el("input", { type: "number", min: 0, max: 99, value: m.home_goals ?? "" });
  const ag = el("input", { type: "number", min: 0, max: 99, value: m.away_goals ?? "" });

  const saveBtn = el("button", { className: "primary", style: "padding:.45rem .7rem" }, "Guardar");
  saveBtn.addEventListener("click", async () => {
    saveBtn.textContent = "…";
    if (editable && (homeName.value !== m.home_team || awayName.value !== m.away_team)) {
      const { error } = await sb.rpc("set_teams", {
        p_token: session.token, p_match_id: m.id,
        p_home: homeName.value.trim(), p_away: awayName.value.trim(),
      });
      if (error) { alert(error.message); saveBtn.textContent = "Guardar"; return; }
      m.home_team = homeName.value.trim(); m.away_team = awayName.value.trim();
    }
    if (hg.value !== "" && ag.value !== "") {
      const { error } = await sb.rpc("set_result", {
        p_token: session.token, p_match_id: m.id,
        p_home: +hg.value, p_away: +ag.value,
      });
      if (error) { alert(error.message); saveBtn.textContent = "Guardar"; return; }
      m.home_goals = +hg.value; m.away_goals = +ag.value;
    }
    saveBtn.textContent = "✅";
    setTimeout(() => (saveBtn.textContent = "Guardar"), 1200);
  });

  row.append(
    el("div", { className: "team home", style: "flex:1" }, homeName),
    el("div", { className: "score-box" }, hg, el("span", { className: "sep" }, "–"), ag),
    el("div", { className: "team away", style: "flex:1" }, awayName),
  );
  const meta = el("div", { className: "match-meta" });
  meta.append(el("span", {}, `${m.id} · ${fmtDate(m.kickoff)}`), saveBtn);
  row.append(meta);
  return row;
}
