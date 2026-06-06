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

// Notificación flotante (no se va con el scroll). kind: "ok" | "err" | undefined.
function toast(text, kind) {
  const box = $("#toasts");
  if (!box) return;
  const t = el("div", { className: "toast" + (kind ? " " + kind : "") }, text);
  box.append(t);
  setTimeout(() => {
    t.style.transition = "opacity .3s";
    t.style.opacity = "0";
    setTimeout(() => t.remove(), 320);
  }, kind === "err" ? 4500 : 2800);
}

// Muestra/oculta la barra flotante de guardado según los cambios pendientes.
function refreshSaveBar() {
  const bar = $("#save-bar");
  if (!bar) return;
  const onPredictions = !$("#view-predictions").classList.contains("hidden");
  const n = dirty.size;
  if (onPredictions && n > 0) {
    $("#save-bar-info").textContent =
      `${n} cambio${n === 1 ? "" : "s"} sin guardar`;
    bar.classList.remove("hidden");
  } else {
    bar.classList.add("hidden");
  }
}

const STAGE_LABELS = {
  group: "Fase de grupos", R32: "Dieciseisavos", R16: "Octavos",
  QF: "Cuartos", SF: "Semifinales", TP: "Tercer puesto", FINAL: "Final",
};
const STAGE_ORDER = ["group", "R32", "R16", "QF", "SF", "TP", "FINAL"];

// Todos los horarios se muestran en hora de Argentina (UTC-3), sin importar
// la zona del dispositivo. La API entrega las fechas en UTC.
const AR_TZ = "America/Argentina/Buenos_Aires";
const fmtDate = (iso) =>
  new Date(iso).toLocaleString("es-AR", {
    weekday: "short", day: "2-digit", month: "short",
    hour: "2-digit", minute: "2-digit", timeZone: AR_TZ,
  }) + " hs";
const fmtDay = (iso) =>
  new Date(iso).toLocaleString("es-AR", { day: "2-digit", month: "short", timeZone: AR_TZ });

// Eliminatorias: los pronósticos se habilitan 2 días antes del partido
// (antes los equipos suelen estar "Por definir").
const KNOCKOUT_WINDOW_MS = 2 * 24 * 60 * 60 * 1000;
const started = (m) => new Date(m.kickoff) <= new Date();
const opensAt = (m) =>
  m.stage === "group" ? null : new Date(new Date(m.kickoff) - KNOCKOUT_WINDOW_MS);
const notYetOpen = (m) => m.stage !== "group" && Date.now() < new Date(m.kickoff) - KNOCKOUT_WINDOW_MS;
// Un partido se puede pronosticar si no empezó y (es de grupos o ya se habilitó).
const canPredict = (m) => !started(m) && !notYetOpen(m);

// Nombres de selección en español (el valor interno sigue siendo el de la API).
const TEAM_ES = {
  "Algeria": "Argelia", "Argentina": "Argentina", "Australia": "Australia",
  "Austria": "Austria", "Belgium": "Bélgica", "Bosnia-Herzegovina": "Bosnia y Herzegovina",
  "Brazil": "Brasil", "Canada": "Canadá", "Cape Verde Islands": "Cabo Verde",
  "Colombia": "Colombia", "Congo DR": "RD del Congo", "Croatia": "Croacia",
  "Curaçao": "Curazao", "Czechia": "República Checa", "Ecuador": "Ecuador",
  "Egypt": "Egipto", "England": "Inglaterra", "France": "Francia",
  "Germany": "Alemania", "Ghana": "Ghana", "Haiti": "Haití", "Iran": "Irán",
  "Iraq": "Irak", "Ivory Coast": "Costa de Marfil", "Japan": "Japón",
  "Jordan": "Jordania", "Mexico": "México", "Morocco": "Marruecos",
  "Netherlands": "Países Bajos", "New Zealand": "Nueva Zelanda", "Norway": "Noruega",
  "Panama": "Panamá", "Paraguay": "Paraguay", "Portugal": "Portugal", "Qatar": "Catar",
  "Saudi Arabia": "Arabia Saudita", "Scotland": "Escocia", "Senegal": "Senegal",
  "South Africa": "Sudáfrica", "South Korea": "Corea del Sur", "Spain": "España",
  "Sweden": "Suecia", "Switzerland": "Suiza", "Tunisia": "Túnez", "Turkey": "Turquía",
  "United States": "Estados Unidos", "Uruguay": "Uruguay", "Uzbekistan": "Uzbekistán",
  "Por definir": "Por definir",
};
const T = (name) => TEAM_ES[name] || name;

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
  bindRankTabs();
  bindAdminTabs();
  bindFantasy();
  $("#logout-btn").addEventListener("click", logout);
  $("#save-btn").addEventListener("click", savePredictions);
  $("#save-bar-btn").addEventListener("click", savePredictions);
  $("#save-special-btn").addEventListener("click", saveSpecials);
  $("#pending-only").addEventListener("change", renderPredictions);

  // Aviso al cerrar/recargar la pestaña con cambios sin guardar.
  window.addEventListener("beforeunload", (e) => {
    if (dirty.size > 0) { e.preventDefault(); e.returnValue = ""; }
  });

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
  document.body.classList.remove("in-app");
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
  document.body.classList.add("in-app");
  $("#topbar").classList.remove("hidden");
  $("#user-name").textContent = "👋 " + session.name;
  $("#nav-admin").classList.toggle("hidden", !session.is_admin);

  await loadMatches();
  await loadMyPredictions();
  updatePendingBadge();
  showView("predictions");
}

// Cuenta partidos próximos (cierran dentro de 7 días) que todavía no pronosticaste,
// y lo muestra como globo rojo en el nav de "Mis pronósticos".
const PENDING_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
function updatePendingBadge() {
  const now = Date.now();
  const n = matches.filter((m) =>
    canPredict(m) && !myPreds.has(m.id) &&
    new Date(m.kickoff) - now <= PENDING_WINDOW_MS).length;
  const b = $("#pending-badge");
  if (n > 0) {
    b.textContent = String(n);
    b.title = `${n} partido${n === 1 ? "" : "s"} próximo${n === 1 ? "" : "s"} sin pronosticar`;
    b.classList.remove("hidden");
  } else {
    b.classList.add("hidden");
  }
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
// A qué sección pertenece cada vista (Prode = pronósticos/ranking del Mundial,
// Fantasy = plantel propio). El sub-nav muestra solo las vistas de la sección activa.
const VIEW_SECTION = {
  predictions: "prode", ranking: "prode", especiales: "prode",
  mundial: "prode", reglas: "prode", admin: "prode",
  fantasy: "fantasy",
};
// Última vista de Prode visitada, para volver a ella al cambiar de sección.
let lastProdeView = "predictions";

function bindNav() {
  $$(".nav-btn").forEach((b) =>
    b.addEventListener("click", () => showView(b.dataset.view)));
  $$(".sec-btn").forEach((b) =>
    b.addEventListener("click", () => showSection(b.dataset.section)));
}

// Cambia entre secciones. Fantasy abre directo su vista (tiene sus propios tabs
// internos); Prode vuelve a la última vista que el usuario tenía abierta.
function showSection(section) {
  showView(section === "fantasy" ? "fantasy" : lastProdeView);
}

function showView(view) {
  // Si salimos de "Mis pronósticos" con cambios sin guardar, avisamos.
  const leavingPreds = !$("#view-predictions").classList.contains("hidden");
  if (leavingPreds && view !== "predictions" && dirty.size > 0) {
    if (!confirm(`Tenés ${dirty.size} pronóstico${dirty.size === 1 ? "" : "s"} sin guardar.\n¿Salir igual y descartarlos?`)) return;
    dirty.clear();
    refreshSaveBar();
  }

  // Lo mismo para el plantel de Fantasy.
  const leavingFantasy = !$("#view-fantasy").classList.contains("hidden");
  if (leavingFantasy && view !== "fantasy" && fantasyEntered && !fLocked && !fNotOpen
      && fantasySnap() !== fSavedSnap) {
    if (!confirm("Tenés cambios sin guardar en tu plantel de Fantasy.\n¿Salir igual y descartarlos?")) return;
  }

  $$(".view").forEach((v) => v.classList.add("hidden"));
  $("#view-" + view).classList.remove("hidden");
  $$(".nav-btn").forEach((b) =>
    b.classList.toggle("active", b.dataset.view === view));

  // Sincroniza el selector de sección y muestra solo el sub-nav de esa sección.
  const section = VIEW_SECTION[view] || "prode";
  if (section === "prode") lastProdeView = view;
  document.body.classList.toggle("sec-fantasy", section === "fantasy");
  $$(".sec-btn").forEach((b) =>
    b.classList.toggle("active", b.dataset.section === section));
  $$(".nav-btn").forEach((b) =>
    b.classList.toggle("sec-hide", (VIEW_SECTION[b.dataset.view] || "prode") !== section));
  if (view !== "predictions") $("#save-bar").classList.add("hidden");
  if (view !== "fantasy") $("#fantasy-save-bar")?.classList.add("hidden");

  if (view === "predictions") renderPredictions();
  if (view === "ranking") renderRanking();
  if (view === "especiales") renderEspeciales();
  if (view === "fantasy") renderFantasy();
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
  if ($("#pending-only").checked) {
    list = list.filter((m) => canPredict(m) && !myPreds.has(m.id));
  }
  const wrap = $("#matches-list");
  wrap.innerHTML = "";
  dirty.clear();
  renderMatchSections(wrap, list, matchRow);
  if (!wrap.children.length) {
    wrap.innerHTML = `<p class="muted empty-state">${
      $("#pending-only").checked
        ? "¡No te queda ningún partido próximo sin cargar! 🎉"
        : "No hay partidos para mostrar todavía."
    }</p>`;
  }
  updateStatus("");
  refreshSaveBar();
}

function matchRow(m) {
  const editable = canPredict(m);
  const pred = myPreds.get(m.id);
  const played = m.home_goals != null && m.away_goals != null;

  // Estado visual del pronóstico (solo para partidos próximos editables).
  const liveState = editable && !played ? (pred ? " done" : " pending") : "";
  const row = el("div", { className: "match" + (editable ? "" : " locked") + liveState });

  const homeInput = el("input", {
    type: "number", min: 0, max: 99, inputmode: "numeric",
    value: pred ? pred.home : "", disabled: !editable,
  });
  const awayInput = el("input", {
    type: "number", min: 0, max: 99, inputmode: "numeric",
    value: pred ? pred.away : "", disabled: !editable,
  });
  // Chip de estado que se actualiza mientras el usuario escribe.
  const stateChip = el("span", { className: "pred-state" });
  const paintState = () => {
    if (played || !editable) return;
    if (dirty.has(m.id)) {
      row.className = "match done";
      stateChip.className = "pred-state unsaved";
      stateChip.textContent = "● Sin guardar";
    } else if (pred) {
      row.className = "match done";
      stateChip.className = "pred-state ok";
      stateChip.textContent = "✓ Cargado";
    } else {
      row.className = "match pending";
      stateChip.className = "pred-state todo";
      stateChip.textContent = "✏️ Falta cargar";
    }
  };
  const onChange = () => {
    const h = homeInput.value === "" ? null : +homeInput.value;
    const a = awayInput.value === "" ? null : +awayInput.value;
    if (h != null && a != null) dirty.set(m.id, { home: h, away: a });
    else dirty.delete(m.id);
    paintState();
    refreshSaveBar();
  };
  homeInput.addEventListener("input", onChange);
  awayInput.addEventListener("input", onChange);

  row.append(
    el("div", { className: "team home" },
      el("span", { className: "name" }, T(m.home_team)), crestImg(m.home_crest)),
    el("div", { className: "score-box" },
      homeInput, el("span", { className: "sep" }, "–"), awayInput),
    el("div", { className: "team away" },
      crestImg(m.away_crest), el("span", { className: "name" }, T(m.away_team))),
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
  } else {
    right.append(stateChip);
    paintState();
  }
  meta.append(right);
  row.append(meta);

  // Cuotas 1/X/2 al lado del partido que vas a pronosticar (si ya hay datos).
  if (!played && !started(m)) {
    const chips = oddsChips(m);
    if (chips) row.append(el("div", { className: "match-odds" }, chips));
  }

  // Una vez que el partido empezó, se puede ver qué pronosticó cada uno.
  if (started(m)) attachOthers(row, m);
  return row;
}

// Botón "Ver pronósticos de todos" + panel que se llena al abrirlo (lazy).
function attachOthers(row, m) {
  const toggle = el("button", { className: "others-toggle" }, "👥 Ver pronósticos de todos");
  const panel = el("div", { className: "others-panel hidden" });
  let loaded = false;
  toggle.addEventListener("click", async () => {
    const willShow = panel.classList.contains("hidden");
    panel.classList.toggle("hidden");
    toggle.textContent = willShow ? "👥 Ocultar pronósticos" : "👥 Ver pronósticos de todos";
    if (willShow && !loaded) {
      loaded = true;
      panel.innerHTML = `<div class="spinner small">Cargando…</div>`;
      const { data, error } = await sb.rpc("match_predictions", { p_match_id: m.id });
      if (error) {
        panel.innerHTML = "";
        panel.append(el("p", { className: "error small" }, error.message));
        loaded = false;
        return;
      }
      renderOthers(panel, data);
    }
  });
  row.append(el("div", { className: "others" }, toggle, panel));
}

function renderOthers(panel, rows) {
  panel.innerHTML = "";
  if (!rows?.length) {
    panel.append(el("p", { className: "muted small" }, "Nadie pronosticó este partido."));
    return;
  }
  const tbody = el("tbody");
  for (const r of rows) {
    const tr = el("tr", r.player_name === session.name ? { className: "me" } : {});
    tr.append(
      el("td", {}, r.player_name),
      el("td", { className: "op-score" }, `${r.home_goals}–${r.away_goals}`),
      el("td", { className: "op-pts" + (r.points > 0 ? " win" : "") }, `+${r.points}`),
    );
    tbody.append(tr);
  }
  panel.append(el("table", {}, tbody));
}

function points(pred, m) {
  if (m.home_goals == null) return 0;
  if (pred.home === m.home_goals && pred.away === m.away_goals) return 3;
  if (Math.sign(pred.home - pred.away) === Math.sign(m.home_goals - m.away_goals)) return 1;
  return 0;
}

async function savePredictions() {
  if (dirty.size === 0) { toast("No hay cambios para guardar.", "ok"); return; }
  const items = [...dirty.entries()].map(([match_id, v]) => ({
    match_id, home: v.home, away: v.away,
  }));
  const btns = [$("#save-btn"), $("#save-bar-btn")];
  btns.forEach((b) => (b.disabled = true));
  const { data, error } = await sb.rpc("save_predictions", {
    p_token: session.token, p_items: items,
  });
  btns.forEach((b) => (b.disabled = false));
  if (error) {
    if (error.message.includes("SESION_INVALIDA")) return logout();
    toast("No se pudo guardar: " + error.message, "err");
    return;
  }
  for (const [id, v] of dirty) myPreds.set(id, v);
  dirty.clear();
  updatePendingBadge();
  refreshSaveBar();
  renderPredictions();
  toast(`✅ Guardado (${data} partido${data === 1 ? "" : "s"}).`, "ok");
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
let rankMode = "general";   // "general" | "weekly" | "h2h"
let weeklyRows = [];        // cache de leaderboard_weekly de la última carga
let h2hPlayers = null;      // cache de jugadores para el selector de cara a cara

function bindRankTabs() {
  $$("#rank-tabs .tab").forEach((b) =>
    b.addEventListener("click", () => {
      rankMode = b.dataset.rank;
      $$("#rank-tabs .tab").forEach((x) => x.classList.toggle("active", x === b));
      $("#week-picker").classList.toggle("hidden", rankMode !== "weekly");
      $("#h2h-picker").classList.toggle("hidden", rankMode !== "h2h");
      renderRanking();
    }));
  $("#week-select").addEventListener("change", filterWeekly);
  $("#h2h-select").addEventListener("change", renderH2H);
}

function renderRanking() {
  if (rankMode === "weekly") return renderWeekly();
  if (rankMode === "h2h") return renderH2HTab();
  const wrap = $("#ranking-table");
  wrap.innerHTML = `<div class="spinner">Cargando…</div>`;
  $("#rank-foot").innerHTML =
    "<b>3</b> por marcador exacto · <b>1</b> por acertar el resultado · <b>0</b> si errás · más los puntos de los pronósticos especiales.";
  sb.from("leaderboard").select("*").order("points", { ascending: false })
    .then(({ data, error }) => {
      if (error) { wrap.innerHTML = `<p class="error">${error.message}</p>`; return; }
      renderRankTable(wrap, data, ["Pos", "Jugador", "Exactos", "Puntos"],
        (r) => [r.exact_hits, r.points], (r) => r.player_id);
    });
}

// Ranking de UNA fecha del torneo (vista leaderboard_weekly, por semana ISO).
async function renderWeekly() {
  const wrap = $("#ranking-table");
  wrap.innerHTML = `<div class="spinner">Cargando…</div>`;
  const { data, error } = await sb.from("leaderboard_weekly").select("*");
  if (error) { wrap.innerHTML = `<p class="error">${error.message}</p>`; return; }
  weeklyRows = data || [];
  buildWeekOptions();
  filterWeekly();
}

function filterWeekly() {
  const wrap = $("#ranking-table");
  const key = $("#week-select").value;
  $("#rank-foot").textContent = "Puntos ganados solo en esa fecha del torneo.";
  if (!key) { wrap.innerHTML = `<p class="muted">Todavía no hay fechas con puntos. ¡Esperá a que se jueguen partidos!</p>`; return; }
  const rows = weeklyRows
    .filter((r) => `${r.iso_year}-${r.iso_week}` === key)
    .sort((a, b) => b.points - a.points || b.exact_hits - a.exact_hits
      || a.player_name.localeCompare(b.player_name));
  if (!rows.length) { wrap.innerHTML = `<p class="muted">Sin puntos en esa fecha todavía.</p>`; return; }
  renderRankTable(wrap, rows, ["Pos", "Jugador", "Exactos", "Puntos"],
    (r) => [r.exact_hits, r.points], (r) => r.player_id);
}

// =====================================================================
//  CARA A CARA · vos vs. otro jugador, partido por partido
// =====================================================================
// Prepara el selector de jugadores (de la tabla general) y dispara la comparación.
async function renderH2HTab() {
  const sel = $("#h2h-select");
  const wrap = $("#ranking-table");
  $("#rank-foot").textContent = "Comparación partido por partido sobre los que ya se jugaron.";
  if (!h2hPlayers) {
    wrap.innerHTML = `<div class="spinner">Cargando…</div>`;
    const { data, error } = await sb.from("leaderboard").select("player_id,player_name");
    if (error) { wrap.innerHTML = `<p class="error">${error.message}</p>`; return; }
    h2hPlayers = (data || []).filter((p) => p.player_id !== session.player_id)
      .sort((a, b) => a.player_name.localeCompare(b.player_name));
    const prev = sel.value;
    sel.innerHTML = "";
    if (!h2hPlayers.length) {
      wrap.innerHTML = `<p class="muted empty-state">Todavía sos el único jugador del grupo. 😅<br>Cuando entren tus amigos vas a poder compararte con ellos.</p>`;
      return;
    }
    sel.append(el("option", { value: "" }, "— elegí un jugador —"));
    for (const p of h2hPlayers) sel.append(el("option", { value: p.player_id }, p.player_name));
    if (h2hPlayers.some((p) => p.player_id === prev)) sel.value = prev;
  }
  if (!h2hPlayers.length) return;
  renderH2H();
}

async function renderH2H() {
  const wrap = $("#ranking-table");
  const otherId = $("#h2h-select").value;
  if (!otherId) {
    wrap.innerHTML = `<p class="muted empty-state">Elegí un jugador arriba para ver el cara a cara.</p>`;
    return;
  }
  const otherName = h2hPlayers.find((p) => p.player_id === otherId)?.player_name || "rival";
  wrap.innerHTML = `<div class="spinner">Cargando…</div>`;
  const { data, error } = await sb.rpc("head_to_head", {
    p_token: session.token, p_other: otherId,
  });
  if (error) {
    if (error.message.includes("SESION_INVALIDA")) return logout();
    wrap.innerHTML = `<p class="error">${error.message}</p>`;
    return;
  }
  const rows = data || [];
  if (!rows.length) {
    wrap.innerHTML = `<p class="muted empty-state">Todavía no hay partidos jugados para comparar. ¡Volvé cuando ruede la pelota! ⚽</p>`;
    return;
  }

  // Totales y récord (ganados / empatados / perdidos por partido).
  let myTotal = 0, theirTotal = 0, w = 0, d = 0, l = 0;
  for (const r of rows) {
    const mp = r.my_points ?? 0, tp = r.their_points ?? 0;
    myTotal += mp; theirTotal += tp;
    if (mp > tp) w++; else if (mp < tp) l++; else d++;
  }

  wrap.innerHTML = "";
  // Encabezado tipo marcador
  const head = el("div", { className: "h2h-head" });
  const side = (name, pts, cls) => el("div", { className: "h2h-side " + cls },
    el("span", { className: "h2h-name" }, name),
    el("span", { className: "h2h-total" }, String(pts)));
  head.append(
    side("Vos", myTotal, myTotal >= theirTotal ? "lead" : ""),
    el("div", { className: "h2h-vs" }, "vs"),
    side(otherName, theirTotal, theirTotal > myTotal ? "lead" : ""),
  );
  wrap.append(head);
  wrap.append(el("p", { className: "h2h-record muted small" },
    `Le ganaste a ${otherName} en ${w}, empataron en ${d} y perdiste en ${l} de ${rows.length} partidos jugados.`));

  // Detalle partido por partido
  const list = el("div", { className: "h2h-list" });
  for (const r of rows) {
    const mp = r.my_points, tp = r.their_points;
    const card = el("div", { className: "h2h-row" });
    card.append(el("div", { className: "h2h-fixture" },
      el("span", {}, `${T(r.home_team)} ${r.home_goals}-${r.away_goals} ${T(r.away_team)}`)));
    const cell = (h, a, pts, winner) => {
      const c = el("div", { className: "h2h-cell" + (winner ? " win" : "") });
      c.append(el("span", { className: "h2h-pick" }, h != null ? `${h}-${a}` : "—"));
      c.append(el("span", { className: "h2h-pts" }, pts != null ? `+${pts}` : "·"));
      return c;
    };
    const meWin = (mp ?? -1) > (tp ?? -1), themWin = (tp ?? -1) > (mp ?? -1);
    card.append(el("div", { className: "h2h-cells" },
      cell(r.my_home, r.my_away, mp, meWin),
      cell(r.their_home, r.their_away, tp, themWin),
    ));
    list.append(card);
  }
  wrap.append(list);
}

function buildWeekOptions() {
  const sel = $("#week-select");
  const prev = sel.value;
  const keys = [...new Set(weeklyRows.map((r) => `${r.iso_year}-${r.iso_week}`))]
    .sort((a, b) => {
      const [ay, aw] = a.split("-").map(Number), [by, bw] = b.split("-").map(Number);
      return ay - by || aw - bw;
    });
  const labels = weekLabels();
  sel.innerHTML = "";
  keys.forEach((k, i) => sel.append(el("option", { value: k }, labels[k] || ("Fecha " + (i + 1)))));
  if (keys.includes(prev)) sel.value = prev;          // preserva la selección
  else if (keys.length) sel.value = keys[keys.length - 1]; // por defecto: la más reciente
}

// Semana ISO (año-semana) de una fecha, en UTC, para que coincida con la vista.
function isoWeekKey(d) {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7) + 3); // jueves de su semana
  const firstThu = date.getTime();
  const year = date.getUTCFullYear();
  date.setUTCMonth(0, 4);                                                // 4 de enero
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7) + 3);
  const week = 1 + Math.round((firstThu - date.getTime()) / (7 * 864e5));
  return `${year}-${week}`;
}

// Etiqueta amigable por semana ("11 jun – 16 jun"), a partir de los partidos.
function weekLabels() {
  const map = {};
  for (const m of matches) {
    const d = new Date(m.kickoff);
    const k = isoWeekKey(d);
    const cur = map[k] || (map[k] = { min: d, max: d });
    if (d < cur.min) cur.min = d;
    if (d > cur.max) cur.max = d;
  }
  const out = {};
  for (const k in map) out[k] = `${fmtDay(map[k].min)} – ${fmtDay(map[k].max)}`;
  return out;
}

const MEDALS = ["🥇", "🥈", "🥉"];

function renderRankTable(wrap, rows, headers, cols, idOf) {
  if (!rows?.length) { wrap.innerHTML = `<p class="muted">Sin datos todavía. ¡Cargá tus pronósticos!</p>`; return; }
  const table = el("table", { className: "rank" });
  const thead = el("tr");
  headers.forEach((h, i) =>
    thead.append(el("th", i >= headers.length - 2 ? { style: "text-align:right" } : {}, h)));
  table.append(el("thead", {}, thead));
  const tbody = el("tbody");
  rows.forEach((r, i) => {
    const tr = el("tr", idOf(r) === session.player_id ? { className: "me" } : {});
    tr.append(el("td", { className: "pos" }, i < 3 ? MEDALS[i] : String(i + 1)));
    const nameTd = el("td", { className: "rk-name" }, r.player_name);
    if (idOf(r) === session.player_id) nameTd.append(el("span", { className: "you" }, "vos"));
    tr.append(nameTd);
    const [exact, pts] = cols(r);
    tr.append(el("td", { style: "text-align:right" }, String(exact)));
    tr.append(el("td", { className: "pts" }, String(pts)));
    tbody.append(tr);
  });
  table.append(tbody);
  wrap.innerHTML = "";
  wrap.append(el("div", { className: "rank-card" }, table));
}

// =====================================================================
//  MUNDIAL · próximos partidos + cuotas + posiciones + goleadores
// =====================================================================
async function renderMundial() {
  renderUpcoming();
  renderStandings();                       // calculadas por grupo desde matches
  const { data, error } = await sb
    .from("meta_cache").select("key,data,updated_at");
  const cache = {};
  let updatedAt = null;
  if (!error) for (const r of data || []) {
    cache[r.key] = r.data;
    if (!updatedAt || r.updated_at > updatedAt) updatedAt = r.updated_at;
  }
  renderScorers(cache.scorers);
  $("#meta-updated").textContent = updatedAt
    ? "Datos actualizados: " + fmtDate(updatedAt)
    : "Los datos de la API aparecen tras la primera sincronización.";
}

// Mapa equipo -> escudo, a partir de los partidos.
function crestMap() {
  const map = {};
  for (const m of matches) {
    if (m.home_crest) map[m.home_team] = m.home_crest;
    if (m.away_crest) map[m.away_team] = m.away_crest;
  }
  return map;
}

// Calcula las tablas de posiciones por grupo (A..L) desde los resultados.
function computeStandings() {
  const groups = {};
  for (const m of matches.filter((x) => x.stage === "group")) {
    const g = m.group_name;
    (groups[g] ||= {});
    for (const t of [m.home_team, m.away_team]) {
      groups[g][t] ||= { team: t, pj: 0, gf: 0, ga: 0, pts: 0 };
    }
    if (m.home_goals != null && m.away_goals != null) {
      const H = groups[g][m.home_team], A = groups[g][m.away_team];
      H.pj++; A.pj++;
      H.gf += m.home_goals; H.ga += m.away_goals;
      A.gf += m.away_goals; A.ga += m.home_goals;
      if (m.home_goals > m.away_goals) H.pts += 3;
      else if (m.home_goals < m.away_goals) A.pts += 3;
      else { H.pts++; A.pts++; }
    }
  }
  return Object.keys(groups).sort().map((g) => ({
    group: g,
    rows: Object.values(groups[g]).sort((a, b) =>
      b.pts - a.pts || (b.gf - b.ga) - (a.gf - a.ga) || b.gf - a.gf
      || a.team.localeCompare(b.team)),
  }));
}

// ¿El partido tiene cuotas 1X2 cargadas?
const hasOdds = (m) => m.odds_home != null || m.odds_draw != null || m.odds_away != null;

// Chips 1 / X / 2 con la cuota PROMEDIO (tooltip = casa que más paga). null si no hay.
function oddsChips(m) {
  if (!hasOdds(m)) return null;
  const best = m.odds_best || null;
  const o = (v) => (v != null ? Number(v).toFixed(2) : "–");
  const chip = (lab, avg, b, fallbackTitle) => el("span", {
    className: "odd",
    title: b ? `Mejor casa: ${b.book} paga ${Number(b.price).toFixed(2)}` : fallbackTitle,
  }, lab + " ", el("b", {}, o(avg)));
  return el("span", { className: "odds" },
    chip("1", m.odds_home, best && best.home, T(m.home_team)),
    chip("X", m.odds_draw, best && best.draw, "Empate"),
    chip("2", m.odds_away, best && best.away, T(m.away_team)),
  );
}

// Línea "💰 Mejor casa" por resultado (la que más paga). null si no hay.
function bestOddsLine(m) {
  const best = m.odds_best || null;
  if (!best || !(best.home || best.draw || best.away)) return null;
  const p = (v) => Number(v).toFixed(2);
  const seg = (lab, b) => b
    ? el("span", { className: "best-seg" }, lab + ": ", el("b", {}, b.book), " ", el("span", { className: "bp" }, p(b.price)))
    : null;
  const line = el("div", { className: "best-odds" }, el("span", { className: "best-label" }, "💰 Mejor casa "));
  for (const s of [seg("1", best.home), seg("X", best.draw), seg("2", best.away)]) if (s) line.append(s);
  return line;
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
  let anyOdds = false;
  for (const m of next) {
    const row = el("div", { className: "match" });
    row.append(
      el("div", { className: "team home" },
        el("span", { className: "name" }, T(m.home_team)), crestImg(m.home_crest)),
      el("div", { className: "score-box vs" }, "vs"),
      el("div", { className: "team away" },
        crestImg(m.away_crest), el("span", { className: "name" }, T(m.away_team))),
    );
    const meta = el("div", { className: "match-meta" });
    meta.append(el("span", {}, fmtDate(m.kickoff)));
    const chips = oddsChips(m);
    if (chips) { meta.append(chips); anyOdds = true; }
    row.append(meta);
    const best = bestOddsLine(m);
    if (best) row.append(best);
    wrap.append(row);
  }
  // Pista amigable cuando todavía no hay cuotas (aparecen cerca del partido).
  if (!anyOdds) {
    wrap.append(el("p", { className: "muted small odds-hint" },
      "💡 Las cuotas 1 / X / 2 (promedio de casas de apuestas) aparecen acá y en tus pronósticos unos días antes de cada partido."));
  }
}

function renderStandings() {
  const wrap = $("#standings-list");
  wrap.innerHTML = "";
  const groups = computeStandings();
  if (!groups.length) { wrap.innerHTML = `<p class="muted">Todavía no hay grupos cargados.</p>`; return; }
  const crests = crestMap();
  for (const g of groups) {
    const card = el("div", { className: "standings-card" });
    card.append(el("div", { className: "stage-title" }, "Grupo " + g.group));
    const table = el("table", { className: "rank" });
    table.append(el("thead", {}, rowOf("tr",
      th("#"), th("Equipo"), th("PJ", 1), th("DG", 1), th("Pts", 1))));
    const tbody = el("tbody");
    g.rows.forEach((t, i) => {
      const teamCell = el("td", {});
      const inner = el("div", { className: "team-cell" });
      inner.append(crestImg(crests[t.team]), el("span", {}, T(t.team)));
      teamCell.append(inner);
      tbody.append(rowOf("tr",
        el("td", { className: "pos" }, String(i + 1)),
        teamCell,
        el("td", { style: "text-align:right" }, String(t.pj)),
        el("td", { style: "text-align:right" }, String(t.gf - t.ga)),
        el("td", { className: "pts" }, String(t.pts)),
      ));
    });
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
//  ESPECIALES · campeón, finalistas, semifinalistas y goleador
// =====================================================================
const SPECIAL_MARKETS = [
  { key: "champion",      title: "🏆 Campeón",              count: 1, type: "team",   help: "15 pts si acertás el campeón." },
  { key: "finalists",     title: "🥈 Finalistas (2)",        count: 2, type: "team",   help: "6 pts por cada finalista correcto." },
  { key: "semifinalists", title: "4️⃣ Semifinalistas (4)",    count: 4, type: "team",   help: "4 pts por cada semifinalista correcto." },
  { key: "top_scorer",    title: "⚽ Goleador del torneo",    count: 1, type: "player", help: "10 pts si acertás el goleador (Bota de Oro)." },
];
let specialInputs = {};   // key -> [inputEls]
let specialMeta = {};     // key -> {count, type, title}
let specialsLocked = false;

// Equipos de la fase de grupos (los 48), ordenados.
function teamsList() {
  const set = new Set();
  for (const m of matches) if (m.stage === "group") { set.add(m.home_team); set.add(m.away_team); }
  return [...set].filter((t) => t && t !== "Por definir").sort((a, b) => a.localeCompare(b));
}
function groupLetters() {
  return [...new Set(matches.filter((m) => m.stage === "group").map((m) => m.group_name))]
    .filter(Boolean).sort();
}
function groupTeams(letter) {
  const set = new Set();
  for (const m of matches) if (m.stage === "group" && m.group_name === letter) {
    set.add(m.home_team); set.add(m.away_team);
  }
  return [...set].filter((t) => t && t !== "Por definir").sort((a, b) => a.localeCompare(b));
}
function teamSelect(teams, value, locked) {
  const sel = el("select", { disabled: locked });
  sel.append(el("option", { value: "" }, "— elegí —"));
  for (const t of teams) sel.append(el("option", { value: t }, T(t)));
  if (value) sel.value = value;
  return sel;
}

async function renderEspeciales() {
  const wrap = $("#specials-form");
  wrap.innerHTML = `<div class="spinner">Cargando…</div>`;

  const deadlineIso = matches.reduce((min, m) => (!min || m.kickoff < min ? m.kickoff : min), null);
  specialsLocked = !!deadlineIso && new Date(deadlineIso) <= new Date();
  $("#special-deadline").textContent = deadlineIso
    ? (specialsLocked ? "🔒 Cerrados: el Mundial ya arrancó." : "⏰ Se cierran al inicio del Mundial: " + fmtDate(deadlineIso))
    : "";
  $("#save-special-btn").disabled = specialsLocked;

  const { data, error } = await sb.rpc("my_specials", { p_token: session.token });
  if (error && error.message.includes("SESION_INVALIDA")) return logout();
  const mine = {};
  for (const r of data || []) mine[r.market] = r.picks;

  specialInputs = {}; specialMeta = {};
  wrap.innerHTML = "";
  const teams = teamsList();

  // --- mercados fijos ---
  for (const mk of SPECIAL_MARKETS) {
    const card = el("div", { className: "special-card" });
    card.append(el("div", { className: "stage-title" }, mk.title));
    card.append(el("p", { className: "muted small" }, mk.help));
    const box = el("div", { className: "special-inputs" });
    const picks = mine[mk.key] || [];
    specialInputs[mk.key] = [];
    specialMeta[mk.key] = { count: mk.count, type: mk.type, title: mk.title };
    for (let i = 0; i < mk.count; i++) {
      const input = mk.type === "team"
        ? teamSelect(teams, picks[i], specialsLocked)
        : el("input", { type: "text", placeholder: "Nombre del jugador (ej. Lionel Messi)",
                        disabled: specialsLocked, value: picks[i] || "" });
      specialInputs[mk.key].push(input);
      box.append(input);
    }
    card.append(box);
    wrap.append(card);
  }

  // --- 1º y 2º de cada grupo ---
  const groups = groupLetters();
  if (groups.length) {
    const card = el("div", { className: "special-card" });
    card.append(el("div", { className: "stage-title" }, "🥇 1º y 2º de cada grupo"));
    card.append(el("p", { className: "muted small" }, "3 pts por acertar el 1º y 2 pts por el 2º, en cada grupo."));
    const grid = el("div", { className: "group-picks" });
    for (const g of groups) {
      const key = "group_" + g;
      const gt = groupTeams(g);
      const picks = mine[key] || [];
      specialInputs[key] = [];
      specialMeta[key] = { count: 2, type: "team", title: "Grupo " + g };
      const s1 = teamSelect(gt, picks[0], specialsLocked);
      const s2 = teamSelect(gt, picks[1], specialsLocked);
      specialInputs[key].push(s1, s2);
      const row = el("div", { className: "group-pick-row" });
      row.append(
        el("span", { className: "gp-label" }, "Grupo " + g),
        el("span", { className: "gp-slot" }, "1º"), s1,
        el("span", { className: "gp-slot" }, "2º"), s2,
      );
      grid.append(row);
    }
    card.append(grid);
    wrap.append(card);
  }
}

async function saveSpecials() {
  if (specialsLocked) { specialStatus("🔒 Los especiales ya están cerrados.", "err"); return; }
  specialStatus("Guardando…");
  let saved = 0;
  for (const key of Object.keys(specialInputs)) {
    const meta = specialMeta[key];
    const vals = specialInputs[key].map((i) => i.value.trim()).filter(Boolean);
    if (vals.length === 0) continue;                 // mercado vacío, se saltea
    if (vals.length !== meta.count) {
      specialStatus(`Completá los ${meta.count} de "${meta.title}" (o dejalos vacíos).`, "err");
      return;
    }
    if (meta.type === "team" && new Set(vals).size !== vals.length) {
      specialStatus(`No repitas equipos en "${meta.title}".`, "err");
      return;
    }
    const { error } = await sb.rpc("save_special", {
      p_token: session.token, p_market: key, p_picks: vals,
    });
    if (error) {
      if (error.message.includes("SESION_INVALIDA")) return logout();
      if (error.message.includes("ESPECIALES_CERRADOS")) { specialsLocked = true; specialStatus("🔒 Se cerraron los especiales.", "err"); return; }
      specialStatus("Error: " + error.message, "err");
      return;
    }
    saved++;
  }
  if (saved) {
    specialStatus("");
    toast(`✅ Guardado (${saved} pronóstico${saved > 1 ? "s" : ""}).`, "ok");
  } else {
    specialStatus("No completaste ninguno todavía.", "err");
  }
}

function specialStatus(text, kind) {
  const s = $("#special-status");
  if (!text) { s.classList.add("hidden"); return; }
  s.textContent = text;
  s.className = "status" + (kind ? " " + kind : "");
  s.classList.remove("hidden");
}

// =====================================================================
//  ADMIN · cargar resultados y resolver equipos
// =====================================================================
function bindAdminTabs() {
  $$("#admin-tabs .tab").forEach((b) =>
    b.addEventListener("click", () => {
      const t = b.dataset.atab;
      $$("#admin-tabs .tab").forEach((x) => x.classList.toggle("active", x === b));
      $("#admin-players").classList.toggle("hidden", t !== "players");
      $("#admin-matches").classList.toggle("hidden", t !== "matches");
      $("#admin-fantasy").classList.toggle("hidden", t !== "fantasy");
      if (t === "fantasy") renderAdminFantasy();
    }));
}

function renderAdmin() {
  if (!session.is_admin) { showView("predictions"); return; }
  renderAdminPlayers();
  const wrap = $("#admin-list");
  wrap.innerHTML = "";
  renderMatchSections(wrap, matches, adminRow);
}

function adminErr(msg = "") {
  if (msg.includes("NO_ADMIN")) return "No tenés permisos de admin.";
  if (msg.includes("NO_TE_PODES_BORRAR")) return "No te podés borrar a vos mismo.";
  if (msg.includes("ULTIMO_ADMIN")) return "No podés sacarle el admin al último admin del grupo.";
  if (msg.includes("PIN_CORTO")) return "El PIN debe tener al menos 4 caracteres.";
  if (msg.includes("NOMBRE_CORTO")) return "El nombre es muy corto.";
  if (msg.includes("NOMBRE_EXISTE")) return "Ya existe un jugador con ese nombre.";
  if (msg.includes("SESION_INVALIDA")) return "Tu sesión expiró, volvé a entrar.";
  return "Error: " + msg;
}

// Lista de jugadores con acciones de gestión (solo admin).
async function renderAdminPlayers() {
  const wrap = $("#admin-players");
  wrap.innerHTML = `<div class="spinner">Cargando…</div>`;
  const { data, error } = await sb.rpc("admin_list_players", { p_token: session.token });
  if (error) {
    if (error.message.includes("SESION_INVALIDA")) return logout();
    wrap.innerHTML = `<p class="error">${adminErr(error.message)}</p>`;
    return;
  }
  wrap.innerHTML = "";
  wrap.append(el("p", { className: "muted small" },
    "Borrar un jugador elimina también sus pronósticos y especiales. No se puede deshacer."));
  const list = el("div", { className: "admin-players-list" });
  for (const p of data || []) list.append(adminPlayerCard(p));
  wrap.append(list);
}

function adminPlayerCard(p) {
  const isMe = p.id === session.player_id;
  const card = el("div", { className: "admin-player" });

  const nameLine = el("div", { className: "ap-name" }, p.name);
  if (p.is_admin) nameLine.append(el("span", { className: "ap-badge admin" }, "ADMIN"));
  if (isMe) nameLine.append(el("span", { className: "ap-badge you" }, "vos"));
  card.append(el("div", { className: "ap-info" },
    nameLine,
    el("div", { className: "ap-meta muted small" },
      `${p.points} pts · ${p.preds} pronóstico${p.preds === 1 ? "" : "s"} · desde ${fmtDay(p.created_at)}`)));

  const acts = el("div", { className: "ap-acts" });

  const admBtn = el("button", { className: "ghost" }, p.is_admin ? "Sacar admin" : "Hacer admin");
  admBtn.addEventListener("click", () => adminAction(admBtn, "admin_set_admin",
    { p_token: session.token, p_player_id: p.id, p_value: !p.is_admin },
    `${p.is_admin ? "Le sacaste" : "Le diste"} admin a ${p.name}.`));

  const pinBtn = el("button", { className: "ghost" }, "Reset PIN");
  pinBtn.addEventListener("click", () => {
    const np = prompt(`Nuevo PIN para ${p.name} (mín. 4 dígitos):`);
    if (np == null) return;
    adminAction(pinBtn, "admin_reset_pin",
      { p_token: session.token, p_player_id: p.id, p_new_pin: np.trim() },
      `PIN de ${p.name} actualizado.`, false);
  });

  const renBtn = el("button", { className: "ghost" }, "Renombrar");
  renBtn.addEventListener("click", () => {
    const nn = prompt(`Nuevo nombre para ${p.name}:`, p.name);
    if (nn == null) return;
    adminAction(renBtn, "admin_rename_player",
      { p_token: session.token, p_player_id: p.id, p_new_name: nn.trim() },
      `Renombrado a ${nn.trim()}.`);
  });

  const delBtn = el("button", { className: "ghost danger" }, "Borrar");
  delBtn.disabled = isMe;
  if (isMe) delBtn.title = "No te podés borrar a vos mismo";
  delBtn.addEventListener("click", () => {
    if (!confirm(`¿Borrar a ${p.name}? Se eliminan sus pronósticos y especiales. No se puede deshacer.`)) return;
    adminAction(delBtn, "admin_delete_player",
      { p_token: session.token, p_player_id: p.id }, `${p.name} eliminado.`);
  });

  acts.append(admBtn, pinBtn, renBtn, delBtn);
  card.append(acts);
  return card;
}

// Ejecuta una RPC de admin, muestra toast y recarga la lista (salvo reload=false).
async function adminAction(btn, rpc, args, okMsg, reload = true) {
  const old = btn.textContent;
  btn.disabled = true; btn.textContent = "…";
  const { error } = await sb.rpc(rpc, args);
  if (error) {
    if (error.message.includes("SESION_INVALIDA")) return logout();
    toast(adminErr(error.message), "err");
    btn.disabled = false; btn.textContent = old;
    return;
  }
  toast("✅ " + okMsg, "ok");
  if (reload) await renderAdminPlayers();
  else { btn.disabled = false; btn.textContent = old; }
}

// =====================================================================
//  ADMIN · Fantasy (catálogo de jugadores: alta / baja / precio / foto)
// =====================================================================
const FANTASY_TEAMS = Object.keys(TEAM_ES).filter((t) => t !== "Por definir").sort();
let afTeam = "";  // equipo elegido en el filtro del admin

function adminFantasyErr(msg = "") {
  if (msg.includes("NO_AUTORIZADO")) return "No tenés permisos de admin.";
  if (msg.includes("NOMBRE_VACIO")) return "El nombre no puede estar vacío.";
  if (msg.includes("EQUIPO_VACIO")) return "Elegí un equipo.";
  if (msg.includes("POSICION")) return "Posición inválida.";
  if (msg.includes("PRECIO")) return "El precio debe ser mayor a 0.";
  if (msg.includes("JUGADOR_INEXISTENTE")) return "Ese jugador ya no existe.";
  if (msg.includes("SESION_INVALIDA")) return "Tu sesión expiró, volvé a entrar.";
  return "Error: " + msg;
}

// Invalida la caché del catálogo del front para que el fantasy se recargue.
function invalidateFantasyCache() { fantasyAll = null; }

function renderAdminFantasy() {
  const wrap = $("#admin-fantasy");
  wrap.innerHTML = "";
  wrap.append(adminFantasyAddForm());

  const controls = el("div", { className: "af-controls" });
  const teamSel = el("select");
  teamSel.append(el("option", { value: "" }, "— Elegí un equipo —"));
  for (const t of FANTASY_TEAMS) teamSel.append(el("option", { value: t }, T(t)));
  teamSel.value = afTeam;
  teamSel.onchange = () => { afTeam = teamSel.value; renderAdminFantasyList(); };
  controls.append(el("label", {}, "Equipo ", teamSel));
  wrap.append(controls);

  wrap.append(el("div", { id: "af-list", className: "af-list" }));
  renderAdminFantasyList();
}

async function renderAdminFantasyList() {
  const list = $("#af-list");
  if (!list) return;
  if (!afTeam) {
    list.innerHTML = `<p class="muted small">Elegí un equipo para ver y editar su plantel.</p>`;
    return;
  }
  list.innerHTML = `<div class="spinner">Cargando…</div>`;
  const { data, error } = await sb.from("fantasy_players")
    .select("id,name,team,position,price,photo").eq("team", afTeam)
    .order("price", { ascending: false });
  if (error) { list.innerHTML = `<p class="error">${error.message}</p>`; return; }
  list.innerHTML = "";
  list.append(el("p", { className: "muted small" }, `${data.length} jugadores en ${T(afTeam)}.`));
  for (const p of data) list.append(adminFantasyRow(p));
}

function adminFantasyAddForm() {
  const box = el("div", { className: "af-add" });
  const name = el("input", { type: "text", placeholder: "Nombre" });
  const team = el("select");
  for (const t of FANTASY_TEAMS) team.append(el("option", { value: t }, T(t)));
  if (afTeam) team.value = afTeam;
  const pos = el("select");
  for (const k of ["GK", "DEF", "MID", "FWD"]) pos.append(el("option", { value: k }, k));
  const price = el("input", { type: "number", step: "0.5", min: "0.5", value: "4.5" });
  const photo = el("input", { type: "text", placeholder: "URL foto (opcional)" });
  const add = el("button", { className: "primary" }, "Agregar");
  add.onclick = async () => {
    if (!name.value.trim()) { toast("Poné un nombre.", "err"); return; }
    add.disabled = true;
    const { error } = await sb.rpc("fantasy_add_player", {
      p_token: session.token, p_name: name.value.trim(), p_team: team.value,
      p_position: pos.value, p_price: +price.value, p_photo: photo.value.trim(),
    });
    add.disabled = false;
    if (error) { toast(adminFantasyErr(error.message), "err"); return; }
    toast("✅ Jugador agregado.", "ok");
    name.value = ""; photo.value = "";
    afTeam = team.value;
    invalidateFantasyCache();
    renderAdminFantasy();
  };
  box.append(
    el("h3", { className: "block-title" }, "➕ Agregar jugador"),
    el("div", { className: "af-addrow" }, name, team, pos, price, photo, add));
  return box;
}

function adminFantasyRow(p) {
  const row = el("div", { className: "af-row" });
  const photo = p.photo
    ? el("img", { className: "af-photo", src: p.photo, alt: "", loading: "lazy" })
    : el("div", { className: "af-photo ph" }, "⚽");
  const name = el("input", { type: "text", value: p.name, className: "af-name" });
  const pos = el("select", { className: "af-pos" });
  for (const k of ["GK", "DEF", "MID", "FWD"]) {
    const o = el("option", { value: k }, k);
    if (p.position === k) o.selected = true;
    pos.append(o);
  }
  const price = el("input", { type: "number", step: "0.5", min: "0.5", value: p.price, className: "af-price" });
  const photoUrl = el("input", { type: "text", value: p.photo || "", placeholder: "URL foto", className: "af-photourl" });
  const save = el("button", { className: "primary af-save" }, "Guardar");
  save.onclick = async () => {
    save.disabled = true; save.textContent = "…";
    const { error } = await sb.rpc("fantasy_update_player", {
      p_token: session.token, p_footballer: p.id, p_name: name.value.trim(),
      p_team: afTeam, p_position: pos.value, p_price: +price.value, p_photo: photoUrl.value.trim(),
    });
    save.disabled = false; save.textContent = "Guardar";
    if (error) { toast(adminFantasyErr(error.message), "err"); return; }
    if (photoUrl.value.trim() && photo.tagName === "IMG") photo.src = photoUrl.value.trim();
    invalidateFantasyCache();
    toast("✅ Guardado.", "ok");
  };
  const del = el("button", { className: "ghost danger af-del", title: "Borrar" }, "🗑");
  del.onclick = async () => {
    if (!confirm(`¿Borrar a ${p.name}? Se quita también de los planteles que lo tengan.`)) return;
    const { error } = await sb.rpc("fantasy_delete_player", {
      p_token: session.token, p_footballer: p.id,
    });
    if (error) { toast(adminFantasyErr(error.message), "err"); return; }
    invalidateFantasyCache();
    toast(`✅ ${p.name} eliminado.`, "ok");
    row.remove();
  };
  row.append(photo, name, pos, price, photoUrl, save, del);
  return row;
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

// =====================================================================
//  FANTASY · "Mi Plantel Mundial" (minigame)
//  Presupuesto fijo (100M), once por formación, capitán x2, plantel
//  rearmable libremente en cada fase del Mundial. Puntaje por rendimiento
//  real (lo carga el sync desde API-Football → vistas SQL).
// =====================================================================
const FANTASY_BUDGET = 100;
const FORMATIONS = [
  { name: "4-4-2", DEF: 4, MID: 4, FWD: 2 },
  { name: "4-3-3", DEF: 4, MID: 3, FWD: 3 },
  { name: "4-5-1", DEF: 4, MID: 5, FWD: 1 },
  { name: "3-5-2", DEF: 3, MID: 5, FWD: 2 },
  { name: "3-4-3", DEF: 3, MID: 4, FWD: 3 },
  { name: "5-3-2", DEF: 5, MID: 3, FWD: 2 },
  { name: "5-4-1", DEF: 5, MID: 4, FWD: 1 },
];
const POS_LABELS = { GK: "Arquero", DEF: "Defensor", MID: "Mediocampista", FWD: "Delantero" };
// Fases del fantasy y las etapas de cada una (para deadlines, desde matches).
const FANTASY_PHASES = [
  { n: 1, label: "Fase de grupos", stages: ["group"] },
  { n: 2, label: "Dieciseisavos",  stages: ["R32"] },
  { n: 3, label: "Octavos",        stages: ["R16"] },
  { n: 4, label: "Cuartos",        stages: ["QF"] },
  { n: 5, label: "Semis + Final",  stages: ["SF", "TP", "FINAL"] },
];

let fantasyAll = null;            // catálogo [{id,name,team,position,price,photo}]
let fantasyById = new Map();
let fantasyEntered = false;       // ya entramos al menos una vez (para fijar fase default)
let fPhase = 1;
let fFormation = FORMATIONS[0];
let fSquad = { GK: [], DEF: [], MID: [], FWD: [] };
let fCaptain = null;
let fLocked = false;             // la fase ya arrancó: plantel fijo
let fNotOpen = false;            // la fase todavía no se habilita (futura)
let fPickPos = null;              // posición que se está eligiendo en el overlay
let fSavedSnap = "";             // snapshot del último estado guardado (para "sin guardar")

// --- helpers ---
const fmtM = (x) => (Math.round((Number(x) || 0) * 10) / 10) + "M";
const shortName = (n) => {
  const parts = String(n || "").trim().split(/\s+/);
  return parts.length > 1 ? parts[parts.length - 1] : (n || "");
};
const normName = (s) =>
  String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const fSquadIds = () => [...fSquad.GK, ...fSquad.DEF, ...fSquad.MID, ...fSquad.FWD];
const spentTotal = () =>
  fSquadIds().reduce((s, id) => s + Number(fantasyById.get(id)?.price || 0), 0);
function fantasySnap() {
  return fSquadIds().slice().sort().join(",") + "|" + (fCaptain || "");
}
function phaseDeadline(n) {
  const ph = FANTASY_PHASES.find((p) => p.n === n);
  const ks = matches.filter((m) => ph.stages.includes(m.stage))
    .map((m) => +new Date(m.kickoff)).filter((t) => !isNaN(t));
  return ks.length ? new Date(Math.min(...ks)) : null;
}
// Una fase de eliminatoria se habilita unos días antes de su deadline (recién
// ahí se van conociendo los clasificados). La fase de grupos está abierta desde
// el arranque. Antes de eso la fase está "futura" y no se puede editar.
const FANTASY_OPEN_LEAD_DAYS = 3;
function phaseOpenTime(n) {
  if (n <= 1) return null;                 // grupos: siempre abierta hasta cerrar
  const dl = phaseDeadline(n);
  return dl ? new Date(+dl - FANTASY_OPEN_LEAD_DAYS * 864e5) : null;
}
// "closed" = ya arrancó (queda fija) · "future" = todavía no se habilita · "open"
function phaseState(n) {
  const dl = phaseDeadline(n);
  const now = new Date();
  if (dl && now >= dl) return "closed";
  const ot = phaseOpenTime(n);
  if (ot && now < ot) return "future";
  return "open";
}
function defaultPhase() {
  const open = FANTASY_PHASES.find((p) => phaseState(p.n) === "open");
  if (open) return open.n;
  const notClosed = FANTASY_PHASES.find((p) => phaseState(p.n) !== "closed");
  return notClosed ? notClosed.n : 5;
}

function bindFantasy() {
  $$("#fantasy-tabs .tab").forEach((b) =>
    b.addEventListener("click", () => {
      const t = b.dataset.ftab;
      $$("#fantasy-tabs .tab").forEach((x) => x.classList.toggle("active", x === b));
      $("#fantasy-squad-pane").classList.toggle("hidden", t !== "squad");
      $("#fantasy-ranking-pane").classList.toggle("hidden", t !== "ranking");
      $("#fantasy-rules-pane").classList.toggle("hidden", t !== "rules");
      if (t === "squad") { enterFantasySquad(); return; }
      $("#fantasy-save-bar").classList.add("hidden");
      if (t === "ranking") renderFantasyRanking();
    }));
  $("#fantasy-save-btn").addEventListener("click", saveFantasy);
  $("#fp-close").addEventListener("click", closePicker);
  $("#fp-search").addEventListener("input", (e) => renderPickerList(e.target.value));
  $("#fantasy-picker").addEventListener("click", (e) => {
    if (e.target.id === "fantasy-picker") closePicker();
  });
}

async function renderFantasy() {
  await loadFantasyPlayers();
  if (!fantasyEntered) { fPhase = defaultPhase(); fantasyEntered = true; }
  if (!fantasyAll.length) {
    $("#fantasy-pitch").innerHTML =
      `<p class="muted empty-state">El catálogo de jugadores todavía no está cargado.<br>` +
      `Aparece tras la primera sincronización con API-Football.</p>`;
    $("#fantasy-budget").innerHTML = "";
    $("#fantasy-deadline").textContent = "";
    return;
  }
  if (!$("#fantasy-rules-pane").classList.contains("hidden")) return; // reglas: estáticas
  const rankingTab = !$("#fantasy-ranking-pane").classList.contains("hidden");
  if (rankingTab) return renderFantasyRanking();
  await enterFantasySquad();
}

async function loadFantasyPlayers() {
  if (fantasyAll) return;
  let all = [], from = 0; const step = 1000;
  while (true) {
    const { data, error } = await sb.from("fantasy_players")
      .select("id,name,team,position,price,photo")
      .order("price", { ascending: false })
      .range(from, from + step - 1);
    if (error) { console.error(error); break; }
    all = all.concat(data || []);
    if (!data || data.length < step) break;
    from += step;
  }
  fantasyAll = all;
  fantasyById = new Map(all.map((p) => [p.id, p]));
}

async function enterFantasySquad() {
  if (!fantasyAll || !fantasyAll.length) return;
  buildFantasyPhaseSelect();
  await loadMySquad();
  computeFantasyLock();
  buildFantasyFormationSelect();
  renderPitch();
}

function buildFantasyPhaseSelect() {
  const sel = $("#fantasy-phase");
  sel.innerHTML = "";
  for (const ph of FANTASY_PHASES) {
    const st = phaseState(ph.n);
    const tag = st === "closed" ? " 🔒" : st === "future" ? " ⏳" : "";
    sel.append(el("option", { value: String(ph.n) }, ph.label + tag));
  }
  sel.value = String(fPhase);
  sel.onchange = async () => {
    fPhase = +sel.value;
    await loadMySquad();
    computeFantasyLock();
    buildFantasyFormationSelect();
    renderPitch();
  };
}

function buildFantasyFormationSelect() {
  const sel = $("#fantasy-formation");
  sel.innerHTML = "";
  for (const f of FORMATIONS) sel.append(el("option", { value: f.name }, f.name));
  sel.value = fFormation.name;
  sel.disabled = fLocked || fNotOpen;
  sel.onchange = () => onFormationChange(sel.value);
}

async function loadMySquad() {
  fSquad = { GK: [], DEF: [], MID: [], FWD: [] };
  fCaptain = null;
  const { data, error } = await sb.rpc("fantasy_my_squad", {
    p_token: session.token, p_phase: fPhase,
  });
  if (error) {
    if (error.message.includes("SESION_INVALIDA")) return logout();
  } else {
    for (const r of data || []) {
      const p = fantasyById.get(r.footballer_id);
      if (!p) continue;
      fSquad[p.position].push(r.footballer_id);
      if (r.is_captain) fCaptain = r.footballer_id;
    }
    // Inferir la formación a partir de los conteos guardados.
    const f = FORMATIONS.find((F) =>
      F.DEF === fSquad.DEF.length && F.MID === fSquad.MID.length && F.FWD === fSquad.FWD.length);
    if (f) fFormation = f;
  }
  fSavedSnap = fantasySnap();
}

function computeFantasyLock() {
  const st = phaseState(fPhase);
  fLocked = st === "closed";   // ya arrancó: plantel fijo
  fNotOpen = st === "future";  // todavía no se habilita
}

function onFormationChange(name) {
  const f = FORMATIONS.find((F) => F.name === name);
  if (!f) return;
  fFormation = f;
  // Si la nueva formación tiene menos lugares en un puesto, recorto el excedente.
  for (const pos of ["DEF", "MID", "FWD"]) {
    if (fSquad[pos].length > f[pos]) {
      const dropped = fSquad[pos].splice(f[pos]);
      if (dropped.includes(fCaptain)) fCaptain = null;
    }
  }
  renderPitch();
}

function renderPitch() {
  const used = spentTotal();
  const over = used > FANTASY_BUDGET;

  // Barra de presupuesto
  const budget = $("#fantasy-budget");
  budget.innerHTML = "";
  const pct = Math.min(100, used / FANTASY_BUDGET * 100);
  budget.append(
    el("div", { className: "fb-bar" },
      el("div", { className: "fb-fill" + (over ? " over" : ""), style: `width:${pct}%` })),
    el("div", { className: "fb-text" + (over ? " over" : "") },
      `Presupuesto ${fmtM(used)} / ${FANTASY_BUDGET}M · ` +
      (over ? "te pasaste por " + fmtM(used - FANTASY_BUDGET)
            : "te quedan " + fmtM(FANTASY_BUDGET - used))),
  );

  // Deadline / estado de la fase
  const dl = phaseDeadline(fPhase);
  const ot = phaseOpenTime(fPhase);
  let dmsg;
  if (!dl) dmsg = "Esta fase todavía no tiene partidos cargados.";
  else if (fLocked) dmsg = "🔒 Esta fase ya cerró: el plantel quedó fijo.";
  else if (fNotOpen) dmsg = "⏳ Esta fase se habilita el " + fmtDate(ot) +
    ". Por ahora no se puede editar (se abre cuando se acerque).";
  else dmsg = "⏰ Cierra al inicio de la fase: " + fmtDate(dl);
  $("#fantasy-deadline").textContent = dmsg;

  // Cancha (delanteros arriba, arquero abajo)
  const pitch = $("#fantasy-pitch");
  pitch.innerHTML = "";
  for (const pos of ["FWD", "MID", "DEF", "GK"]) {
    const max = pos === "GK" ? 1 : fFormation[pos];
    const line = el("div", { className: "fp-line" });
    for (let i = 0; i < max; i++) {
      const id = fSquad[pos][i];
      line.append(id ? filledSlot(id, pos) : emptySlot(pos));
    }
    pitch.append(line);
  }
  refreshFantasySaveBar();
}

function filledSlot(id, pos) {
  const p = fantasyById.get(id);
  const isCap = fCaptain === id;
  const slot = el("div", { className: "fp-slot filled" + (isCap ? " captain" : "") });
  slot.append(p.photo
    ? el("img", { className: "fp-photo", src: p.photo, alt: "", loading: "lazy" })
    : el("div", { className: "fp-photo ph" }, "⚽"));
  slot.append(el("div", { className: "fp-name" }, shortName(p.name)));
  slot.append(el("div", { className: "fp-team muted" }, T(p.team)));
  slot.append(el("div", { className: "fp-price" }, fmtM(p.price)));
  if (!fLocked && !fNotOpen) {
    const cap = el("button", { className: "fp-cap" + (isCap ? " on" : ""), title: "Capitán (x2)" }, "★");
    cap.addEventListener("click", (e) => {
      e.stopPropagation();
      fCaptain = isCap ? null : id;
      renderPitch();
    });
    const rm = el("button", { className: "fp-rm", title: "Quitar" }, "✕");
    rm.addEventListener("click", (e) => { e.stopPropagation(); removePlayer(id, pos); });
    slot.append(cap, rm);
  } else if (isCap) {
    slot.append(el("span", { className: "fp-capbadge" }, "★"));
  }
  return slot;
}

function emptySlot(pos) {
  const ro = fLocked || fNotOpen;
  const slot = el("button", { className: "fp-slot empty", disabled: ro },
    el("span", { className: "fp-plus" }, "＋"),
    el("span", { className: "fp-emptylbl" }, POS_LABELS[pos]));
  if (!ro) slot.addEventListener("click", () => openPicker(pos));
  return slot;
}

function removePlayer(id, pos) {
  fSquad[pos] = fSquad[pos].filter((x) => x !== id);
  if (fCaptain === id) fCaptain = null;
  renderPitch();
}

function openPicker(pos) {
  fPickPos = pos;
  $("#fp-title").textContent = "Elegí un " + POS_LABELS[pos].toLowerCase();
  $("#fp-search").value = "";
  renderPickerList("");
  $("#fantasy-picker").classList.remove("hidden");
  $("#fp-search").focus();
}
function closePicker() { $("#fantasy-picker").classList.add("hidden"); }

function renderPickerList(q) {
  const list = $("#fp-list");
  list.innerHTML = "";
  const chosen = new Set(fSquadIds());
  const remain = FANTASY_BUDGET - spentTotal();
  const nq = normName(q);
  const items = fantasyAll
    .filter((p) => p.position === fPickPos && !chosen.has(p.id) &&
      (!nq || normName(p.name).includes(nq) || normName(T(p.team)).includes(nq) || normName(p.team).includes(nq)))
    .slice(0, 250);
  if (!items.length) {
    list.append(el("p", { className: "muted small", style: "padding:.6rem" }, "Sin resultados."));
    return;
  }
  for (const p of items) {
    const aff = Number(p.price) <= remain + 1e-9;
    const row = el("button", { className: "fp-item" + (aff ? "" : " disabled"), disabled: !aff });
    row.append(p.photo
      ? el("img", { className: "fp-photo sm", src: p.photo, alt: "", loading: "lazy" })
      : el("div", { className: "fp-photo sm ph" }, "⚽"));
    row.append(el("div", { className: "fp-iname" },
      el("b", {}, p.name), el("div", { className: "muted small" }, T(p.team))));
    row.append(el("span", { className: "fp-price" }, fmtM(p.price)));
    if (aff) row.addEventListener("click", () => addPlayer(p));
    list.append(row);
  }
}

function addPlayer(p) {
  const max = p.position === "GK" ? 1 : fFormation[p.position];
  if (fSquad[p.position].length >= max) {
    toast(`Ya completaste los ${POS_LABELS[p.position].toLowerCase()}s de esta formación.`, "err");
    return;
  }
  if (spentTotal() + Number(p.price) > FANTASY_BUDGET) {
    toast("Te pasás del presupuesto.", "err");
    return;
  }
  fSquad[p.position].push(p.id);
  closePicker();
  renderPitch();
}

function refreshFantasySaveBar() {
  const bar = $("#fantasy-save-bar");
  if (!bar) return;
  const onFantasy = !$("#view-fantasy").classList.contains("hidden");
  const onSquad = !$("#fantasy-squad-pane").classList.contains("hidden");
  const changed = fantasySnap() !== fSavedSnap;
  if (onFantasy && onSquad && !fLocked && !fNotOpen && changed) {
    const n = fSquadIds().length;
    $("#fantasy-save-info").textContent = `${n}/11 · ${fmtM(spentTotal())}/${FANTASY_BUDGET}M`;
    bar.classList.remove("hidden");
  } else {
    bar.classList.add("hidden");
  }
}

async function saveFantasy() {
  const ids = fSquadIds();
  if (ids.length !== 11) { toast("El plantel es de 11 jugadores (te faltan).", "err"); return; }
  if (spentTotal() > FANTASY_BUDGET) { toast(`Te pasás del presupuesto (${FANTASY_BUDGET}M).`, "err"); return; }
  if (!fCaptain) { toast("Elegí un capitán (★).", "err"); return; }
  const btn = $("#fantasy-save-btn");
  btn.disabled = true;
  const { error } = await sb.rpc("fantasy_save_squad", {
    p_token: session.token, p_phase: fPhase, p_picks: ids, p_captain: fCaptain,
  });
  btn.disabled = false;
  if (error) {
    if (error.message.includes("SESION_INVALIDA")) return logout();
    toast(fantasyErr(error.message), "err");
    return;
  }
  fSavedSnap = fantasySnap();
  refreshFantasySaveBar();
  toast("✅ Plantel guardado.", "ok");
}

function fantasyErr(msg = "") {
  if (msg.includes("FASE_CERRADA")) return "Esta fase ya cerró.";
  if (msg.includes("PRESUPUESTO")) return `Te pasaste de los ${FANTASY_BUDGET}M.`;
  if (msg.includes("FORMACION")) return "Formación inválida (revisá la cantidad por puesto).";
  if (msg.includes("PLANTEL_INCOMPLETO")) return "El plantel debe tener 11 jugadores.";
  if (msg.includes("CAPITAN")) return "Elegí un capitán válido.";
  if (msg.includes("PICKS")) return "Hay jugadores inválidos en el plantel.";
  if (msg.includes("SESION_INVALIDA")) return "Tu sesión expiró, volvé a entrar.";
  return "Error: " + msg;
}

async function renderFantasyRanking() {
  const wrap = $("#fantasy-ranking-table");
  wrap.innerHTML = `<div class="spinner">Cargando…</div>`;
  const { data, error } = await sb.from("fantasy_leaderboard")
    .select("*").order("points", { ascending: false });
  if (error) { wrap.innerHTML = `<p class="error">${error.message}</p>`; return; }
  if (!data || !data.length) {
    wrap.innerHTML = `<p class="muted empty-state">Todavía no hay puntos. ¡Armá tu plantel! 🃏</p>`;
    return;
  }
  const table = el("table", { className: "rank" });
  table.append(el("thead", {}, rowOf("tr", th("Pos"), th("Jugador"), th("Puntos", 1))));
  const tbody = el("tbody");
  data.forEach((r, i) => {
    const tr = el("tr", r.player_id === session.player_id ? { className: "me" } : {});
    tr.append(el("td", { className: "pos" }, i < 3 ? MEDALS[i] : String(i + 1)));
    const nameTd = el("td", { className: "rk-name" }, r.player_name);
    if (r.player_id === session.player_id) nameTd.append(el("span", { className: "you" }, "vos"));
    tr.append(nameTd);
    tr.append(el("td", { className: "pts" }, String(r.points)));
    tbody.append(tr);
  });
  table.append(tbody);
  wrap.innerHTML = "";
  wrap.append(el("div", { className: "rank-card" }, table));
}
