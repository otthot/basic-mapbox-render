// app.js — SønSpot 3D Shadow Viewer
// Three.js scene with DSM terrain, SunCalc lighting, shadow playback

(function () {
  'use strict';

  const TARGET_LAT = 55.69162107686692;
  const TARGET_LNG = 12.558723441754955;
  const DSM_URL = 'public/dsm-norrebro.png';
  const META_URL = 'public/dsm-meta.json';
  const WORLD_SIZE = 500; // 250 px * 2 m/px
  const HALF = WORLD_SIZE / 2;
  const SUN_DISTANCE = 400;
  const SHADOW_MAP_SIZE = 2048;
  const DAY_DURATION_SEC = 30;

  // State
  let dsmMeta = null;
  let heightData = null; // Float32Array [row * width + col]
  let terrain = null;
  let targetMarker = null;
  let sunLight = null;
  let sunSphere = null;
  let scene, camera, renderer, controls;
  let isPlaying = false;
  let playStartTime = 0;
  let playStartMinute = 0;
  let sunriseMinute = 0;
  let sunsetMinute = 0;
  let animFrameId = null;

  // DOM refs
  const container = document.getElementById('scene-container');
  const loadingOverlay = document.getElementById('loading-overlay');
  const loadingBarInner = document.getElementById('loading-bar-inner');
  const timeDisplay = document.getElementById('time-display');
  const datePicker = document.getElementById('date-picker');
  const playBtn = document.getElementById('play-btn');
  const timeSlider = document.getElementById('time-slider');
  const sunBadge = document.getElementById('sun-badge');
  const shadowOpacity = document.getElementById('shadow-opacity');
  const sunriseMarkerEl = document.getElementById('sunrise-marker');
  const sunriseLabelEl = document.getElementById('sunrise-label');
  const sunsetMarkerEl = document.getElementById('sunset-marker');
  const sunsetLabelEl = document.getElementById('sunset-label');

  // ── Coordinate conversion ───────────────────────────────────────────────

  function lngLatToWorld(lng, lat, meta) {
    const metersPerDegLat = 111320;
    const metersPerDegLng = 111320 * Math.cos(meta.centerLat * Math.PI / 180);
    const dx = (lng - meta.centerLng) * metersPerDegLng;
    const dz = -(lat - meta.centerLat) * metersPerDegLat;
    return { x: dx, z: dz };
  }

  function worldToPixel(wx, wz) {
    const col = (wx + HALF) / dsmMeta.metersPerPixel;
    const row = (wz + HALF) / dsmMeta.metersPerPixel;
    return { col: Math.round(col), row: Math.round(row) };
  }

  function getHeightAt(col, row) {
    if (!heightData || col < 0 || row < 0 || col >= dsmMeta.width || row >= dsmMeta.height) return 0;
    return heightData[row * dsmMeta.width + col];
  }

  function getHeightAtWorld(wx, wz) {
    const { col, row } = worldToPixel(wx, wz);
    return getHeightAt(col, row);
  }

  // ── Time helpers ────────────────────────────────────────────────────────

  function getSelectedDate() {
    const v = datePicker.value;
    return v ? new Date(v + 'T12:00:00') : new Date();
  }

  function minutesToDate(minutes) {
    const d = getSelectedDate();
    d.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0);
    return d;
  }

  function formatTime(minutes) {
    const h = String(Math.floor(minutes / 60)).padStart(2, '0');
    const m = String(minutes % 60).padStart(2, '0');
    return h + ':' + m;
  }

  function computeSunTimes() {
    const d = getSelectedDate();
    const times = SunCalc.getTimes(d, TARGET_LAT, TARGET_LNG);
    const rise = times.sunrise;
    const set = times.sunset;
    sunriseMinute = rise.getHours() * 60 + rise.getMinutes();
    sunsetMinute = set.getHours() * 60 + set.getMinutes();
    updateSliderMarkers();
  }

  function updateSliderMarkers() {
    const pctRise = (sunriseMinute / 1439) * 100;
    const pctSet = (sunsetMinute / 1439) * 100;
    sunriseMarkerEl.style.left = pctRise + '%';
    sunriseLabelEl.style.left = pctRise + '%';
    sunriseLabelEl.textContent = '↑' + formatTime(sunriseMinute);
    sunsetMarkerEl.style.left = pctSet + '%';
    sunsetLabelEl.style.left = pctSet + '%';
    sunsetLabelEl.textContent = formatTime(sunsetMinute) + '↓';
  }

  // ── DSM Loading ─────────────────────────────────────────────────────────

  function loadImage(src) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = function () { resolve(img); };
      img.onerror = function () { reject(new Error('Image load failed: ' + src)); };
      img.src = src;
    });
  }

  function decodeTerrarium(r, g, b) {
    return r * 256 + g + b / 256 - 32768;
  }

  async function loadDSM() {
    loadingBarInner.style.width = '20%';
    const metaRes = await fetch(META_URL);
    dsmMeta = await metaRes.json();
    loadingBarInner.style.width = '40%';

    const img = await loadImage(DSM_URL);
    loadingBarInner.style.width = '60%';

    const offscreen = document.createElement('canvas');
    offscreen.width = dsmMeta.width;
    offscreen.height = dsmMeta.height;
    const ctx = offscreen.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const pixels = ctx.getImageData(0, 0, dsmMeta.width, dsmMeta.height).data;

    const w = dsmMeta.width;
    const h = dsmMeta.height;
    heightData = new Float32Array(w * h);

    let minH = Infinity, maxH = -Infinity;
    for (let i = 0; i < w * h; i++) {
      const idx = i * 4;
      const elev = decodeTerrarium(pixels[idx], pixels[idx + 1], pixels[idx + 2]);
      heightData[i] = elev;
      if (elev < minH) minH = elev;
      if (elev > maxH) maxH = elev;
    }

    loadingBarInner.style.width = '80%';
    return { minH, maxH };
  }

  // ── Scene Setup ─────────────────────────────────────────────────────────

  function initScene() {
    scene = new THREE.Scene();

    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;
    container.appendChild(renderer.domElement);

    camera = new THREE.PerspectiveCamera(
      45,
      container.clientWidth / container.clientHeight,
      1,
      2000
    );
    camera.position.set(-300, 250, 300);
    camera.lookAt(0, 0, 0);

    controls = new THREE.OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.maxPolarAngle = Math.PI / 2.1;
    controls.minDistance = 50;
    controls.maxDistance = 800;
    controls.target.set(0, 20, 0);
    controls.update();

    const ambient = new THREE.AmbientLight(0xffffff, 0.3);
    scene.add(ambient);

    const hemi = new THREE.HemisphereLight(0x87CEEB, 0xD4A574, 0.4);
    scene.add(hemi);

    sunLight = new THREE.DirectionalLight(0xfff5e0, 1.5);
    sunLight.castShadow = true;
    sunLight.shadow.mapSize.width = SHADOW_MAP_SIZE;
    sunLight.shadow.mapSize.height = SHADOW_MAP_SIZE;
    sunLight.shadow.camera.left = -HALF;
    sunLight.shadow.camera.right = HALF;
    sunLight.shadow.camera.top = HALF;
    sunLight.shadow.camera.bottom = -HALF;
    sunLight.shadow.camera.near = 1;
    sunLight.shadow.camera.far = 1000;
    sunLight.shadow.bias = -0.001;
    sunLight.shadow.normalBias = 0.02;
    scene.add(sunLight);
    scene.add(sunLight.target);

    const sunGeo = new THREE.SphereGeometry(8, 16, 16);
    const sunMat = new THREE.MeshBasicMaterial({ color: 0xFFD166 });
    sunSphere = new THREE.Mesh(sunGeo, sunMat);
    scene.add(sunSphere);
  }

  // ── Terrain Mesh ────────────────────────────────────────────────────────

  function buildTerrain(minH, maxH) {
    const w = dsmMeta.width;
    const h = dsmMeta.height;
    const mpp = dsmMeta.metersPerPixel;

    const geo = new THREE.PlaneGeometry(WORLD_SIZE, WORLD_SIZE, w - 1, h - 1);
    geo.rotateX(-Math.PI / 2);

    const positions = geo.attributes.position.array;
    const colors = new Float32Array(positions.length);

    const groundLevel = minH + (maxH - minH) * 0.15;
    const buildingThreshold = minH + (maxH - minH) * 0.25;

    for (let row = 0; row < h; row++) {
      for (let col = 0; col < w; col++) {
        const vertIdx = row * w + col;
        const elev = heightData[vertIdx];

        positions[vertIdx * 3 + 1] = elev - minH;

        const isBuilding = elev > buildingThreshold;
        const heightNorm = (elev - minH) / (maxH - minH);

        let r, g, b;
        if (isBuilding) {
          const shade = 0.55 + heightNorm * 0.25;
          r = 0.65 * shade;
          g = 0.68 * shade;
          b = 0.75 * shade;
        } else {
          const shade = 0.7 + heightNorm * 0.3;
          r = 0.82 * shade;
          g = 0.78 * shade;
          b = 0.68 * shade;
        }

        colors[vertIdx * 3] = r;
        colors[vertIdx * 3 + 1] = g;
        colors[vertIdx * 3 + 2] = b;
      }
    }

    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.attributes.position.needsUpdate = true;
    geo.computeVertexNormals();

    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.85,
      metalness: 0.05,
      flatShading: true,
    });

    terrain = new THREE.Mesh(geo, mat);
    terrain.castShadow = true;
    terrain.receiveShadow = true;
    scene.add(terrain);

    const yOffset = -(minH + (maxH - minH) * 0.5) + 20;
    scene.position.y = yOffset;
  }

  // ── Target Marker ───────────────────────────────────────────────────────

  function placeTargetMarker(minH) {
    const pos = lngLatToWorld(TARGET_LNG, TARGET_LAT, dsmMeta);
    const terrainY = getHeightAtWorld(pos.x, pos.z) - minH;

    const geo = new THREE.CylinderGeometry(2.5, 2.5, 6, 16);
    const mat = new THREE.MeshStandardMaterial({
      color: 0xFFD166,
      emissive: 0xFFD166,
      emissiveIntensity: 0.8,
      roughness: 0.3,
      metalness: 0.1,
    });
    targetMarker = new THREE.Mesh(geo, mat);
    targetMarker.position.set(pos.x, terrainY + 3, pos.z);
    targetMarker.castShadow = false;
    targetMarker.receiveShadow = false;
    scene.add(targetMarker);

    const ringGeo = new THREE.RingGeometry(4, 6, 32);
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0xFFD166,
      transparent: true,
      opacity: 0.3,
      side: THREE.DoubleSide,
    });
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(pos.x, terrainY + 0.5, pos.z);
    scene.add(ring);

    return { x: pos.x, y: terrainY, z: pos.z };
  }

  // ── Sun Position ────────────────────────────────────────────────────────

  function updateSunPosition(minutes) {
    const d = minutesToDate(minutes);
    const sunPos = SunCalc.getPosition(d, TARGET_LAT, TARGET_LNG);
    const azimuth = sunPos.azimuth;
    const altitude = sunPos.altitude;

    const lx = Math.sin(azimuth) * Math.cos(altitude);
    const ly = Math.sin(altitude);
    const lz = Math.cos(azimuth) * Math.cos(altitude);

    sunLight.position.set(lx * SUN_DISTANCE, ly * SUN_DISTANCE, lz * SUN_DISTANCE);
    sunLight.target.position.set(0, 0, 0);
    sunSphere.position.copy(sunLight.position);

    const intensity = altitude > 0 ? Math.max(0.3, Math.min(1.5, altitude * 3)) : 0;
    sunLight.intensity = intensity;
    sunSphere.visible = altitude > 0;

    updateBackground(altitude);
    updateShadowOpacity();

    timeDisplay.textContent = formatTime(minutes);
  }

  function updateBackground(altitude) {
    const t = Math.max(0, Math.min(1, altitude * 4));
    const dark = { r: 10 / 255, g: 15 / 255, b: 30 / 255 };
    const light = { r: 135 / 255, g: 180 / 255, b: 220 / 255 };
    const r = dark.r + (light.r - dark.r) * t;
    const g = dark.g + (light.g - dark.g) * t;
    const b = dark.b + (light.b - dark.b) * t;
    scene.background = new THREE.Color(r, g, b);
    scene.fog = new THREE.Fog(new THREE.Color(r, g, b), 600, 1200);
  }

  function updateShadowOpacity() {
    if (!terrain) return;
    const val = Number(shadowOpacity.value) / 100;
    renderer.shadowMap.enabled = val > 0;
    sunLight.shadow.opacity = val;
    if (terrain.material) {
      terrain.material.shadowSide = THREE.FrontSide;
    }
  }

  // ── Shadow Detection ────────────────────────────────────────────────────

  function checkTargetShadow() {
    if (!targetMarker || !renderer) return;

    const minutes = getCurrentMinute();
    const d = minutesToDate(minutes);
    const sunPos = SunCalc.getPosition(d, TARGET_LAT, TARGET_LNG);

    if (sunPos.altitude <= 0) {
      setSunBadge(false, true);
      return;
    }

    // Raycaster from sun toward target
    const markerWorldPos = new THREE.Vector3();
    targetMarker.getWorldPosition(markerWorldPos);

    const sunWorldPos = new THREE.Vector3();
    sunSphere.getWorldPosition(sunWorldPos);

    const dir = new THREE.Vector3().subVectors(markerWorldPos, sunWorldPos).normalize();
    const raycaster = new THREE.Raycaster(sunWorldPos, dir, 0, SUN_DISTANCE * 2);

    const intersects = raycaster.intersectObject(terrain, false);
    if (intersects.length === 0) {
      setSunBadge(true, false);
      return;
    }

    const hitPoint = intersects[0].point;
    const distToHit = sunWorldPos.distanceTo(hitPoint);
    const distToMarker = sunWorldPos.distanceTo(markerWorldPos);

    const inSun = distToHit >= distToMarker - 5;
    setSunBadge(inSun, false);
  }

  function setSunBadge(inSun, isNight) {
    if (isNight) {
      sunBadge.className = 'sun-badge in-shadow';
      sunBadge.textContent = '🌙 NIGHT';
    } else if (inSun) {
      sunBadge.className = 'sun-badge in-sun';
      sunBadge.textContent = '☀ IN SUN';
    } else {
      sunBadge.className = 'sun-badge in-shadow';
      sunBadge.textContent = '◑ IN SHADOW';
    }
  }

  // ── Playback ────────────────────────────────────────────────────────────

  function getCurrentMinute() {
    return Number(timeSlider.value);
  }

  function startPlayback() {
    isPlaying = true;
    playBtn.textContent = '⏸ Pause';
    playBtn.classList.remove('btn-play');
    playStartTime = performance.now();
    playStartMinute = sunriseMinute;
    timeSlider.value = sunriseMinute;
  }

  function stopPlayback() {
    isPlaying = false;
    playBtn.textContent = '▶ Play';
    playBtn.classList.add('btn-play');
  }

  playBtn.addEventListener('click', function () {
    if (isPlaying) {
      stopPlayback();
    } else {
      startPlayback();
    }
  });

  // ── Slider Events ──────────────────────────────────────────────────────

  timeSlider.addEventListener('input', function () {
    if (isPlaying) stopPlayback();
    const m = Number(timeSlider.value);
    updateSunPosition(m);
    checkTargetShadow();
  });

  datePicker.addEventListener('change', function () {
    computeSunTimes();
    const m = getCurrentMinute();
    updateSunPosition(m);
    checkTargetShadow();
  });

  shadowOpacity.addEventListener('input', function () {
    updateShadowOpacity();
  });

  // ── Marker pulse animation ─────────────────────────────────────────────

  let pulseTime = 0;

  function pulseMarker(dt) {
    if (!targetMarker) return;
    pulseTime += dt;
    const s = 1 + 0.15 * Math.sin(pulseTime * 3);
    targetMarker.scale.set(s, 1, s);
    const emI = 0.5 + 0.4 * Math.sin(pulseTime * 3);
    targetMarker.material.emissiveIntensity = emI;
  }

  // ── Render Loop ─────────────────────────────────────────────────────────

  let lastTime = 0;

  function animate(time) {
    animFrameId = requestAnimationFrame(animate);
    const dt = (time - (lastTime || time)) / 1000;
    lastTime = time;

    controls.update();
    pulseMarker(dt);

    if (isPlaying) {
      const elapsed = (performance.now() - playStartTime) / 1000;
      const dayRange = sunsetMinute - sunriseMinute;
      const progress = elapsed / DAY_DURATION_SEC;
      const currentMinute = Math.round(sunriseMinute + progress * dayRange);

      if (currentMinute >= sunsetMinute) {
        timeSlider.value = sunsetMinute;
        updateSunPosition(sunsetMinute);
        checkTargetShadow();
        stopPlayback();
      } else {
        timeSlider.value = currentMinute;
        updateSunPosition(currentMinute);
        checkTargetShadow();
      }
    }

    renderer.render(scene, camera);
  }

  // ── Resize ──────────────────────────────────────────────────────────────

  window.addEventListener('resize', function () {
    if (!camera || !renderer) return;
    camera.aspect = container.clientWidth / container.clientHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(container.clientWidth, container.clientHeight);
  });

  // ── Init ────────────────────────────────────────────────────────────────

  async function init() {
    const today = new Date();
    datePicker.value = today.toISOString().split('T')[0];

    initScene();
    scene.background = new THREE.Color(0x0a0f1e);

    try {
      const { minH, maxH } = await loadDSM();
      buildTerrain(minH, maxH);
      loadingBarInner.style.width = '90%';

      placeTargetMarker(minH);
      computeSunTimes();
      updateSunPosition(720);
      checkTargetShadow();

      loadingBarInner.style.width = '100%';
      setTimeout(function () {
        loadingOverlay.classList.add('hidden');
      }, 400);

      animate(0);
    } catch (err) {
      console.error('Failed to initialize:', err);
      document.querySelector('.loading-text').textContent =
        'Error: ' + err.message;
    }
  }

  init();
})();
