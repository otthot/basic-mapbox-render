# AGENTS.md

## Cursor Cloud specific instructions

### Overview

SønSpot is a shadow engine prototype for Copenhagen. It's a single-page static web app that computes real-time building shadow overlays on a Mapbox map using LiDAR DSM data.

### Services

| Service | Command | Port |
|---|---|---|
| Dev server (static HTTP) | `npm run dev` | 3000 |

### Required secrets

- `MAPBOX_TOKEN` — Mapbox API token. Must be written to `.env` as `MAPBOX_TOKEN=<value>`, then run `node generate-env-js.js` to produce `public/env.js` before the browser app will work.

### Startup caveats

- Before starting the dev server, you must generate `public/env.js` from the `MAPBOX_TOKEN` environment variable:
  ```
  echo "MAPBOX_TOKEN=$MAPBOX_TOKEN" > .env
  node generate-env-js.js
  ```
- DSM data (`public/dsm-norrebro.png` + `public/dsm-meta.json`) is pre-committed. You only need to re-run `npm run prepare-dsm` if refreshing the height data. Without a `DATAFORSYNING_TOKEN` in `.env`, the script falls back to synthetic data.
- The Mapbox base map requires internet access to load tiles from `api.mapbox.com`. Shadow computation works independently of the map tiles loading.
- There are no lint, test, or build commands configured in `package.json`. The project is a prototype with only `dev` and `prepare-dsm` scripts.
