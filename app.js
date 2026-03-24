// app.js — SønSpot 3D Shadow Viewer
// Three.js terrain renderer with SunCalc-driven directional lighting

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

(async function () {
  'use strict';
  // ── Config ──────────────────────────────────────────────────────────────
  const TARGET_LAT = 55.691437279584 // 55.69162107686692 // ;
  const TARGET_LNG = 12.55876633423455 //12.558723441754955 // ;
  const DSM_URL    = 'public/dsm-norrebro.png';
  const META_URL   = 'public/dsm-meta.json';
  const SUN_DIST   = 200;
  const SHADOW_MAP_SIZE = 2048;
  const PLAYBACK_DURATION = 30; // seconds for full day

  // ── DOM refs ────────────────────────────────────────────────────────────
  const container      = document.getElementById('scene-container');
  const loadingEl      = document.getElementById('loading');
  const timeDisplay    = document.getElementById('time-display');
  const slider         = document.getElementById('time-slider');
  const sliderTrack    = document.getElementById('slider-track');
  const datePicker     = document.getElementById('date-picker');
  const playBtn        = document.getElementById('play-btn');
  const sunStatusEl    = document.getElementById('sun-status');
  const shadowSlider   = document.getElementById('shadow-opacity-slider');

  // Default date to today
  const today = new Date();
  datePicker.value = today.toISOString().slice(0, 10);

  // ── Load DSM data ──────────────────────────────────────────────────────
  const [metaRes, dsmImage] = await Promise.all([
    fetch(META_URL).then(r => r.json()),
    loadImage(DSM_URL),
  ]);
  const meta = metaRes;

  // Read height pixels
  const offscreen = document.createElement('canvas');
  offscreen.width = meta.width;
  offscreen.height = meta.height;
  const offCtx = offscreen.getContext('2d');
  offCtx.drawImage(dsmImage, 0, 0);
  const imgData = offCtx.getImageData(0, 0, meta.width, meta.height).data;

  // Decode Terrarium heights into a Float32Array
  const W = meta.width;
  const H = meta.height;
  const heights = new Float32Array(W * H);
  let minH = Infinity, maxH = -Infinity;
  for (let i = 0; i < W * H; i++) {
    const r = imgData[i * 4];
    const g = imgData[i * 4 + 1];
    const b = imgData[i * 4 + 2];
    const h = r * 256 + g + b / 256 - 32768;
    heights[i] = h;
    if (h < minH) minH = h;
    if (h > maxH) maxH = h;
  }

  // World dimensions: 500m × 500m centered at origin
  const worldW = W * meta.metersPerPixel; // 500
  const worldH = H * meta.metersPerPixel; // 500
  const halfW = worldW / 2;
  const halfH = worldH / 2;

  // ── Three.js Scene Setup ───────────────────────────────────────────────
  const scene    = new THREE.Scene();
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  renderer.setSize(container.clientWidth, container.clientHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  container.appendChild(renderer.domElement);

  // Camera
  const camera = new THREE.PerspectiveCamera(
    45,
    container.clientWidth / container.clientHeight,
    1,
    2000
  );
  camera.position.set(-200, 180, 200);
  camera.lookAt(0, 0, 0);

  // OrbitControls
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.maxPolarAngle = Math.PI / 2.05;
  controls.minDistance = 50;
  controls.maxDistance = 800;
  controls.target.set(0, 20, 0);
  controls.update();

  // ── Lights ──────────────────────────────────────────────────────────────

  // Ambient — keeps shadowed areas visible
  const ambientLight = new THREE.AmbientLight(0x404050, 0.3);
  scene.add(ambientLight);

  // Hemisphere — sky blue top, warm ground bottom
  const hemiLight = new THREE.HemisphereLight(0x87CEEB, 0xD4A574, 0.25);
  scene.add(hemiLight);

  // Directional (sun)
  const sunLight = new THREE.DirectionalLight(0xfff4e0, 1.5);
  sunLight.castShadow = true;
  sunLight.shadow.mapSize.width = SHADOW_MAP_SIZE;
  sunLight.shadow.mapSize.height = SHADOW_MAP_SIZE;
  sunLight.shadow.camera.left   = -300;
  sunLight.shadow.camera.right  =  300;
  sunLight.shadow.camera.top    =  300;
  sunLight.shadow.camera.bottom = -300;
  sunLight.shadow.camera.near   = 1;
  sunLight.shadow.camera.far    = 600;
  sunLight.shadow.bias = -0.001;
  sunLight.shadow.normalBias = 0.02;
  scene.add(sunLight);
  scene.add(sunLight.target);
  sunLight.target.position.set(0, 0, 0);

  // ── Sun Sphere ──────────────────────────────────────────────────────────
  const sunSphereGeo  = new THREE.SphereGeometry(6, 16, 16);
  const sunSphereMat  = new THREE.MeshBasicMaterial({ color: 0xFFD166 });
  const sunSphere     = new THREE.Mesh(sunSphereGeo, sunSphereMat);
  scene.add(sunSphere);

  // Glow sprite for sun
  const glowCanvas = document.createElement('canvas');
  glowCanvas.width = 128;
  glowCanvas.height = 128;
  const gCtx = glowCanvas.getContext('2d');
  const gradient = gCtx.createRadialGradient(64, 64, 0, 64, 64, 64);
  gradient.addColorStop(0, 'rgba(255, 209, 102, 0.6)');
  gradient.addColorStop(0.4, 'rgba(255, 209, 102, 0.15)');
  gradient.addColorStop(1, 'rgba(255, 209, 102, 0)');
  gCtx.fillStyle = gradient;
  gCtx.fillRect(0, 0, 128, 128);
  const glowTexture = new THREE.CanvasTexture(glowCanvas);
  const glowSprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: glowTexture, transparent: true, depthWrite: false })
  );
  glowSprite.scale.set(40, 40, 1);
  scene.add(glowSprite);

  // ── Build Terrain Mesh ──────────────────────────────────────────────────
  const planeGeo = new THREE.PlaneGeometry(worldW, worldH, W - 1, H - 1);
  planeGeo.rotateX(-Math.PI / 2); // lay flat in XZ plane

  const posAttr = planeGeo.attributes.position;
  const groundLevel = minH;
  const heightScale = 1.0; // 1:1 metre scale

  for (let i = 0; i < posAttr.count; i++) {
    // PlaneGeometry after rotateX(-PI/2): X is horizontal, Y is up, Z is horizontal
    // Vertices are laid out row-by-row: col varies first (X), then row (Z)
    const col = i % W;
    const row = Math.floor(i / W);
    const h = (heights[row * W + col] - groundLevel) * heightScale;
    posAttr.setY(i, h);
  }

  planeGeo.computeVertexNormals();

  // Color vertices: ground vs elevated
  const colors = new Float32Array(posAttr.count * 3);
  const groundColor = new THREE.Color(0xd4c5a9); // warm sandstone
  const buildingColor = new THREE.Color(0x8a9bae); // cool blue-grey
  const heightRange = maxH - minH;

  for (let i = 0; i < posAttr.count; i++) {
    const col = i % W;
    const row = Math.floor(i / W);
    const h = heights[row * W + col];
    const t = Math.min(1, Math.max(0, (h - minH - 2) / (heightRange * 0.3)));
    const c = new THREE.Color().lerpColors(groundColor, buildingColor, t);
    colors[i * 3]     = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }

  planeGeo.setAttribute('color', new THREE.BufferAttribute(colors, 3));

  const terrainMat = new THREE.MeshLambertMaterial({
    vertexColors: true,
    side: THREE.FrontSide,
  });

  const terrain = new THREE.Mesh(planeGeo, terrainMat);
  terrain.castShadow = true;
  terrain.receiveShadow = true;
  scene.add(terrain);

  // ── Target Location Marker ─────────────────────────────────────────────
  function lngLatToWorld(lng, lat) {
    const metersPerDegLat = 111320;
    const metersPerDegLng = 111320 * Math.cos(meta.centerLat * Math.PI / 180);
    const dx = (lng - meta.centerLng) * metersPerDegLng;
    const dz = -(lat - meta.centerLat) * metersPerDegLat;
    return { x: dx, z: dz };
  }

  function getTerrainHeightAtWorld(wx, wz) {
    const col = Math.round((wx + halfW) / meta.metersPerPixel);
    const row = Math.round((wz + halfH) / meta.metersPerPixel);
    if (col < 0 || row < 0 || col >= W || row >= H) return 0;
    return (heights[row * W + col] - groundLevel) * heightScale;
  }

  const targetWorld = lngLatToWorld(TARGET_LNG, TARGET_LAT);
  const targetTerrainH = getTerrainHeightAtWorld(targetWorld.x, targetWorld.z);

  // Marker: glowing yellow cylinder + sphere on top
  const markerGroup = new THREE.Group();

  const markerCylGeo = new THREE.CylinderGeometry(1.2, 1.2, 4, 16);
  const markerCylMat = new THREE.MeshBasicMaterial({ color: 0xFFD166, transparent: true, opacity: 0.5 });
  const markerCyl = new THREE.Mesh(markerCylGeo, markerCylMat);
  markerCyl.position.y = 2;
  markerGroup.add(markerCyl);

  const markerSphGeo = new THREE.SphereGeometry(2, 16, 16);
  const markerSphMat = new THREE.MeshBasicMaterial({ color: 0xFFD166 });
  const markerSph = new THREE.Mesh(markerSphGeo, markerSphMat);
  markerSph.position.y = 5;
  markerGroup.add(markerSph);

  // Glow ring around marker
  const ringGeo = new THREE.RingGeometry(2.5, 4, 32);
  const ringMat = new THREE.MeshBasicMaterial({
    color: 0xFFD166, transparent: true, opacity: 0.25, side: THREE.DoubleSide,
  });
  const ring = new THREE.Mesh(ringGeo, ringMat);
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.2;
  markerGroup.add(ring);

  markerGroup.position.set(targetWorld.x, targetTerrainH, targetWorld.z);
  scene.add(markerGroup);

  // ── Background (sky) ───────────────────────────────────────────────────
  function updateSkyBackground(sunAltitude) {
    const aboveHorizon = sunAltitude > 0;
    if (aboveHorizon) {
      const t = Math.min(1, sunAltitude / (Math.PI / 6));
      const topColor = new THREE.Color(0x0a0f1e).lerp(new THREE.Color(0x5b8ec9), t);
      const bottomColor = new THREE.Color(0x1a2540).lerp(new THREE.Color(0xb0cde8), t);
      renderer.setClearColor(topColor);
      scene.fog = new THREE.FogExp2(bottomColor, 0.0008);
    } else {
      renderer.setClearColor(0x0a0f1e);
      scene.fog = new THREE.FogExp2(0x0a0f1e, 0.001);
    }
  }

  // ── Sun Position Logic ──────────────────────────────────────────────────
  function getSelectedDate() {
    const parts = datePicker.value.split('-');
    return new Date(+parts[0], +parts[1] - 1, +parts[2]);
  }

  function minutesToDate(minutes) {
    const d = getSelectedDate();
    d.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0);
    return d;
  }

  function formatTime(minutes) {
    const h = String(Math.floor(minutes / 60)).padStart(2, '0');
    const m = String(minutes % 60).padStart(2, '0');
    return `${h}:${m}`;
  }

  function updateSunPosition(minutes) {
    const date = minutesToDate(minutes);
    const pos = SunCalc.getPosition(date, TARGET_LAT, TARGET_LNG);
    const azimuth = pos.azimuth + Math.PI; // SunCalc: 0=south, we need 0=north
    const altitude = pos.altitude;

    // Light direction
    const lx = Math.sin(azimuth) * Math.cos(altitude);
    const ly = Math.sin(altitude);
    const lz = Math.cos(azimuth) * Math.cos(altitude);

    sunLight.position.set(lx, ly, lz).multiplyScalar(SUN_DIST);

    // Intensity based on altitude
    if (altitude > 0) {
      const t = Math.min(1, altitude / (Math.PI / 6));
      sunLight.intensity = 0.3 + t * 1.7;
      sunLight.color.setHex(altitude < 0.1 ? 0xffb347 : 0xfff4e0);
    } else {
      sunLight.intensity = 0;
    }

    // Shadow opacity from slider
    const shadowOpacity = parseInt(shadowSlider.value) / 100;
    sunLight.shadow.opacity = shadowOpacity;
    // Adjust ambient to compensate
    ambientLight.intensity = 0.15 + (1 - shadowOpacity) * 0.3;

    // Sun sphere
    sunSphere.position.copy(sunLight.position);
    glowSprite.position.copy(sunLight.position);
    sunSphere.visible = altitude > -0.05;
    glowSprite.visible = altitude > -0.05;

    // Sky
    updateSkyBackground(altitude);

    // Time display
    timeDisplay.textContent = formatTime(minutes);

    // Sun status for target marker
    updateSunStatus(altitude);
  }

  // ── Sun/Shadow status at target ─────────────────────────────────────────
  function updateSunStatus(sunAltitude) {
    if (sunAltitude <= 0) {
      sunStatusEl.textContent = '◑ IN SHADOW';
      sunStatusEl.className = 'in-shadow';
      return;
    }

    // Raycast from sun direction to target marker to check shadow
    const markerPos = new THREE.Vector3(
      markerGroup.position.x,
      markerGroup.position.y + 3,
      markerGroup.position.z
    );

    const sunDir = new THREE.Vector3()
      .copy(sunLight.position)
      .sub(markerPos)
      .normalize();

    const raycaster = new THREE.Raycaster(markerPos, sunDir, 0, SUN_DIST * 2);
    const intersects = raycaster.intersectObject(terrain);

    if (intersects.length > 0) {
      sunStatusEl.textContent = '◑ IN SHADOW';
      sunStatusEl.className = 'in-shadow';
    } else {
      sunStatusEl.textContent = '☀ IN SUN';
      sunStatusEl.className = 'in-sun';
    }
  }

  // ── Sunrise/Sunset markers on slider ────────────────────────────────────
  function updateSliderMarkers() {
    // Remove old markers
    sliderTrack.querySelectorAll('.sun-marker, .sun-marker-label').forEach(el => el.remove());

    const d = getSelectedDate();
    const times = SunCalc.getTimes(d, TARGET_LAT, TARGET_LNG);

    const riseMin = times.sunrise.getHours() * 60 + times.sunrise.getMinutes();
    const setMin  = times.sunset.getHours() * 60 + times.sunset.getMinutes();

    for (const [min, label] of [[riseMin, '↑'], [setMin, '↓']]) {
      const pct = (min / 1439) * 100;

      const marker = document.createElement('div');
      marker.className = 'sun-marker';
      marker.style.left = `${pct}%`;
      sliderTrack.appendChild(marker);

      const lbl = document.createElement('div');
      lbl.className = 'sun-marker-label';
      lbl.style.left = `${pct}%`;
      lbl.textContent = label;
      sliderTrack.appendChild(lbl);
    }

    return { riseMin, setMin };
  }

  // ── Playback ────────────────────────────────────────────────────────────
  let isPlaying = false;
  let playStartTime = 0;
  let playStartMinute = 0;
  let sunriseMinute = 0;
  let sunsetMinute = 0;

  function initSunTimes() {
    const result = updateSliderMarkers();
    sunriseMinute = result.riseMin;
    sunsetMinute = result.setMin;
  }

  playBtn.addEventListener('click', () => {
    isPlaying = !isPlaying;
    if (isPlaying) {
      playBtn.textContent = '⏸';
      playStartTime = performance.now();
      playStartMinute = sunriseMinute;
      slider.value = sunriseMinute;
    } else {
      playBtn.textContent = '▶';
    }
  });

  slider.addEventListener('input', () => {
    isPlaying = false;
    playBtn.textContent = '▶';
    updateSunPosition(Number(slider.value));
  });

  datePicker.addEventListener('change', () => {
    initSunTimes();
    updateSunPosition(Number(slider.value));
  });

  shadowSlider.addEventListener('input', () => {
    updateSunPosition(Number(slider.value));
  });

  // ── Marker pulse animation ──────────────────────────────────────────────
  let markerPulseTime = 0;

  function animateMarker(dt) {
    markerPulseTime += dt;
    const pulse = 0.8 + 0.2 * Math.sin(markerPulseTime * 3);
    markerSph.scale.setScalar(pulse);
    ring.scale.setScalar(0.8 + 0.3 * Math.sin(markerPulseTime * 2));
    ring.material.opacity = 0.15 + 0.1 * Math.sin(markerPulseTime * 2);
  }

  // ── Resize handler ─────────────────────────────────────────────────────
  function onResize() {
    camera.aspect = container.clientWidth / container.clientHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(container.clientWidth, container.clientHeight);
  }
  window.addEventListener('resize', onResize);

  // ── Animation loop ──────────────────────────────────────────────────────
  let lastTime = performance.now();
  const clock = new THREE.Clock();

  function animate() {
    requestAnimationFrame(animate);

    const now = performance.now();
    const dt = (now - lastTime) / 1000;
    lastTime = now;

    // Playback
    if (isPlaying) {
      const elapsed = (now - playStartTime) / 1000;
      const dayRange = sunsetMinute - sunriseMinute;
      const progress = elapsed / PLAYBACK_DURATION;
      const currentMinute = Math.round(sunriseMinute + progress * dayRange);

      if (currentMinute >= sunsetMinute) {
        isPlaying = false;
        playBtn.textContent = '▶';
        slider.value = sunsetMinute;
        updateSunPosition(sunsetMinute);
      } else {
        slider.value = currentMinute;
        updateSunPosition(currentMinute);
      }
    }

    animateMarker(dt);
    controls.update();
    renderer.render(scene, camera);
  }

  // ── Init ────────────────────────────────────────────────────────────────

  // Set initial time to current hour/minute
  const nowMinutes = today.getHours() * 60 + today.getMinutes();
  slider.value = nowMinutes;

  initSunTimes();
  updateSunPosition(nowMinutes);

  // Hide loading screen
  loadingEl.classList.add('hidden');
  setTimeout(() => loadingEl.remove(), 600);

  animate();

  // ── Helpers ─────────────────────────────────────────────────────────────
  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error(`Failed to load: ${src}`));
      img.src = src;
    });
  }
})();
