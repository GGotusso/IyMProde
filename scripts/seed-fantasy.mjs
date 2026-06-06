// =====================================================================
//  Corre SOLO el sync del minigame Fantasy (sembrado de jugadores +
//  mapeo de fixtures + stats), sin tocar el sync de football-data.
//  Útil para sembrar el catálogo localmente o a mano.
//
//  Necesita en .env (o en el entorno):
//    SUPABASE_URL
//    SUPABASE_SERVICE_ROLE_KEY   (Supabase → Settings → API → service_role)
//    APIFOOTBALL_KEY             (api-sports.io)
//
//  Uso:  node scripts/seed-fantasy.mjs
// =====================================================================
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

import { syncFantasy } from "./fantasy-sync.mjs";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("Faltan SUPABASE_URL y/o SUPABASE_SERVICE_ROLE_KEY en .env");
  process.exit(1);
}
if (!process.env.APIFOOTBALL_KEY) {
  console.error("Falta APIFOOTBALL_KEY en .env");
  process.exit(1);
}

await syncFantasy({ SUPABASE_URL, SERVICE_KEY });
