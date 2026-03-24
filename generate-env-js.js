#!/usr/bin/env node
/**
 * generate-env-js.js
 * Reads MAPBOX_TOKEN from .env and writes public/env.js for the browser.
 * Run this once before serving: node generate-env-js.js
 */
const fs = require("fs");
const path = require("path");

const envPath = path.join(__dirname, ".env");
const outPath = path.join(__dirname, "public", "env.js");

if (!fs.existsSync(envPath)) {
  console.error("No .env file found. Create one with MAPBOX_TOKEN=<your token>");
  process.exit(1);
}

const raw = fs.readFileSync(envPath, "utf8");
let token = "";
for (const line of raw.split("\n")) {
  const m = line.match(/^MAPBOX_TOKEN\s*=\s*(.+)$/);
  if (m) token = m[1].trim();
}

if (!token) {
  console.error("MAPBOX_TOKEN not found in .env");
  process.exit(1);
}

if (!fs.existsSync(path.dirname(outPath))) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
}

fs.writeFileSync(outPath, `window.MAPBOX_TOKEN = "${token}";\n`);
console.log(`Wrote public/env.js with token ${token.slice(0, 12)}…`);
