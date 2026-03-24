#!/usr/bin/env node
/**
 * prepare-dsm.js
 * Fetches a DSM tile from SDFE (Danmarks Højdemodel - Overflade) via WCS
 * for a ~500x500m area in Nørrebro, Copenhagen, then encodes it as a
 * Terrarium-style RGBA PNG for use in the shadow engine.
 *
 * Usage: node prepare-dsm.js
 * Output: public/dsm-norrebro.png + public/dsm-meta.json
 *
 * Requires: npm install geotiff sharp
 */

const fs = require("fs");
const path = require("path");
const https = require("https");

// ---------------------------------------------------------------------------
// Area of interest: Nørrebro centre, ~500×500 m
// EPSG:25832 bounding box (UTM zone 32N)
// ---------------------------------------------------------------------------
const BBOX = {
  minX: 723407,
  minY: 6177237,
  maxX: 723907,
  maxY: 6177737,
};
const RESOLUTION = 2; // metres per pixel → 250×250 px output
const WIDTH = Math.round((BBOX.maxX - BBOX.minX) / RESOLUTION);
const HEIGHT = Math.round((BBOX.maxY - BBOX.minY) / RESOLUTION);

// Centre of tile in WGS84 (used by shadow engine for sun calc)
const CENTER_LAT = 55.69151222577356;
const CENTER_LNG = 12.558648339901735;

// ---------------------------------------------------------------------------
// Datafordeler WCS endpoint for DHM/Overflade (DSM)
// Requires a free account at datafordeler.dk → "IT-system" credentials
// Add to .env:
//   DATAFORDELER_USERNAME=XXX
//   DATAFORDELER_PASSWORD=YYY
// ---------------------------------------------------------------------------
function getEnv(key) {
  const envPath = path.join(__dirname, ".env");
  if (!fs.existsSync(envPath)) return "";
  const raw = fs.readFileSync(envPath, "utf8");
  for (const line of raw.split("\n")) {
    const m = line.match(new RegExp(`^${key}\\s*=\\s*(.+)$`));
    if (m) return m[1].trim();
  }
  return "";
}

const DF_TOKEN = getEnv("DATAFORSYNING_TOKEN");

function buildWcsUrl() {
  if (!DF_TOKEN) {
    return null; // no credentials — will use synthetic fallback
  }
  return (
    `https://api.dataforsyningen.dk/dhm_wcs_DAF` +
    `?token=${encodeURIComponent(DF_TOKEN)}` +
    `&SERVICE=WCS&VERSION=1.0.0&REQUEST=GetCoverage` +
    `&COVERAGE=dhm_overflade` +
    `&CRS=EPSG:25832` +
    `&BBOX=${BBOX.minX},${BBOX.minY},${BBOX.maxX},${BBOX.maxY}` +
    `&WIDTH=${WIDTH}&HEIGHT=${HEIGHT}` +
    `&FORMAT=GTiff`
  );
}

const WCS_URL = buildWcsUrl();

const OUT_DIR = path.join(__dirname, "public");
const TIFF_PATH = path.join(OUT_DIR, "dsm-norrebro.tiff");
const PNG_PATH = path.join(OUT_DIR, "dsm-norrebro.png");
const META_PATH = path.join(OUT_DIR, "dsm-meta.json");

async function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https
      .get(url, (res) => {
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} for ${url}`));
          return;
        }
        res.pipe(file);
        file.on("finish", () => file.close(resolve));
      })
      .on("error", reject);
  });
}

async function encodeTerrariumPng(tiffPath, pngPath) {
  const { fromFile } = require("geotiff");
  const sharp = require("sharp");

  const tiff = await fromFile(tiffPath);
  const image = await tiff.getImage();
  const rasters = await image.readRasters();
  const band = rasters[0]; // Float32Array, one value per pixel
  const w = image.getWidth();
  const h = image.getHeight();

  // Find range for stats
  let min = Infinity,
    max = -Infinity;
  for (let i = 0; i < band.length; i++) {
    if (band[i] < min) min = band[i];
    if (band[i] > max) max = band[i];
  }
  console.log(`  Height range: ${min.toFixed(2)}m – ${max.toFixed(2)}m`);

  // Encode as Terrarium RGBA:
  //   height_m = (R * 256 + G + B / 256) - 32768
  const rgba = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const h_m = band[i] + 32768; // shift to positive
    const r = Math.floor(h_m / 256) & 0xff;
    const g = Math.floor(h_m) & 0xff;
    const b = Math.floor((h_m % 1) * 256) & 0xff;
    rgba[i * 4 + 0] = r;
    rgba[i * 4 + 1] = g;
    rgba[i * 4 + 2] = b;
    rgba[i * 4 + 3] = 255;
  }

  await sharp(rgba, { raw: { width: w, height: h, channels: 4 } })
    .png()
    .toFile(pngPath);

  return { width: w, height: h, minHeight: min, maxHeight: max };
}

async function main() {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

  console.log("Fetching DSM tile from Datafordeler (DHM/Overflade)…");
  console.log(`  Area: ${WIDTH}×${HEIGHT} px @ ${RESOLUTION}m/px`);

  let usedReal = false;
  if (!WCS_URL) {
    console.log("\n  No DATAFORSYNING_API_TOKEN in .env");
    console.log("  → Get a token at https://dataforsyningen.dk → Min profil → API-nøgler");
    console.log("  → Add to .env: DATAFORSYNING_TOKEN=XXX");
    console.log("  → Falling back to synthetic DSM for now…\n");
    generateSyntheticDsm(TIFF_PATH, WIDTH, HEIGHT);
  } else {
    console.log(`  URL: ${WCS_URL.replace(/password=[^&]+/, "password=***")}\n`);
    try {
      await downloadFile(WCS_URL, TIFF_PATH);
      console.log(`  Downloaded → ${TIFF_PATH}`);
      usedReal = true;
    } catch (err) {
      console.error("  Download failed:", err.message);
      console.log("\n  Falling back to synthetic DSM for development…");
      generateSyntheticDsm(TIFF_PATH, WIDTH, HEIGHT);
    }
  }
  void usedReal;

  console.log("Encoding Terrarium PNG…");
  let meta;
  try {
    meta = await encodeTerrariumPng(TIFF_PATH, PNG_PATH);
  } catch (err) {
    console.error("  GeoTIFF encode failed (may be synthetic):", err.message);
    console.log("  Generating synthetic PNG directly…");
    meta = await generateSyntheticPng(PNG_PATH, WIDTH, HEIGHT);
  }

  const metaJson = {
    width: meta.width,
    height: meta.height,
    metersPerPixel: RESOLUTION,
    bbox: BBOX,
    centerLat: CENTER_LAT,
    centerLng: CENTER_LNG,
    minHeight: meta.minHeight,
    maxHeight: meta.maxHeight,
    encoding: "terrarium",
  };
  fs.writeFileSync(META_PATH, JSON.stringify(metaJson, null, 2));

  console.log(`\nDone!`);
  console.log(`  PNG  → ${PNG_PATH}`);
  console.log(`  Meta → ${META_PATH}`);
  console.log(`  Size: ${meta.width}×${meta.height} px`);
}

/**
 * Generates a synthetic GeoTIFF-like buffer (raw floats) simulating
 * Nørrebro building heights. Used as fallback if SDFE is unavailable.
 */
function generateSyntheticDsm(outPath, w, h) {
  // We write a raw binary that geotiff can't read — the catch block in main
  // will trigger generateSyntheticPng instead.
  fs.writeFileSync(outPath, Buffer.from("SYNTHETIC"));
}

async function generateSyntheticPng(pngPath, w, h) {
  const sharp = require("sharp");
  const rgba = Buffer.alloc(w * h * 4);

  // Base ground: ~5m
  // Scatter rectangular "buildings" of 10–25m height
  const heightGrid = new Float32Array(w * h).fill(5.0);

  const buildings = [
    { x: 20, y: 20, w: 40, h: 30, height: 18 },
    { x: 80, y: 10, w: 50, h: 40, height: 22 },
    { x: 150, y: 50, w: 35, h: 45, height: 15 },
    { x: 30, y: 100, w: 60, h: 35, height: 20 },
    { x: 110, y: 120, w: 45, h: 50, height: 25 },
    { x: 180, y: 100, w: 55, h: 40, height: 18 },
    { x: 50, y: 170, w: 70, h: 30, height: 22 },
    { x: 140, y: 180, w: 40, h: 55, height: 16 },
    { x: 200, y: 170, w: 35, h: 45, height: 20 },
    { x: 10, y: 200, w: 50, h: 40, height: 24 },
    { x: 100, y: 210, w: 65, h: 35, height: 19 },
    { x: 185, y: 220, w: 50, h: 25, height: 21 },
  ];

  for (const b of buildings) {
    for (let py = b.y; py < Math.min(b.y + b.h, h); py++) {
      for (let px = b.x; px < Math.min(b.x + b.w, w); px++) {
        heightGrid[py * w + px] = b.height;
      }
    }
  }

  let min = Infinity,
    max = -Infinity;
  for (let i = 0; i < heightGrid.length; i++) {
    if (heightGrid[i] < min) min = heightGrid[i];
    if (heightGrid[i] > max) max = heightGrid[i];
  }

  for (let i = 0; i < w * h; i++) {
    const hm = heightGrid[i] + 32768;
    rgba[i * 4 + 0] = Math.floor(hm / 256) & 0xff;
    rgba[i * 4 + 1] = Math.floor(hm) & 0xff;
    rgba[i * 4 + 2] = Math.floor((hm % 1) * 256) & 0xff;
    rgba[i * 4 + 3] = 255;
  }

  await sharp(rgba, { raw: { width: w, height: h, channels: 4 } })
    .png()
    .toFile(pngPath);

  console.log(`  Generated synthetic DSM: ${w}×${h} px`);
  return { width: w, height: h, minHeight: min, maxHeight: max };
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
