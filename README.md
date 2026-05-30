# ⚽ Prode Mundial 2026

Prode (polla/quiniela) para jugar entre amigos durante el Mundial 2026.
Pronosticás el marcador de cada partido y sumás puntos:

- **3 puntos** → marcador exacto (ej. predijiste 2-1 y salió 2-1)
- **1 punto** → acertaste el resultado (ganador o empate) pero no el marcador
- **0 puntos** → erraste

Tiene **ranking final** (acumulado) y **ranking semanal**.

## ¿Cómo está hecho? (y por qué)

| Pieza | Tecnología | Costo |
|---|---|---|
| Frontend (la web) | HTML/CSS/JS puro, **sin build** | Gratis en **GitHub Pages** |
| Base de datos + login | **Supabase** (Postgres + funciones RPC) | Plan gratis |
| Resultados + datos del Mundial | **GitHub Actions** (cron cada hora) + API de fútbol | Gratis |

> **¿Por qué no todo en GitHub Pages?** GitHub Pages solo sirve archivos
> estáticos: no puede guardar datos ni ejecutar nada en un horario. Por eso
> los datos viven en Supabase y un cron de GitHub Actions trae los resultados.

---

## Puesta en marcha (paso a paso)

### 1) Base de datos — Supabase
1. Creá un proyecto gratis en <https://supabase.com>.
2. Andá a **SQL Editor → New query**, pegá **todo** `supabase/schema.sql` y dale **Run**.
   - Esto crea las tablas, la seguridad (RLS + funciones RPC), el scoring, las
     vistas de ranking y un fixture *placeholder* de 104 partidos.
3. (Opcional) En el SQL, cambiá el **código del grupo** (por defecto `MUNDIAL2026`):
   ```sql
   update settings set value = 'TU_CODIGO' where key = 'group_code';
   ```

### 2) Conectar el frontend
1. En Supabase: **Settings → API**. Copiá **Project URL** y la **anon public key**.
2. Pegalas en `js/config.js`.
   - La *anon key* es pública por diseño; no hay problema en que se vea.
   - ⚠️ La **service_role key NO va acá**, nunca. Solo se usa en GitHub Actions (paso 4).

### 3) Publicar la web — GitHub Pages
1. Creá un repo en GitHub y subí todos estos archivos.
2. En el repo: **Settings → Pages**.
3. En *Source* elegí **Deploy from a branch**, branch `main`, carpeta `/ (root)`.
4. A los segundos tu prode queda en `https://TU-USUARIO.github.io/TU-REPO/`.
   - Compartí ese link y el **código del grupo** con tus amigos.

> El primer usuario que se registra queda como **admin** (ve la pestaña Admin
> para cargar resultados a mano si hiciera falta).

### 4) Resultados automáticos — GitHub Actions (1×/día)
1. Conseguí un **token gratis** en <https://www.football-data.org/client/register>.
   - Verificá que tu plan incluya el **Mundial (World Cup)**. Si no, mirá
     "Alternativas de API" más abajo.
2. En el repo: **Settings → Secrets and variables → Actions → New repository secret**.
   Creá estos secrets:
   | Nombre | Valor |
   |---|---|
   | `SUPABASE_URL` | la Project URL de Supabase |
   | `SUPABASE_SERVICE_ROLE_KEY` | Supabase → Settings → API → **service_role** (secreta) |
   | `FOOTBALL_DATA_TOKEN` | tu token de football-data.org |
   | `ODDS_API_KEY` | *(opcional)* tu API key de [the-odds-api.com](https://the-odds-api.com) para las **cuotas 1X2** |
3. El workflow `.github/workflows/sync-results.yml` corre **cada hora** y también
   podés dispararlo a mano: pestaña **Actions → "Sincronizar resultados del
   Mundial" → Run workflow**.
4. Cada corrida:
   - reemplaza el fixture *placeholder* por el **fixture real** (equipos, fechas,
     llaves de eliminatoria) y carga los **marcadores**;
   - guarda **posiciones por grupo** y **goleadores** en la tabla `meta_cache`;
   - si está `ODDS_API_KEY`, carga las **cuotas 1X2** (promedio de varias casas) y
     la **mejor casa por resultado** en la tabla `matches`.

> Los goleadores dependen de lo que incluya tu plan de football-data.org; si no
> vienen, el resto funciona igual y ese bloque queda vacío.

### Cuotas (odds) — The Odds API
Las cuotas vienen de [the-odds-api.com](https://the-odds-api.com) (plan gratis:
**500 requests/mes**), que agrega las cuotas de ~20 casas para la key
`soccer_fifa_world_cup`. Registrate, copiá tu API key al secret `ODDS_API_KEY` y
listo. El sync:
- muestra la **cuota promedio** 1 / X / 2 de cada próximo partido;
- en el tooltip y debajo, la **casa que más paga** para cada resultado;
- **antes** de usarlas, corré una vez la migración `supabase/migracion-cuotas.sql`.

Para quedar lo más "live" posible sin agotar la cuota gratis, el sync pide las
cuotas con **cadencia adaptativa**: cada hora si hay un partido en ≤3 h, cada 3 h
si hay uno en ≤24 h, cada 12 h si hay uno en ≤72 h, y **nada** si no hay partidos
próximos (en días pico del Mundial son ~12-15 llamadas/día, muy por debajo de 500).

> **Importante:** corré la sincronización **antes** de que tus amigos empiecen a
> cargar pronósticos, así los partidos quedan con su ID definitivo.

---

## Probarlo localmente
Como usa módulos ES, abrilo con un servidor (no con doble clic):
```bash
npx serve .
# o la extensión "Live Server" de VS Code
```

## ¿No querés la sincronización automática?
Podés saltarte el paso 4. El **admin** carga los resultados a mano desde la
pestaña Admin (y ahí mismo edita los equipos de cada grupo según el sorteo).

## Alternativas de API
Si football-data.org no te da el Mundial en el plan gratis:
- **API-Football** (api-sports.io) — 100 pedidos/día gratis, incluye Mundial.
- **TheSportsDB** — gratis.

Ambas devuelven JSON similar; solo hay que ajustar `fetchMatches()` y `mapMatch()`
en `scripts/sync.mjs` (los campos: id, fecha, etapa, equipos, marcador).

## Estructura
```
index.html              UI
css/styles.css          estilos
js/config.js            ← acá van tu URL y anon key de Supabase
js/app.js               lógica (login, pronósticos, ranking, admin)
supabase/schema.sql     base de datos completa (correr una vez)
scripts/sync.mjs        sincronizador de resultados
.github/workflows/      cron diario de GitHub Actions
```

## Seguridad (resumen honesto)
Es un prode entre amigos, no un banco. Aun así:
- Las tablas están cerradas a escritura directa (RLS *deny-all*); todo pasa por
  funciones RPC que validan PIN/token del lado del servidor.
- Los PIN se guardan **hasheados** (bcrypt), nunca en texto plano.
- El login por código de grupo + PIN evita que se pisen los pronósticos, pero
  cualquiera con el código del grupo puede registrarse: compartilo solo con tus amigos.
