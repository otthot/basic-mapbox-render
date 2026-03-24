# SønSpot — Shadow Engine Prototype
**PRD v0.1 · March 2026**

---

## Problem

SønSpot helps people find sunny outdoor spots in Copenhagen. To do that well, the app needs to know whether a specific location is in sun or shadow at a given time of day — accounting for surrounding buildings. ShadeMap solves this but is WebGL/browser-only and cannot run in React Native.

---

## Goal

Build a working shadow engine that runs on-device in React Native, scoped to Copenhagen, that can tell us: **is this outdoor spot in sun or shadow right now?**

---

## Approach

Two-stage pipeline:

**Stage 1 — Offline bake (server/dev machine, runs once)**
Download raw LiDAR DSM tiles from SDFE (Denmark's free national geodata service) for Copenhagen. Process and encode them as lightweight height-encoded PNG tiles (~2m/pixel resolution). Store in Supabase or serve as static assets.

**Stage 2 — On-device realtime computation**
When a user taps a spot on the map, load the small DSM tile for that area (256×256px covering ~500×500m). Compute sun position for the current datetime using SunCalc. Ray march across the height grid to determine which pixels are in shadow. Render the result as a canvas overlay on the Mapbox map.

The grid is small enough (~65k pixels) that the ray march runs fast on-device in JS without needing a GPU.

---

## Scope (Prototype)

| Feature | In scope |
|---|---|
| Single neighborhood (Nørrebro, ~500×500m) | ✅ |
| Shadow at a single point in time | ✅ |
| Time slider to scrub through the day | ✅ |
| Real SDFE LiDAR DSM data | ✅ |
| Mapbox map with shadow canvas overlay | ✅ |
| Sun position dial + azimuth/altitude stats | ✅ |
| React Native integration | ❌ later |
| Multiple neighborhoods / full CPH | ❌ later |
| Accumulated sun hours view | ❌ later |
| Trees as shadow casters | ❌ later |

---

## Data

**Height data:** SDFE `dhm_overflade` (Digital Surface Model) via WCS endpoint at `api.dataforsyningen.dk`. Free, no auth. Covers all of Denmark at 0.4m resolution. Buildings and trees are baked in. Output encoded as Terrarium-style RGBA PNG.

**Sun position:** SunCalc library. Input: lat/lng + datetime. Output: azimuth + altitude in radians.

---

## Core Algorithm

For each pixel in the DSM grid:
1. Get the sun's azimuth and altitude for the current time at Copenhagen's coordinates
2. Cast a ray from that pixel toward the sun across the height grid
3. At each step along the ray, check if the terrain/building height exceeds the height the sun ray would be at that distance
4. If anything blocks the ray → pixel is in shadow

One ray march per pixel, fully parallelisable, no dependencies.

---

## Success Criteria

- Shadow overlay visually matches expected building shadows for a known Copenhagen location and time
- Full 256×256 grid computes in under 100ms on a mid-range device
- Swapping synthetic DSM for real SDFE data requires no code changes

---

## What You Need to Run It

- Node.js to run `prepare-dsm.js` (fetches + encodes the SDFE tile)
- Mapbox API token for the map layer
- `npm install geotiff sharp suncalc` for the bake script