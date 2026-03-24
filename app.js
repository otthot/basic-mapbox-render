// app.js — SønSpot Shadow Engine Prototype
// Reads MAPBOX_TOKEN from window.MAPBOX_TOKEN (injected by env.js)
// or falls back to the hardcoded placeholder.

(async function () {
  // -------------------------------------------------------------------------
  // Config
  // -------------------------------------------------------------------------
  const CENTER_LAT = 55.69151222577356;
  const CENTER_LNG = 12.558648339901735;
  const DSM_URL = "public/dsm-norrebro.png";
  const META_URL = "public/dsm-meta.json";

  // -------------------------------------------------------------------------
  // Mapbox init
  // -------------------------------------------------------------------------
  const token =
    window.MAPBOX_TOKEN || "pk.eyJ1IjoicGxhY2Vob2xkZXIiLCJhIjoiIn0.placeholder";
  mapboxgl.accessToken = token;

  const map = new mapboxgl.Map({
    container: "map",
    style: "mapbox://styles/mapbox/light-v11",
    center: [CENTER_LNG, CENTER_LAT],
    zoom: 16.5,
    pitch: 0,
  });

  map.addControl(new mapboxgl.NavigationControl(), "top-right");

  // -------------------------------------------------------------------------
  // DSM state
  // -------------------------------------------------------------------------
  let dsmPixels = null; // Uint8ClampedArray RGBA
  let dsmMeta = null;

  // -------------------------------------------------------------------------
  // Shadow canvas — sized to map container, redrawn on map move/resize
  // -------------------------------------------------------------------------
  const shadowCanvas = document.getElementById("shadow-canvas");
  const shadowCtx = shadowCanvas.getContext("2d");

  function resizeShadowCanvas() {
    const wrap = document.getElementById("map-wrap");
    const w = wrap.clientWidth;
    const h = wrap.clientHeight;
    if (shadowCanvas.width !== w || shadowCanvas.height !== h) {
      shadowCanvas.width = w;
      shadowCanvas.height = h;
    }
  }

  window.addEventListener("resize", () => {
    resizeShadowCanvas();
    if (dsmPixels) renderShadowOverlay();
  });

  map.on("load", resizeShadowCanvas);
  map.on("move", () => { if (dsmPixels) renderShadowOverlay(); });
  map.on("zoom", () => { if (dsmPixels) renderShadowOverlay(); });

  // -------------------------------------------------------------------------
  // Time slider
  // -------------------------------------------------------------------------
  const slider = document.getElementById("time-slider");
  const timeDisplay = document.getElementById("time-display");

  function minutesToDate(minutes) {
    const now = new Date();
    now.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0);
    return now;
  }

  function formatTime(minutes) {
    const h = String(Math.floor(minutes / 60)).padStart(2, "0");
    const m = String(minutes % 60).padStart(2, "0");
    return `${h}:${m}`;
  }

  slider.addEventListener("input", () => {
    timeDisplay.textContent = formatTime(Number(slider.value));
    updateSunDial();
    if (dsmPixels) renderShadowOverlay();
  });

  // -------------------------------------------------------------------------
  // Sun dial
  // -------------------------------------------------------------------------
  const dialCanvas = document.getElementById("sun-dial");
  const dialCtx = dialCanvas.getContext("2d");
  const statAz = document.getElementById("stat-az");
  const statAlt = document.getElementById("stat-alt");

  function getSunPosition(minutes) {
    const date = minutesToDate(minutes);
    return SunCalc.getPosition(date, CENTER_LAT, CENTER_LNG);
  }

  function updateSunDial() {
    const pos = getSunPosition(Number(slider.value));
    const azDeg = ((pos.azimuth * 180) / Math.PI + 180) % 360;
    const altDeg = (pos.altitude * 180) / Math.PI;

    statAz.textContent = `${azDeg.toFixed(0)}°`;
    statAlt.textContent = `${altDeg.toFixed(1)}°`;

    // Draw dial
    const cx = 32, cy = 32, r = 26;
    dialCtx.clearRect(0, 0, 64, 64);

    // Background circle
    dialCtx.beginPath();
    dialCtx.arc(cx, cy, r, 0, Math.PI * 2);
    dialCtx.fillStyle = "#2a2a2a";
    dialCtx.fill();
    dialCtx.strokeStyle = "#444";
    dialCtx.lineWidth = 1;
    dialCtx.stroke();

    // Cardinal ticks
    dialCtx.fillStyle = "#555";
    dialCtx.font = "7px sans-serif";
    dialCtx.textAlign = "center";
    dialCtx.textBaseline = "middle";
    dialCtx.fillText("N", cx, cy - r + 7);
    dialCtx.fillText("S", cx, cy + r - 7);
    dialCtx.fillText("E", cx + r - 7, cy);
    dialCtx.fillText("W", cx - r + 7, cy);

    // Sun direction arrow
    const rad = (azDeg - 90) * (Math.PI / 180);
    const sunX = cx + Math.cos(rad) * (r - 6);
    const sunY = cy + Math.sin(rad) * (r - 6);

    dialCtx.beginPath();
    dialCtx.moveTo(cx, cy);
    dialCtx.lineTo(sunX, sunY);
    dialCtx.strokeStyle = altDeg > 0 ? "#f0c040" : "#444";
    dialCtx.lineWidth = 2;
    dialCtx.stroke();

    // Sun dot
    dialCtx.beginPath();
    dialCtx.arc(sunX, sunY, 4, 0, Math.PI * 2);
    dialCtx.fillStyle = altDeg > 0 ? "#f0c040" : "#444";
    dialCtx.fill();
  }

  // -------------------------------------------------------------------------
  // DSM loading
  // -------------------------------------------------------------------------
  async function loadDsm() {
    setStatus("Loading DSM…");
    try {
      const [metaRes, imgEl] = await Promise.all([
        fetch(META_URL),
        loadImage(DSM_URL),
      ]);

      if (!metaRes.ok) throw new Error(`Meta fetch failed: ${metaRes.status}`);
      dsmMeta = await metaRes.json();

      // Read pixels from DSM image via offscreen canvas
      const offscreen = document.createElement("canvas");
      offscreen.width = dsmMeta.width;
      offscreen.height = dsmMeta.height;
      const ctx = offscreen.getContext("2d");
      ctx.drawImage(imgEl, 0, 0);
      dsmPixels = ctx.getImageData(0, 0, dsmMeta.width, dsmMeta.height).data;

      setStatus(`DSM loaded (${dsmMeta.width}×${dsmMeta.height} px, ${dsmMeta.metersPerPixel}m/px)`);
      document.getElementById("compute-btn").disabled = false;
      renderShadowOverlay();
    } catch (err) {
      setStatus(`DSM not found — run: node prepare-dsm.js  (${err.message})`);
    }
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error(`Image load failed: ${src}`));
      img.src = src;
    });
  }

  // -------------------------------------------------------------------------
  // Terrarium decode
  // -------------------------------------------------------------------------
  function decodeHeight(r, g, b) {
    return r * 256 + g + b / 256 - 32768;
  }

  function getDsmHeight(x, y) {
    if (x < 0 || y < 0 || x >= dsmMeta.width || y >= dsmMeta.height) return 0;
    const idx = (y * dsmMeta.width + x) * 4;
    return decodeHeight(dsmPixels[idx], dsmPixels[idx + 1], dsmPixels[idx + 2]);
  }

  // -------------------------------------------------------------------------
  // Ray-march shadow computation
  // Returns a Uint8ClampedArray of alpha values (0=sun, 200=shadow)
  // -------------------------------------------------------------------------
  function computeShadows(azimuthRad, altitudeRad) {
    const w = dsmMeta.width;
    const h = dsmMeta.height;
    const result = new Uint8ClampedArray(w * h); // 0 = lit, 1 = shadow

    if (altitudeRad <= 0) {
      // Sun below horizon — everything in shadow
      result.fill(1);
      return result;
    }

    const mpp = dsmMeta.metersPerPixel;

    // Sun direction in pixel space:
    // azimuth 0 = North (+Y in UTM), increases clockwise
    // Map azimuth to dx/dy in pixel coords (Y axis flipped: row 0 = North)
    const az = azimuthRad; // radians from north, clockwise
    const sunDx = Math.sin(az); // east component → +col
    const sunDy = -Math.cos(az); // north component → -row (rows increase southward)

    // Tangent of elevation angle: height gained per horizontal metre
    const tanAlt = Math.tan(altitudeRad);

    // Step size (pixels)
    const STEP = 0.5;
    const stepX = sunDx * STEP;
    const stepY = sunDy * STEP;
    const stepDist = STEP * mpp; // horizontal distance per step (metres)
    const heightGainPerStep = tanAlt * stepDist;

    const t0 = performance.now();

    for (let row = 0; row < h; row++) {
      for (let col = 0; col < w; col++) {
        const baseHeight = getDsmHeight(col, row);
        let px = col;
        let py = row;
        let rayHeight = baseHeight;
        let inShadow = false;

        // March from this pixel toward the sun until we leave the grid
        for (let step = 1; step < 512; step++) {
          px += stepX;
          py += stepY;
          rayHeight += heightGainPerStep;

          const ix = Math.round(px);
          const iy = Math.round(py);

          if (ix < 0 || iy < 0 || ix >= w || iy >= h) break;

          const terrainH = getDsmHeight(ix, iy);
          if (terrainH > rayHeight) {
            inShadow = true;
            break;
          }
        }

        result[row * w + col] = inShadow ? 1 : 0;
      }
    }

    const dt = performance.now() - t0;
    setStatus(`Computed in ${dt.toFixed(0)}ms`);
    return result;
  }

  // -------------------------------------------------------------------------
  // Project geo → screen pixel
  // -------------------------------------------------------------------------
  function geoToScreen(lng, lat) {
    return map.project([lng, lat]);
  }

  // Convert DSM pixel index to geographic coordinate
  function dsmPixelToGeo(col, row) {
    const { bbox, width, height } = dsmMeta;
    // EPSG:25832 UTM → approximate WGS84 using linear interpolation
    // (accurate enough for ~500m tile at Copenhagen's latitude)
    const utmX = bbox.minX + (col / (width - 1)) * (bbox.maxX - bbox.minX);
    const utmY = bbox.maxY - (row / (height - 1)) * (bbox.maxY - bbox.minY); // rows from top

    // Rough UTM32N → WGS84 for Copenhagen (error < 1m over 500m)
    const { lat, lng } = utm32nToWgs84(utmX, utmY);
    return { lat, lng };
  }

  // Approximate UTM zone 32N → WGS84 (valid for Copenhagen area)
  function utm32nToWgs84(x, y) {
    // Central meridian 9° for zone 32
    const a = 6378137.0;
    const f = 1 / 298.257223563;
    const b = a * (1 - f);
    const e2 = 1 - (b * b) / (a * a);
    const e1 = (1 - Math.sqrt(1 - e2)) / (1 + Math.sqrt(1 - e2));
    const k0 = 0.9996;
    const E0 = 500000;
    const N0 = 0;
    const lon0 = 9 * (Math.PI / 180);

    const xp = x - E0;
    const yp = y - N0;
    const M = yp / k0;
    const mu =
      M /
      (a *
        (1 -
          e2 / 4 -
          (3 * e2 * e2) / 64 -
          (5 * e2 * e2 * e2) / 256));

    const p1 =
      mu +
      ((3 * e1) / 2 - (27 * e1 * e1 * e1) / 32) * Math.sin(2 * mu);
    const p2 =
      p1 +
      ((21 * e1 * e1) / 16 - (55 * e1 * e1 * e1 * e1) / 32) *
        Math.sin(4 * mu);
    const p3 =
      p2 + ((151 * e1 * e1 * e1) / 96) * Math.sin(6 * mu);
    const phi1 = p3;

    const N1 = a / Math.sqrt(1 - e2 * Math.sin(phi1) * Math.sin(phi1));
    const T1 = Math.tan(phi1) * Math.tan(phi1);
    const C1 = (e2 / (1 - e2)) * Math.cos(phi1) * Math.cos(phi1);
    const R1 =
      (a * (1 - e2)) /
      Math.pow(1 - e2 * Math.sin(phi1) * Math.sin(phi1), 1.5);
    const D = xp / (N1 * k0);

    const latRad =
      phi1 -
      ((N1 * Math.tan(phi1)) / R1) *
        (D * D / 2 -
          ((5 + 3 * T1 + 10 * C1 - 4 * C1 * C1 - 9 * (e2 / (1 - e2))) *
            D * D * D * D) /
            24);

    const lonRad =
      lon0 +
      (D -
        ((1 + 2 * T1 + C1) * D * D * D) / 6) /
        Math.cos(phi1);

    return { lat: latRad * (180 / Math.PI), lng: lonRad * (180 / Math.PI) };
  }

  // -------------------------------------------------------------------------
  // Render shadow overlay onto the canvas using the map's current viewport
  // -------------------------------------------------------------------------
  function renderShadowOverlay() {
    if (!dsmPixels || !dsmMeta) return;

    const minutes = Number(slider.value);
    const sunPos = getSunPosition(minutes);
    const shadows = computeShadows(sunPos.azimuth, sunPos.altitude);

    const cw = shadowCanvas.width;
    const ch = shadowCanvas.height;

    const imageData = shadowCtx.createImageData(cw, ch);
    const data = imageData.data;

    const dw = dsmMeta.width;
    const dh = dsmMeta.height;

    // Project the four corners of the DSM tile to screen space
    const corners = [
      dsmPixelToGeo(0, 0),
      dsmPixelToGeo(dw - 1, 0),
      dsmPixelToGeo(dw - 1, dh - 1),
      dsmPixelToGeo(0, dh - 1),
    ].map((c) => geoToScreen(c.lng, c.lat));

    // Bounding screen rect of the DSM
    const minSX = Math.min(...corners.map((c) => c.x));
    const maxSX = Math.max(...corners.map((c) => c.x));
    const minSY = Math.min(...corners.map((c) => c.y));
    const maxSY = Math.max(...corners.map((c) => c.y));

    const scaleX = (maxSX - minSX) / dw;
    const scaleY = (maxSY - minSY) / dh;

    console.log(`DSM screen bounds: x=${minSX.toFixed(0)}–${maxSX.toFixed(0)}, y=${minSY.toFixed(0)}–${maxSY.toFixed(0)}, canvas=${cw}×${ch}`);

    // Clear previous frame
    shadowCtx.clearRect(0, 0, cw, ch);

    // Paint every DSM pixel:
    //   lit   → warm yellow tint  (so it's visible on dark map)
    //   shadow → dark navy overlay
    for (let sy = Math.max(0, Math.floor(minSY)); sy < Math.min(ch, Math.ceil(maxSY)); sy++) {
      for (let sx = Math.max(0, Math.floor(minSX)); sx < Math.min(cw, Math.ceil(maxSX)); sx++) {
        const dx = Math.round((sx - minSX) / scaleX);
        const dy = Math.round((sy - minSY) / scaleY);
        if (dx < 0 || dy < 0 || dx >= dw || dy >= dh) continue;

        const inShadow = shadows[dy * dw + dx];
        const idx = (sy * cw + sx) * 4;
        if (inShadow) {
          // shadow: dark semi-transparent blue
          data[idx + 0] = 10;
          data[idx + 1] = 10;
          data[idx + 2] = 40;
          data[idx + 3] = 170;
        } else {
          // sunlit: warm yellow tint
          data[idx + 0] = 255;
          data[idx + 1] = 220;
          data[idx + 2] = 80;
          data[idx + 3] = 60;
        }
      }
    }

    shadowCtx.putImageData(imageData, 0, 0);

    // Debug: draw red border around DSM tile so we can confirm placement
    shadowCtx.strokeStyle = "red";
    shadowCtx.lineWidth = 2;
    shadowCtx.strokeRect(minSX, minSY, maxSX - minSX, maxSY - minSY);

    updateSunDial();
  }

  // -------------------------------------------------------------------------
  // Status helper
  // -------------------------------------------------------------------------
  function setStatus(msg) {
    document.getElementById("status").textContent = msg;
  }

  // -------------------------------------------------------------------------
  // Compute button
  // -------------------------------------------------------------------------
  const computeBtn = document.getElementById("compute-btn");
  computeBtn.disabled = true;
  computeBtn.addEventListener("click", () => {
    if (dsmPixels) renderShadowOverlay();
  });

  // -------------------------------------------------------------------------
  // Init
  // -------------------------------------------------------------------------
  map.on("load", () => {
    updateSunDial();
    loadDsm();
  });

  // Fallback: if map doesn't load within 3 seconds, load DSM anyway
  setTimeout(() => {
    if (!dsmPixels) {
      console.log("Map load timeout - loading DSM anyway");
      updateSunDial();
      loadDsm();
    }
  }, 3000);
})();
