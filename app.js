// app.js — SønSpot 3D Shadow Viewer
// Three.js scene with DSM terrain, SunCalc lighting, and shadow playback

(async function () {
  const TARGET_LAT = 55.69162107686692;
  const TARGET_LNG = 12.558723441754955;
  const DSM_URL = 'public/dsm-norrebro.png';
  const META_URL = 'public/dsm-meta.json';

  // ── State ──────────────────────────────────────────────────────────────
  let dsmMeta = null;
  let heightData = null;      // Float32Array of decoded heights
  let terrainMesh = null;
  let markerMesh = null;
  let markerGlow = null;
  let sunLight = null;
  let sunSphere = null;
  let isPlaying = false;
  let animationId = null;
  let playStartTime = 0;
  let playStartMinute = 0;
  let sunriseMinute = 0;
  let sunsetMinute = 0;

  const PLAY_DURATION_S = 30; // full day in 30 seconds

  // ── DOM refs ───────────────────────────────────────────────────────────
  const container = document.getElementById('scene-container');
  const timeDisplay = document.getElementById('time-display');
  const datePicker = document.getElementById('date-picker');
  const playBtn = document.getElementById('play-btn');
  const timeSlider = document.getElementById('time-slider');
  const sunStatus = document.getElementById('sun-status');
  const shadowOpacitySlider = document.getElementById('shadow-opacity-slider');
  const sunriseLabel = document.getElementById('sunrise-label');
  const sunsetLabel = document.getElementById('sunset-label');
  const loadingOverlay = document.getElementById('loading-overlay');

  // ── Three.js setup ─────────────────────────────────────────────────────
  const scene = new THREE.Scene();

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  container.appendChild(renderer.domElement);

  const camera = new THREE.PerspectiveCamera(
    45,
    window.innerWidth / window.innerHeight,
    1,
    2000
  );
  camera.position.set(-200, 180, 200);
  camera.lookAt(0, 0, 0);

  const controls = new THREE.OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.maxPolarAngle = Math.PI / 2.1;
  controls.minDistance = 50;
  controls.maxDistance = 800;
  controls.target.set(0, 10, 0);

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  // ── Lighting ───────────────────────────────────────────────────────────
  const ambientLight = new THREE.AmbientLight(0x8899bb, 0.3);
  scene.add(ambientLight);

  const hemiLight = new THREE.HemisphereLight(0x87CEEB, 0xb5956e, 0.35);
  scene.add(hemiLight);

  sunLight = new THREE.DirectionalLight(0xfff4e0, 1.8);
  sunLight.castShadow = true;
  sunLight.shadow.mapSize.width = 2048;
  sunLight.shadow.mapSize.height = 2048;
  sunLight.shadow.camera.left = -300;
  sunLight.shadow.camera.right = 300;
  sunLight.shadow.camera.top = 300;
  sunLight.shadow.camera.bottom = -300;
  sunLight.shadow.camera.near = 1;
  sunLight.shadow.camera.far = 600;
  sunLight.shadow.bias = -0.001;
  sunLight.shadow.normalBias = 0.02;
  scene.add(sunLight);
  scene.add(sunLight.target);
  sunLight.target.position.set(0, 0, 0);

  // Sun sphere visual
  const sunGeo = new THREE.SphereGeometry(6, 16, 16);
  const sunMat = new THREE.MeshBasicMaterial({ color: 0xFFD166 });
  sunSphere = new THREE.Mesh(sunGeo, sunMat);
  scene.add(sunSphere);

  // ── Sky background ─────────────────────────────────────────────────────
  function updateBackground(altitude) {
    const t = Math.max(0, Math.min(1, altitude / (Math.PI / 4)));
    const nightBot = new THREE.Color(0x0a0f1e);
    const nightTop = new THREE.Color(0x1a2540);
    const dayBot = new THREE.Color(0x87CEEB);
    const dayTop = new THREE.Color(0x4a90d9);
    const bot = nightBot.clone().lerp(dayBot, t);
    const top = nightTop.clone().lerp(dayTop, t);
    scene.background = new THREE.Color().lerpColors(bot, top, 0.5);
  }

  // ── DSM Loading ────────────────────────────────────────────────────────
  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Image load failed: ' + src));
      img.src = src;
    });
  }

  function decodeTerrarium(r, g, b) {
    return r * 256 + g + b / 256 - 32768;
  }

  async function loadDSM() {
    const [metaRes, imgEl] = await Promise.all([
      fetch(META_URL).then(r => {
        if (!r.ok) throw new Error('Meta fetch: ' + r.status);
        return r.json();
      }),
      loadImage(DSM_URL)
    ]);

    dsmMeta = metaRes;

    const canvas = document.createElement('canvas');
    canvas.width = dsmMeta.width;
    canvas.height = dsmMeta.height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(imgEl, 0, 0);
    const pixels = ctx.getImageData(0, 0, dsmMeta.width, dsmMeta.height).data;

    const w = dsmMeta.width;
    const h = dsmMeta.height;
    heightData = new Float32Array(w * h);

    for (let i = 0; i < w * h; i++) {
      const idx = i * 4;
      heightData[i] = decodeTerrarium(pixels[idx], pixels[idx + 1], pixels[idx + 2]);
    }

    return { w, h };
  }

  // ── Terrain Mesh ───────────────────────────────────────────────────────
  function buildTerrain(w, h) {
    const worldW = w * dsmMeta.metersPerPixel;
    const worldH = h * dsmMeta.metersPerPixel;

    const geometry = new THREE.PlaneGeometry(worldW, worldH, w - 1, h - 1);
    geometry.rotateX(-Math.PI / 2);

    const positions = geometry.attributes.position.array;
    const colors = new Float32Array(positions.length);

    const minH = dsmMeta.minHeight;
    const maxH = dsmMeta.maxHeight;
    const range = maxH - minH || 1;

    const groundColor = new THREE.Color(0xd4c4a8);
    const buildingLow = new THREE.Color(0xb0a898);
    const buildingHigh = new THREE.Color(0x8a9aac);

    const groundThreshold = minH + range * 0.15;

    for (let i = 0; i < w * h; i++) {
      const row = Math.floor(i / w);
      const col = i % w;
      const dsmRow = row;
      const dsmCol = col;
      const height = heightData[dsmRow * w + dsmCol];

      positions[i * 3 + 1] = height;

      const t = (height - minH) / range;
      let c;
      if (height < groundThreshold) {
        c = groundColor.clone();
      } else {
        c = buildingLow.clone().lerp(buildingHigh, t);
      }
      colors[i * 3] = c.r;
      colors[i * 3 + 1] = c.g;
      colors[i * 3 + 2] = c.b;
    }

    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geometry.computeVertexNormals();

    const material = new THREE.MeshPhongMaterial({
      vertexColors: true,
      flatShading: true,
      shininess: 10,
      specular: 0x222222,
    });

    terrainMesh = new THREE.Mesh(geometry, material);
    terrainMesh.castShadow = true;
    terrainMesh.receiveShadow = true;
    scene.add(terrainMesh);
  }

  // ── Ground plane (extended) ────────────────────────────────────────────
  function addGroundPlane() {
    const geo = new THREE.PlaneGeometry(1200, 1200);
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.MeshPhongMaterial({
      color: 0xc4b498,
      shininess: 5,
    });
    const plane = new THREE.Mesh(geo, mat);
    plane.position.y = dsmMeta.minHeight - 0.5;
    plane.receiveShadow = true;
    scene.add(plane);
  }

  // ── Coordinate Conversion ──────────────────────────────────────────────
  function lngLatToWorld(lng, lat) {
    const metersPerDegLat = 111320;
    const metersPerDegLng = 111320 * Math.cos(dsmMeta.centerLat * Math.PI / 180);

    const dx = (lng - dsmMeta.centerLng) * metersPerDegLng;
    const dz = -(lat - dsmMeta.centerLat) * metersPerDegLat;

    return { x: dx, z: dz };
  }

  function getHeightAtWorld(wx, wz) {
    const w = dsmMeta.width;
    const h = dsmMeta.height;
    const worldW = w * dsmMeta.metersPerPixel;
    const worldH = h * dsmMeta.metersPerPixel;

    const col = Math.round((wx + worldW / 2) / dsmMeta.metersPerPixel);
    const row = Math.round((wz + worldH / 2) / dsmMeta.metersPerPixel);

    if (col < 0 || col >= w || row < 0 || row >= h) return dsmMeta.minHeight;
    return heightData[row * w + col];
  }

  // ── Target Marker ──────────────────────────────────────────────────────
  function placeMarker() {
    const pos = lngLatToWorld(TARGET_LNG, TARGET_LAT);
    const y = getHeightAtWorld(pos.x, pos.z) + 0.5;

    const markerGeo = new THREE.CylinderGeometry(1.5, 1.5, 4, 16);
    const markerMat = new THREE.MeshPhongMaterial({
      color: 0xFFD166,
      emissive: 0xFFD166,
      emissiveIntensity: 0.6,
      transparent: true,
      opacity: 0.9,
    });
    markerMesh = new THREE.Mesh(markerGeo, markerMat);
    markerMesh.position.set(pos.x, y + 2, pos.z);
    markerMesh.castShadow = false;
    markerMesh.receiveShadow = true;
    scene.add(markerMesh);

    const glowGeo = new THREE.RingGeometry(2, 5, 32);
    glowGeo.rotateX(-Math.PI / 2);
    const glowMat = new THREE.MeshBasicMaterial({
      color: 0xFFD166,
      transparent: true,
      opacity: 0.3,
      side: THREE.DoubleSide,
    });
    markerGlow = new THREE.Mesh(glowGeo, glowMat);
    markerGlow.position.set(pos.x, y + 0.2, pos.z);
    scene.add(markerGlow);
  }

  // ── Sun Positioning ────────────────────────────────────────────────────
  function getSelectedDate() {
    const val = datePicker.value;
    if (!val) return new Date();
    const parts = val.split('-');
    return new Date(+parts[0], +parts[1] - 1, +parts[2]);
  }

  function minutesToDate(minutes) {
    const d = getSelectedDate();
    d.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0);
    return d;
  }

  function formatTime(minutes) {
    const hh = String(Math.floor(minutes / 60)).padStart(2, '0');
    const mm = String(Math.floor(minutes % 60)).padStart(2, '0');
    return hh + ':' + mm;
  }

  function updateSunriseSunset() {
    const d = getSelectedDate();
    const times = SunCalc.getTimes(d, TARGET_LAT, TARGET_LNG);
    sunriseMinute = times.sunrise.getHours() * 60 + times.sunrise.getMinutes();
    sunsetMinute = times.sunset.getHours() * 60 + times.sunset.getMinutes();
    sunriseLabel.textContent = formatTime(sunriseMinute);
    sunsetLabel.textContent = formatTime(sunsetMinute);
  }

  function updateSun(minutes) {
    const date = minutesToDate(minutes);
    const pos = SunCalc.getPosition(date, TARGET_LAT, TARGET_LNG);
    const azimuth = pos.azimuth + Math.PI; // SunCalc: 0=south, clockwise → convert to standard
    const altitude = pos.altitude;

    const dist = 250;
    const lx = Math.sin(azimuth) * Math.cos(altitude) * dist;
    const ly = Math.sin(altitude) * dist;
    const lz = Math.cos(azimuth) * Math.cos(altitude) * dist;

    sunLight.position.set(lx, ly, lz);
    sunSphere.position.set(lx, ly, lz);

    const belowHorizon = altitude <= 0;
    sunLight.intensity = belowHorizon ? 0 : THREE.MathUtils.lerp(0.4, 1.8, Math.min(1, altitude / 0.5));

    const shadowDarkness = Number(shadowOpacitySlider.value) / 100;
    sunLight.shadow.opacity = shadowDarkness;

    const warmth = Math.max(0, Math.min(1, altitude / 0.3));
    sunLight.color.setHSL(0.1, 0.3 + 0.4 * (1 - warmth), 0.7 + 0.3 * warmth);

    sunSphere.visible = !belowHorizon;
    sunSphere.material.opacity = belowHorizon ? 0 : 1;

    updateBackground(altitude);
    updateSunStatus(minutes);

    timeDisplay.textContent = formatTime(minutes);
  }

  // ── Shadow Detection ───────────────────────────────────────────────────
  function updateSunStatus(minutes) {
    if (!markerMesh || !terrainMesh) return;

    const date = minutesToDate(minutes);
    const sunPos = SunCalc.getPosition(date, TARGET_LAT, TARGET_LNG);

    if (sunPos.altitude <= 0) {
      sunStatus.textContent = '◑ IN SHADOW';
      sunStatus.className = 'in-shadow';
      return;
    }

    const raycaster = new THREE.Raycaster();
    const markerPos = markerMesh.position.clone();
    markerPos.y += 2;

    const sunDir = sunLight.position.clone().sub(markerPos).normalize();
    raycaster.set(markerPos, sunDir);
    raycaster.far = 600;

    const intersects = raycaster.intersectObject(terrainMesh);
    const inShadow = intersects.length > 0;

    if (inShadow) {
      sunStatus.textContent = '◑ IN SHADOW';
      sunStatus.className = 'in-shadow';
    } else {
      sunStatus.textContent = '☀ IN SUN';
      sunStatus.className = 'in-sun';
    }
  }

  // ── Playback ───────────────────────────────────────────────────────────
  function startPlayback() {
    isPlaying = true;
    playBtn.innerHTML = '&#9646;&#9646;';
    playStartTime = performance.now();
    playStartMinute = sunriseMinute;
    timeSlider.value = sunriseMinute;
  }

  function stopPlayback() {
    isPlaying = false;
    playBtn.innerHTML = '&#9654;';
  }

  playBtn.addEventListener('click', () => {
    if (isPlaying) {
      stopPlayback();
    } else {
      startPlayback();
    }
  });

  timeSlider.addEventListener('input', () => {
    if (isPlaying) stopPlayback();
    updateSun(Number(timeSlider.value));
  });

  datePicker.addEventListener('change', () => {
    updateSunriseSunset();
    updateSun(Number(timeSlider.value));
  });

  shadowOpacitySlider.addEventListener('input', () => {
    updateSun(Number(timeSlider.value));
  });

  // ── Marker pulse animation ─────────────────────────────────────────────
  let markerTime = 0;

  // ── Render Loop ────────────────────────────────────────────────────────
  function animate() {
    animationId = requestAnimationFrame(animate);
    controls.update();

    if (isPlaying) {
      const elapsed = (performance.now() - playStartTime) / 1000;
      const dayRange = sunsetMinute - sunriseMinute;
      const progress = elapsed / PLAY_DURATION_S;

      if (progress >= 1) {
        stopPlayback();
        timeSlider.value = sunsetMinute;
        updateSun(sunsetMinute);
      } else {
        const currentMinute = sunriseMinute + progress * dayRange;
        timeSlider.value = Math.round(currentMinute);
        updateSun(currentMinute);
      }
    }

    // Marker pulse
    if (markerMesh && markerGlow) {
      markerTime += 0.03;
      const pulse = 0.5 + 0.5 * Math.sin(markerTime * 2);
      markerMesh.material.emissiveIntensity = 0.4 + 0.5 * pulse;
      markerGlow.material.opacity = 0.15 + 0.2 * pulse;
      const scale = 1 + 0.3 * pulse;
      markerGlow.scale.set(scale, scale, scale);
    }

    renderer.render(scene, camera);
  }

  // ── Init ───────────────────────────────────────────────────────────────
  const today = new Date();
  datePicker.value = today.getFullYear() + '-' +
    String(today.getMonth() + 1).padStart(2, '0') + '-' +
    String(today.getDate()).padStart(2, '0');

  try {
    const { w, h } = await loadDSM();
    buildTerrain(w, h);
    addGroundPlane();
    placeMarker();
    updateSunriseSunset();

    const noonMinute = Math.round((sunriseMinute + sunsetMinute) / 2);
    timeSlider.value = noonMinute;
    updateSun(noonMinute);

    loadingOverlay.classList.add('hidden');
    setTimeout(() => loadingOverlay.remove(), 600);

    animate();
  } catch (err) {
    console.error('Failed to init:', err);
    document.querySelector('.loading-sub').textContent =
      'Failed to load DSM. Run: node prepare-dsm.js';
  }
})();
