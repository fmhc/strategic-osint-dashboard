# Development History

A rough, high-level timeline of the project. Dates are approximate (month granularity).

## 2026-01 — Initial dashboard
- First version: a CesiumJS 3D globe with a real-time backend (Express + Socket.IO).
- Core OSINT data-source modules: flight tracking, marine/AIS vessels, seismic
  (USGS/EMSC), signals & GPS-jamming, news (RSS), NASA FIRMS heat signatures,
  weather, space weather, radiation, internet health / IXPs / submarine cables /
  offshore platforms, satellite imagery, pizza index.
- Prometheus metrics + Grafana dashboards; Docker setup.

## 2026-02 — Modular architecture
- Introduced an `OsintModule` base class + an auto-loader (legacy-compatible) so
  each data source is a self-contained module discovered at startup.
- Slimmed down `server.js` to use the loader; migrated the first modules.

## 2026-03 — Stabilization
- Hardened the loader's legacy method detection; assorted fixes.

## 2026-06 — Major upgrade pass
- **LLM analyst**: optional situation assessment + per-entity intel via any
  OpenAI-compatible endpoint (JSON-mode output, standard/fast model tiers,
  per-entity dedup); graceful fallback when no LLM is configured.
- **New data sources**: CISA KEV (actively-exploited CVEs), GDACS disaster
  alerts, NASA EONET natural events.
- **Robustness**: per-source graceful degradation (`Promise.allSettled`), AIS
  WebSocket heartbeat, polling backoff + caching (OpenSky / GDELT / ADS-B),
  retirement of dead sources, bounded in-memory state, log rotation.
- **Performance & 3D**: render-on-demand, in-place entity updates, billboard
  clustering, symbol/material caching, debounced socket re-renders, deferred
  script loading, far-side globe occlusion.
- **Self-hosted CesiumJS** (offline, no CDN dependency).
- **Observability**: `/healthz` per-module health, Prometheus metrics for the new
  modules, and a fix for the `/metrics` endpoint.
- **Security**: configurable CORS allowlist.
- **Developer experience**: smoke test (`npm test`), `.env.example`,
  Docker/Prometheus config sync, documentation refresh.

---

_This is a condensed overview, not a per-commit log._
