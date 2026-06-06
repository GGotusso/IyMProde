// Parser de SquadLists FIFA (squad_raw.txt de `pdftotext -raw`).
// Devuelve { teamName(FIFA): [{pos, name, first, last}] } para los 48 equipos.
import { readFileSync } from "node:fs";

const raw = readFileSync(new URL("./data/squad_raw.txt", import.meta.url), "utf8");

// Mapea el código FIFA (3 letras, libre de mojibake) -> nombre usado en la app/matches.
export const CODE_TO_APP = {
  ALG: "Algeria", ARG: "Argentina", AUS: "Australia", AUT: "Austria",
  BEL: "Belgium", BIH: "Bosnia-Herzegovina", BRA: "Brazil", CPV: "Cape Verde Islands",
  CAN: "Canada", COL: "Colombia", COD: "Congo DR", CIV: "Ivory Coast",
  CRO: "Croatia", CUW: "Curaçao", CZE: "Czechia", ECU: "Ecuador",
  EGY: "Egypt", ENG: "England", FRA: "France", GER: "Germany", GHA: "Ghana",
  HAI: "Haiti", IRN: "Iran", IRQ: "Iraq", JPN: "Japan", JOR: "Jordan",
  KOR: "South Korea", MEX: "Mexico", MAR: "Morocco", NED: "Netherlands",
  NZL: "New Zealand", NOR: "Norway", PAN: "Panama", PAR: "Paraguay",
  POR: "Portugal", QAT: "Qatar", KSA: "Saudi Arabia", SCO: "Scotland",
  SEN: "Senegal", RSA: "South Africa", ESP: "Spain", SWE: "Sweden",
  SUI: "Switzerland", TUN: "Tunisia", TUR: "Turkey", URU: "Uruguay",
  USA: "United States", UZB: "Uzbekistan",
};

const POS_MAP = { GK: "GK", DF: "DEF", MF: "MID", FW: "FWD" };

// Title-case respetando partículas (de, van, etc.) y guiones.
function titleCase(s) {
  return s.toLowerCase().split(/([ -])/).map((w) => {
    if (w === " " || w === "-") return w;
    let r = w.charAt(0).toUpperCase() + w.slice(1);
    // Mc/Mac/O' → capitaliza la letra que sigue (Mckennie → McKennie).
    r = r.replace(/^(Mc|Mac|O['’])([a-z])/, (_, p, c) => p + c.toUpperCase());
    return r;
  }).join("");
}

export function parseSquads() {
  const lines = raw.split("\n");
  const teams = {};
  let cur = null;

  const headerRe = /^.+? \(([A-Z]{3})\)\s*$/;
  // POS  PLAYER-NAME(SURNAME First)  FIRST(S)  LAST(S)  SHIRT  DOB  Club (CCC)  Height
  const playerRe = /^(GK|DF|MF|FW)\s+(.+?)\s+(\d{2}\/\d{2}\/\d{4})\s+(.+?)\s+\(([A-Z]{3})\)\s+\d{2,3}\s*$/;

  for (const ln of lines) {
    const h = ln.match(headerRe);
    if (h && CODE_TO_APP[h[1]]) {
      cur = CODE_TO_APP[h[1]];
      teams[cur] ||= [];
      continue;
    }
    const p = ln.match(playerRe);
    if (p && cur) {
      const pos = POS_MAP[p[1]];
      // p[2] = "SURNAME(S) First FIRST(S) LAST(S) SHIRT" todo junto.
      // El "PLAYER NAME" = apellidos en MAYUS + un nombre Title. Tomamos:
      //   apellido = tokens MAYUS iniciales ; nombre = primer token Title que sigue.
      const toks = p[2].split(/\s+/);
      const sur = [];
      let i = 0;
      // apellido = tokens MAYUS (incl. partículas "DE"/"VAN"/"AL") o tipo Mc/Mac/O'
      const isSurTok = (t) => /^[A-ZÀ-Þ'’.\-]+$/.test(t) || /^(Mc|Mac|O['’])[A-ZÀ-Þ]/.test(t);
      while (i < toks.length && isSurTok(toks[i])) { sur.push(toks[i]); i++; }
      // nombre de pila: token Title; si es una partícula (El/Al/Ben…), suma el siguiente.
      const PARTICLE = new Set(["el", "al", "da", "de", "ben", "bin", "abu", "ould", "van", "von"]);
      let first = toks[i] || "";
      if (PARTICLE.has(first.toLowerCase()) && toks[i + 1]) first += " " + toks[i + 1];
      const last = titleCase(sur.join(" "));
      // Colapsa tokens duplicados consecutivos: en nombres árabes/egipcios el
      // "PLAYER NAME" repite el nombre de pila ("MOHAMED SALAH Mohamed" → evita
      // "Mohamed Mohamed Salah").
      const parts = ((first ? first + " " : "") + last).trim().split(/\s+/);
      const dedup = parts.filter((w, k) => k === 0 || w.toLowerCase() !== parts[k - 1].toLowerCase());
      const name = dedup.join(" ");
      teams[cur].push({ pos, name, first, last });
    }
  }
  return teams;
}

// Ejecutado directo: imprime resumen.
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("parse-squads.mjs")) {
  const t = parseSquads();
  const names = Object.keys(t).sort();
  console.log("Equipos parseados:", names.length);
  for (const n of names) console.log("  " + n.padEnd(22) + t[n].length);
}
