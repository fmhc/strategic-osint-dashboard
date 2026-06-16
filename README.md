# 🎯 Strategic OSINT Dashboard

A real-time, self-hostable **OSINT (Open-Source Intelligence) dashboard** that renders
geopolitical and natural-event signals on an interactive 3D globe. It aggregates
~25 free/public data sources (flights, vessels, seismic activity, disasters, cyber
threats, internet health, weather, space weather, news…) and can run an optional
LLM analyst over the live situation.

Backend: Node.js + Express + Socket.IO. Frontend: a self-hosted **CesiumJS** WebGL globe.
Optional Prometheus + Grafana for metrics.

![status](https://img.shields.io/badge/status-operational-brightgreen)
![license](https://img.shields.io/badge/license-MIT-blue)

---

## Features

- **3D globe** (CesiumJS) with render-on-demand, in-place entity updates, and
  billboard clustering for dense regions.
- **~25 data-source modules**, auto-discovered from `modules/` — e.g.
  - ✈️ Flight tracking (OpenSky), 🚢 AIS vessels (AISStream), 🌍 seismic (USGS + EMSC)
  - 🌋 disasters (GDACS), 🛰️ NASA EONET natural events, 🔥 NASA FIRMS heat signatures
  - 💻 cyber (CISA KEV exploited CVEs), 🌐 internet health / IXPs / submarine cables
  - 🌤️ weather, 🌌 space weather, ☢️ radiation, 📰 news (RSS), and more
- **Optional LLM analyst** — produces a situation assessment + per-entity intel via
  any **OpenAI-compatible** endpoint (OpenAI, vLLM, LiteLLM, LM Studio, …) or Ollama.
- **Alerts feed**, threat-level scoring, and a per-module **`/healthz`** endpoint.
- **Prometheus metrics** at `/metrics`, optional Grafana dashboards.
- Graceful degradation: a dead/rate-limited source never takes down the rest.

> Most sources are free and need no key. A few optional ones (AISStream, OpenSky auth)
> use a free API key for higher quotas — see `.env.example`.

---

## Quick start

```bash
# 1. install deps
npm install

# 2. vendor CesiumJS locally (offline, no CDN) — ~20 MB into public/vendor/cesium
npm run setup:cesium

# 3. configure (all values optional; sane defaults apply)
cp .env.example .env
$EDITOR .env

# 4. run
npm start          # → http://localhost:3333
```

Open **http://localhost:3333**.

### Docker

```bash
cp .env.example .env
docker compose up -d        # backend :3333, Grafana :3001, Prometheus :9091
```

The Cesium build is fetched automatically during the image build.

---

## Configuration

All configuration is via environment variables (see **`.env.example`**):

| Var | Purpose |
|-----|---------|
| `PORT` | HTTP port (default `3333`) |
| `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL` | OpenAI-compatible LLM endpoint for the analyst (optional) |
| `LLM_MODEL_FAST` | optional cheaper model for high-volume per-entity analysis |
| `OLLAMA_URL`, `OLLAMA_MODEL` | fallback used when `LLM_BASE_URL` is unset |
| `AISSTREAM_API_KEY` | free key for live AIS ship tracking |
| `OPENSKY_USER` / `OPENSKY_PASS` | optional, raises the OpenSky free-tier quota |
| `ALLOWED_ORIGINS` | comma-separated CORS allowlist (empty = open) |

The LLM is **optional** — without it the dashboard runs fine; the AI panel just stays empty.

---

## HTTP endpoints

| Route | Description |
|-------|-------------|
| `/` | the dashboard |
| `/api/state` | full current global state (all modules) |
| `/api/status` | module registry + counts |
| `/api/<module>` | per-module data |
| `/health` | liveness (uptime, memory, module counts) |
| `/healthz` | per-module health (last update, staleness, errors) |
| `/metrics` | Prometheus metrics |

---

## Architecture

```
server.js             Express + Socket.IO, cron scheduler, global state, routes
modules/loader.js     auto-discovers modules/, schedules updates, broadcasts deltas
modules/*.js          one data source each (return data via a detected update method)
modules/llm-client.js shared OpenAI-compatible / Ollama client
public/               the Cesium frontend (index.html, app.js, styles.css)
public/vendor/cesium  self-hosted CesiumJS (gitignored; run npm run setup:cesium)
test/smoke.js         boot + endpoint smoke test (npm test)
```

Adding a data source = drop a `modules/<name>.js` exporting an instance with an
`update()` (or similar) method returning data; the loader registers it, exposes
`/api/<name>`, and broadcasts updates automatically.

---

## Development

```bash
npm run dev     # nodemon
npm test        # smoke test: node --check all modules + boot + assert endpoints
```

---

## License

MIT — see [LICENSE](LICENSE).

Built on free/public data sources and open-source libraries (CesiumJS, Express,
Socket.IO, prom-client, …). Respect each upstream provider's terms and rate limits.
