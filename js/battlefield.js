'use strict';

/**
 * 3D battlefield view (three.js) for Block Race.
 * Four armies (one per PoW algo) face a central chain monument.
 * Mining power = army size. Mined blocks fly onto the chain tower.
 */
const Battlefield = (function () {
  const LANE_COLORS = [0xff4d5e, 0x37b6ff, 0x3dffa2, 0xffb640];
  const ALGO_LABELS = ['RandomXM', 'Sha3x', 'RandomXT', 'Cuckaroo'];
  const MAX_UNITS = 70;
  const ARMY_RADIUS = 26;

  // Curated equirectangular 360° skyboxes (Skybox AI), shuffled once per
  // session so consecutive rounds get varied themes.
  let SKYBOXES = [];
  fetch('assets/skyboxes/manifest.json')
    .then((res) => res.json())
    .then((paths) => {
      for (let i = paths.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [paths[i], paths[j]] = [paths[j], paths[i]];
      }
      SKYBOXES = paths;
      // if the scene came up before the manifest arrived, kick off the first skybox now
      if (scene && skyboxIndex === -1) setSkybox(0);
    })
    .catch((err) => console.warn('skybox manifest failed to load', err));
  let skyboxIndex = -1;
  let skyboxTexture = null;
  let skyboxLoadId = 0;

  let renderer = null;
  let scene = null;
  let camera = null;
  let container = null;
  let started = false;

  const armies = [];        // per algo: friendly defenders { mesh, count, basePositions, charge, mineCount }
  const invaders = [];      // per algo: hostile troops { mesh, count, offsets, threat, threatTarget, advanceR, alertUntil }
  const towerBlocks = [];   // meshes stacked in the middle
  const flyingBlocks = [];  // { mesh, from, to, t, arc, speed }
  const failFx = [];        // failed attempts that slam into a wall { mesh, from, to, t, phase }
  const penaltyCones = [];
  const banners = [];       // per algo floating telemetry sprite
  const walls = [];         // per algo: difficulty gate { mesh, frost, glow, targetH, currentH }
  const siegeLights = [];   // per algo red glow while a lane is embattled
  const klaxons = [];       // per algo warning ring flashed on hostile surge
  const laneForces = [{ mine: 0, other: 0, hostile: 0 }, { mine: 0, other: 0, hostile: 0 }, { mine: 0, other: 0, hostile: 0 }, { mine: 0, other: 0, hostile: 0 }];
  const orphanFx = [];      // crumbling orphan cubes { mesh, t, phase }
  const toppleFx = [];      // reorg debris { mesh, vel, spin, t }
  const shadowGhosts = [];  // translucent hidden-chain blocks beside the tower
  let shadowAlgoColor = 0x8844ff;
  let diffBaselines = [0, 0, 0, 0]; // first-seen difficulty per algo, walls normalize to this
  const laneShares = [0.25, 0.25, 0.25, 0.25]; // live expected win share per lane
  let dummy = null;
  let clock = null;

  const MAX_ENEMY = 54;
  // Ownership is carried by shape and markers, never by a lane color:
  // attackers wear black armor with a pulsing warning horn; the local squad
  // keeps its algo color and gains a neon violet diamond with a dark backplate.
  const ENEMY_COLOR = 0x111318;
  const ENEMY_WARNING_COLOR = 0xff2030;
  const MINE_MARKER_COLOR = 0xe64cff;
  const MINE_MARKER_BACKPLATE = 0x05020a;
  const ENEMY_SCALE = 1.35;

  // cadence weather: heat > 0 = blocks running hot, stall grows while no block lands
  let heat = 0;
  let lastBlockAt = 0;
  let expectedGapMs = 2000;
  let hemiLight = null;
  let sunLight = null;
  const HEMI_BASE = 1.05;
  const SUN_BASE = 1.4;
  const FOG_NEAR = 90;
  const FOG_FAR = 220;

  // camera orbit
  let camAngle = 0.6;
  let camPitch = 0.32;
  let camDist = 62;
  let autoRotate = true;
  let dragging = false;
  let lastX = 0, lastY = 0;
  let lastInteractAt = 0;
  const AUTO_ROTATE_IDLE_MS = 5000;

  const ARMY_POS = [
    [0, -ARMY_RADIUS],   // RandomXM  north
    [ARMY_RADIUS, 0],    // Sha3x     east
    [0, ARMY_RADIUS],    // RandomXT  south
    [-ARMY_RADIUS, 0],   // Cuckaroo  west
  ];

  function init(containerEl) {
    if (started || !window.THREE) return;
    container = containerEl;
    const width = container.clientWidth || 800;
    const height = container.clientHeight || 500;
    if (width < 10) return;
    started = true;

    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(width, height);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(renderer.domElement);

    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x9db8d6); // fallback until the skybox texture loads
    scene.fog = new THREE.Fog(0x9db8d6, 90, 220);
    if (SKYBOXES.length) setSkybox(0); // manifest is pre-shuffled, so 0 is random

    camera = new THREE.PerspectiveCamera(48, width / height, 0.1, 500);

    // Lights
    hemiLight = new THREE.HemisphereLight(0xdfeaff, 0x59684a, HEMI_BASE);
    scene.add(hemiLight);
    sunLight = new THREE.DirectionalLight(0xfff3d6, SUN_BASE);
    sunLight.position.set(40, 60, 25);
    sunLight.castShadow = true;
    sunLight.shadow.mapSize.set(2048, 2048);
    sunLight.shadow.camera.left = -70;
    sunLight.shadow.camera.right = 70;
    sunLight.shadow.camera.top = 70;
    sunLight.shadow.camera.bottom = -70;
    scene.add(sunLight);

    buildTerrain();
    buildMonumentBase();
    for (let algo = 0; algo < 4; algo++) {
      buildArmy(algo);
      buildWall(algo);
      buildInvaders(algo);
    }

    dummy = new THREE.Object3D();
    clock = new THREE.Clock();
    lastBlockAt = performance.now();

    bindControls();
    window.addEventListener('resize', onResize);
    animate();
  }

  function setSkybox(index) {
    if (!scene || !SKYBOXES.length) return;
    skyboxIndex = ((index % SKYBOXES.length) + SKYBOXES.length) % SKYBOXES.length;
    const loadId = ++skyboxLoadId;
    new THREE.TextureLoader().load(SKYBOXES[skyboxIndex], (texture) => {
      if (loadId !== skyboxLoadId) { texture.dispose(); return; } // a newer request won
      texture.mapping = THREE.EquirectangularReflectionMapping;
      // NOTE: three r149 + default linear renderer output: leave texture.encoding at
      // its linear default so sky pixels pass through unchanged (setting sRGBEncoding
      // here would darken the sky unless renderer.outputEncoding changed too).
      if (skyboxTexture) skyboxTexture.dispose();
      skyboxTexture = texture;
      scene.background = texture;
      matchFogToSky(texture);
    });
  }

  function nextSkybox() {
    setSkybox(skyboxIndex + 1);
  }

  // Tint the fog toward the skybox's horizon so distant terrain blends into the sky.
  function matchFogToSky(texture) {
    if (!scene.fog || !texture.image) return;
    try {
      const canvas = document.createElement('canvas');
      canvas.width = 16;
      canvas.height = 1;
      const ctx = canvas.getContext('2d');
      // sample a thin band just above the equator (the horizon of an equirect image)
      ctx.drawImage(texture.image, 0, texture.image.height * 0.48, texture.image.width, texture.image.height * 0.04, 0, 0, 16, 1);
      const data = ctx.getImageData(0, 0, 16, 1).data;
      let r = 0, g = 0, b = 0;
      for (let i = 0; i < data.length; i += 4) { r += data[i]; g += data[i + 1]; b += data[i + 2]; }
      const n = data.length / 4;
      scene.fog.color.setRGB(r / n / 255, g / n / 255, b / n / 255);
    } catch (_) { /* canvas sampling is cosmetic only */ }
  }

  function buildTerrain() {
    const geo = new THREE.PlaneGeometry(320, 320, 48, 48);
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), y = pos.getY(i);
      const d = Math.sqrt(x * x + y * y);
      // gentle rolling hills, flat near the center arena
      const h = d > 42 ? (Math.sin(x * 0.08) + Math.cos(y * 0.06)) * Math.min(3, (d - 42) * 0.09) : 0;
      pos.setZ(i, h);
    }
    geo.computeVertexNormals();
    const mat = new THREE.MeshLambertMaterial({ color: 0x7c8f5a, flatShading: true });
    const ground = new THREE.Mesh(geo, mat);
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    scene.add(ground);

    // arena ring
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(38, 39, 64),
      new THREE.MeshBasicMaterial({ color: 0x5c6b45, side: THREE.DoubleSide })
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.05;
    scene.add(ring);

    // scattered rocks
    const rockGeo = new THREE.DodecahedronGeometry(1, 0);
    const rockMat = new THREE.MeshLambertMaterial({ color: 0x8b8f83, flatShading: true });
    for (let i = 0; i < 26; i++) {
      const rock = new THREE.Mesh(rockGeo, rockMat);
      const a = Math.random() * Math.PI * 2;
      const r = 50 + Math.random() * 80;
      rock.position.set(Math.cos(a) * r, 0.3, Math.sin(a) * r);
      const s = 0.5 + Math.random() * 1.8;
      rock.scale.set(s, s * (0.6 + Math.random() * 0.7), s);
      rock.castShadow = true;
      scene.add(rock);
    }
  }

  function buildMonumentBase() {
    const base = new THREE.Mesh(
      new THREE.CylinderGeometry(5.5, 6.5, 1.6, 8),
      new THREE.MeshLambertMaterial({ color: 0x6d7466, flatShading: true })
    );
    base.position.y = 0.8;
    base.castShadow = true;
    base.receiveShadow = true;
    scene.add(base);
  }

  function soldierGeometry() {
    // one merged low-poly soldier: body + head
    const body = new THREE.BoxGeometry(0.9, 1.5, 0.55);
    body.translate(0, 0.75, 0);
    const head = new THREE.BoxGeometry(0.5, 0.5, 0.5);
    head.translate(0, 1.78, 0);
    const geo = mergeGeometries([body, head]);
    return geo;
  }

  function mergeGeometries(geos) {
    // minimal merge (positions/normals only) to avoid needing BufferGeometryUtils
    let total = 0;
    for (const g of geos) total += g.attributes.position.count;
    const merged = new THREE.BufferGeometry();
    const posArr = new Float32Array(total * 3);
    const normArr = new Float32Array(total * 3);
    const idx = [];
    let vOffset = 0;
    for (const g of geos) {
      posArr.set(g.attributes.position.array, vOffset * 3);
      normArr.set(g.attributes.normal.array, vOffset * 3);
      const gi = g.index.array;
      for (let i = 0; i < gi.length; i++) idx.push(gi[i] + vOffset);
      vOffset += g.attributes.position.count;
    }
    merged.setAttribute('position', new THREE.BufferAttribute(posArr, 3));
    merged.setAttribute('normal', new THREE.BufferAttribute(normArr, 3));
    merged.setIndex(idx);
    return merged;
  }

  function buildArmy(algo) {
    const geo = soldierGeometry();
    // Every defender retains its lane color; ownership is a separate marker.
    const mat = new THREE.MeshLambertMaterial({ color: 0xffffff, flatShading: true });
    const mesh = new THREE.InstancedMesh(geo, mat, MAX_UNITS);
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_UNITS * 3), 3);
    const laneColor = new THREE.Color(LANE_COLORS[algo]);
    for (let i = 0; i < MAX_UNITS; i++) mesh.setColorAt(i, laneColor);
    mesh.instanceColor.needsUpdate = true;
    mesh.castShadow = true;
    mesh.count = 0;
    scene.add(mesh);

    const mineMarkerHalo = new THREE.InstancedMesh(
      new THREE.OctahedronGeometry(0.82, 0),
      new THREE.MeshBasicMaterial({
        color: MINE_MARKER_COLOR,
        transparent: true,
        opacity: 0.22,
        depthTest: false,
        depthWrite: false,
      }),
      MAX_UNITS
    );
    mineMarkerHalo.renderOrder = 20;
    mineMarkerHalo.count = 0;
    scene.add(mineMarkerHalo);

    const mineMarkerBackplate = new THREE.InstancedMesh(
      new THREE.OctahedronGeometry(0.64, 0),
      new THREE.MeshBasicMaterial({
        color: MINE_MARKER_BACKPLATE,
        depthTest: false,
        depthWrite: false,
      }),
      MAX_UNITS
    );
    mineMarkerBackplate.renderOrder = 21;
    mineMarkerBackplate.count = 0;
    scene.add(mineMarkerBackplate);

    const mineMarker = new THREE.InstancedMesh(
      new THREE.OctahedronGeometry(0.4, 0),
      new THREE.MeshBasicMaterial({
        color: MINE_MARKER_COLOR,
        depthTest: false,
        depthWrite: false,
      }),
      MAX_UNITS
    );
    mineMarker.renderOrder = 22;
    mineMarker.count = 0;
    scene.add(mineMarker);

    const [cx, cz] = ARMY_POS[algo];
    const basePositions = [];
    // ranks facing the center
    const toCenter = Math.atan2(-cz, -cx);
    for (let i = 0; i < MAX_UNITS; i++) {
      const rank = Math.floor(i / 10);
      const file = i % 10;
      const spreadX = (file - 4.5) * 2.0;
      const spreadZ = rank * 2.2;
      // local frame: rows extend away from center
      const dirX = Math.cos(toCenter), dirZ = Math.sin(toCenter);
      const perpX = -dirZ, perpZ = dirX;
      basePositions.push({
        x: cx + perpX * spreadX - dirX * spreadZ + (Math.random() - 0.5) * 0.7,
        z: cz + perpZ * spreadX - dirZ * spreadZ + (Math.random() - 0.5) * 0.7,
        rot: toCenter + Math.PI / 2 + (Math.random() - 0.5) * 0.25,
        phase: Math.random() * Math.PI * 2,
      });
    }

    // penalty beacon (hidden by default)
    const cone = new THREE.Mesh(
      new THREE.ConeGeometry(1.4, 2.6, 6),
      new THREE.MeshBasicMaterial({ color: 0xffb640 })
    );
    cone.position.set(cx, 9, cz);
    cone.rotation.x = Math.PI;
    cone.visible = false;
    scene.add(cone);
    penaltyCones[algo] = cone;

    // banner flag
    const pole = new THREE.Mesh(
      new THREE.CylinderGeometry(0.08, 0.08, 7, 6),
      new THREE.MeshLambertMaterial({ color: 0x4a4a4a })
    );
    pole.position.set(cx * 1.25, 3.5, cz * 1.25);
    scene.add(pole);
    const flag = new THREE.Mesh(
      new THREE.PlaneGeometry(2.6, 1.5),
      new THREE.MeshBasicMaterial({ color: LANE_COLORS[algo], side: THREE.DoubleSide })
    );
    flag.position.set(cx * 1.25 + 1.3, 6.2, cz * 1.25);
    scene.add(flag);

    armies[algo] = {
      mesh,
      mineMarker,
      mineMarkerBackplate,
      mineMarkerHalo,
      count: 0,
      mineCount: 0,
      basePositions,
      charge: 0,
    };
    buildBanner(algo, cx, cz);
  }

  /**
   * Difficulty wall: a gate across the lane whose height tracks the algo's
   * current target difficulty relative to its round baseline. Rising wall =
   * LWMA pricing an attack in; a tall wall over an empty lane = stranded
   * difficulty.
   */
  function buildWall(algo) {
    const [cx, cz] = ARMY_POS[algo];
    const geo = new THREE.BoxGeometry(13, 1, 1.1);
    geo.translate(0, 0.5, 0); // anchor at ground so scale.y grows upward
    const mat = new THREE.MeshLambertMaterial({
      color: LANE_COLORS[algo],
      emissive: LANE_COLORS[algo],
      emissiveIntensity: 0.08,
      transparent: true,
      opacity: 0.82,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(cx * 0.5, 0, cz * 0.5);
    mesh.rotation.y = Math.atan2(cx, cz);
    mesh.scale.y = 2.2;
    mesh.castShadow = true;
    scene.add(mesh);

    // glowing crest along the top edge — heats up on win streaks
    const glow = new THREE.Mesh(
      new THREE.BoxGeometry(13.4, 0.35, 1.4),
      new THREE.MeshBasicMaterial({ color: LANE_COLORS[algo], transparent: true, opacity: 0.5 })
    );
    glow.position.set(cx * 0.5, 2.2, cz * 0.5);
    glow.rotation.y = mesh.rotation.y;
    scene.add(glow);

    // frost shell for TIP-004 penalty (hidden unless penalized)
    const frost = new THREE.Mesh(
      new THREE.BoxGeometry(13.6, 1, 1.7),
      new THREE.MeshLambertMaterial({
        color: 0xbfe6ff,
        emissive: 0x7ec8ff,
        emissiveIntensity: 0.25,
        transparent: true,
        opacity: 0.4,
      })
    );
    frost.geometry.translate(0, 0.5, 0);
    frost.position.copy(mesh.position);
    frost.rotation.y = mesh.rotation.y;
    frost.scale.y = 2.2;
    frost.visible = false;
    scene.add(frost);

    walls[algo] = {
      mesh, glow, frost,
      currentH: 2.2, targetH: 2.2,
      heat: 0, penalized: false,
      baseColor: new THREE.Color(LANE_COLORS[algo]),
    };
  }

  /**
   * Invading force: black-armored enemy troops per lane (attacker bot hashrate).
   * They march in from the arena edge and their distance to the tower is the
   * live "how compromised is this lane" meter: winning attack = advance,
   * rising wall / TIP-004 penalty / defenders piling in = pushed back out.
   */
  function buildInvaders(algo) {
    const geo = soldierGeometry();
    const mat = new THREE.MeshLambertMaterial({
      color: ENEMY_COLOR,
      emissive: 0x220006,
      flatShading: true,
    });
    const mesh = new THREE.InstancedMesh(geo, mat, MAX_ENEMY);
    mesh.castShadow = true;
    mesh.count = 0;
    scene.add(mesh);

    const warningMarkers = new THREE.InstancedMesh(
      new THREE.ConeGeometry(0.42, 1, 3),
      new THREE.MeshBasicMaterial({ color: ENEMY_WARNING_COLOR }),
      MAX_ENEMY
    );
    warningMarkers.count = 0;
    scene.add(warningMarkers);

    const [cx, cz] = ARMY_POS[algo];
    // enemy column flanks the lane: lateral offset so it doesn't clip the defenders
    const dirX = cx / ARMY_RADIUS, dirZ = cz / ARMY_RADIUS;
    const perpX = -dirZ, perpZ = dirX;
    const offsets = [];
    for (let i = 0; i < MAX_ENEMY; i++) {
      const rank = Math.floor(i / 9);
      const file = i % 9;
      offsets.push({
        lat: (file - 4) * 1.9 + perpX * 0 + (Math.random() - 0.5) * 0.6, // along perp axis
        depth: rank * 2.1 + (Math.random() - 0.5) * 0.6,                // behind the front line
        phase: Math.random() * Math.PI * 2,
      });
    }

    // embattled-lane glow: red quad under the lane, opacity tracks the threat
    const siege = new THREE.Mesh(
      new THREE.PlaneGeometry(16, 30),
      new THREE.MeshBasicMaterial({ color: 0xff2030, transparent: true, opacity: 0, depthWrite: false })
    );
    siege.rotation.x = -Math.PI / 2;
    siege.rotation.z = Math.atan2(cx, cz);
    siege.position.set(dirX * 24, 0.12, dirZ * 24);
    scene.add(siege);
    siegeLights[algo] = siege;

    // klaxon warning ring, flashed on hostile surges and repelled beats
    const klaxon = new THREE.Mesh(
      new THREE.RingGeometry(4, 5.2, 32),
      new THREE.MeshBasicMaterial({ color: 0xff2030, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false })
    );
    klaxon.rotation.x = -Math.PI / 2;
    klaxon.position.set(dirX * 26, 0.2, dirZ * 26);
    scene.add(klaxon);
    klaxons[algo] = klaxon;

    invaders[algo] = {
      mesh,
      warningMarkers,
      offsets,
      dir: [dirX, dirZ],
      perp: [perpX, perpZ],
      count: 0,
      threat: 0,        // eased 0..1 → distance from edge to tower
      threatTarget: 0,
      stagger: 0,       // brief backward hop when repelled
      klaxonUntil: 0,
    };
  }

  function flashKlaxon(algo, color = 0xff2030) {
    const invader = invaders[algo];
    if (!invader) return;
    invader.klaxonUntil = performance.now() + 1800;
    klaxons[algo].material.color.setHex(color);
  }

  /**
   * Per-lane power split { hostile, mine, other } from the leaderboard.
   * Friendly army size = mine+other; enemy formation size = hostile. All
   * defenders keep the lane color; violet diamonds identify your squad.
   */
  function setForces(perLane) {
    if (!started || !Array.isArray(perLane)) return;
    const totals = perLane.map((l) => (l.hostile || 0) + (l.mine || 0) + (l.other || 0));
    const unitScale = MAX_UNITS / Math.max(140, ...totals);

    for (let algo = 0; algo < 4; algo++) {
      const lane = perLane[algo] || { hostile: 0, mine: 0, other: 0 };
      laneForces[algo] = lane;
      const friendly = (lane.mine || 0) + (lane.other || 0);

      // friendly defenders
      const army = armies[algo];
      army.count = friendly > 0 ? Math.min(MAX_UNITS, Math.max(4, Math.round(friendly * unitScale))) : 0;
      army.mesh.count = army.count;
      // Your squad occupies the leading ranks and gets an ownership marker.
      army.mineCount = friendly > 0 ? Math.round((lane.mine / friendly) * army.count) : 0;
      if (army.mesh.setColorAt) {
        const laneColor = new THREE.Color(LANE_COLORS[algo]);
        for (let i = 0; i < army.count; i++) army.mesh.setColorAt(i, laneColor);
        if (army.mesh.instanceColor) army.mesh.instanceColor.needsUpdate = true;
      }
      army.mineMarker.count = army.mineCount;
      army.mineMarkerBackplate.count = army.mineCount;
      army.mineMarkerHalo.count = army.mineCount;
      army.mesh.instanceMatrix.needsUpdate = true;

      // hostile invaders
      const invader = invaders[algo];
      const hadEnemies = invader.count > 0;
      invader.count = lane.hostile > 0 ? Math.min(MAX_ENEMY, Math.max(6, Math.round(lane.hostile * unitScale))) : 0;
      invader.mesh.count = invader.count;
      invader.warningMarkers.count = invader.count;
      invader.mesh.instanceMatrix.needsUpdate = true;
      if (!hadEnemies && invader.count > 0) {
        invader.threat = 0; // march in from the edge
        flashKlaxon(algo);
      }
      updateThreat(algo);
    }
  }

  /** How far up the lane the invaders push: their proximity = network compromise. */
  function updateThreat(algo) {
    const invader = invaders[algo];
    const wall = walls[algo];
    if (!invader) return;
    const lane = laneForces[algo];
    if (!lane.hostile) {
      invader.threatTarget = 0;
      return;
    }
    const total = lane.hostile + lane.mine + lane.other;
    // grip: how much of the lane the attacker owns
    let threat = 0.25 + 0.5 * (lane.hostile / Math.max(1, total));
    // succeeding attack: the lane is winning far more than its fair 25% share
    threat += Math.max(0, laneShares[algo] - 0.3) * 0.8;
    // the wall pricing the attack in pushes them back down the lane
    const ratio = diffBaselines[algo] > 0 ? wall.targetH / 2.2 : 1;
    threat -= Math.max(0, ratio - 1) * 0.28;
    // TIP-004 penalty = actively repelled
    if (wall.penalized) {
      if (invader.threatTarget > 0.2) { invader.stagger = 1; flashKlaxon(algo, 0x7ec8ff); }
      threat = Math.min(threat, 0.1);
    }
    invader.threatTarget = Math.max(0.08, Math.min(1, threat));
  }

  function buildBanner(algo, cx, cz) {
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 160;
    const texture = new THREE.CanvasTexture(canvas);
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false }));
    sprite.position.set(cx * 1.3, 11.5, cz * 1.3);
    sprite.scale.set(15, 4.7, 1);
    scene.add(sprite);
    banners[algo] = { sprite, canvas, ctx: canvas.getContext('2d'), texture };
    drawBanner(algo, { name: ALGO_LABELS[algo], diffText: 'DIFF —', penalty: 1 });
  }

  function drawBanner(algo, { name, diffText, penalty }) {
    const banner = banners[algo];
    if (!banner) return;
    const { ctx, canvas, texture } = banner;
    const color = '#' + LANE_COLORS[algo].toString(16).padStart(6, '0');
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    ctx.fillStyle = 'rgba(10, 14, 24, 0.78)';
    ctx.strokeStyle = color;
    ctx.lineWidth = 6;
    roundRect(ctx, 6, 6, canvas.width - 12, canvas.height - 12, 18);
    ctx.fill();
    ctx.stroke();

    ctx.textAlign = 'center';
    ctx.fillStyle = color;
    ctx.font = 'bold 40px "Rajdhani", monospace';
    ctx.fillText(name.toUpperCase(), canvas.width / 2, 58);

    if (penalty > 1) {
      ctx.fillStyle = '#ff4d5e';
      ctx.font = 'bold 44px "Rajdhani", monospace';
      ctx.fillText(`${diffText} · PENALTY x${penalty}`, canvas.width / 2, 118);
    } else {
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 44px "Rajdhani", monospace';
      ctx.fillText(diffText, canvas.width / 2, 118);
    }
    texture.needsUpdate = true;
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function formatDifficulty(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return '—';
    const units = ['', 'K', 'M', 'G', 'T', 'P', 'E'];
    let u = 0;
    let v = n;
    while (v >= 1000 && u < units.length - 1) { v /= 1000; u++; }
    return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)}${units[u]}`;
  }

  function setTelemetry(entries) {
    if (!started || !Array.isArray(entries)) return;
    for (const entry of entries) {
      drawBanner(entry.algo, {
        name: ALGO_LABELS[entry.algo],
        diffText: `DIFF ${formatDifficulty(entry.difficulty)}`,
        penalty: entry.penaltyMultiplier || 1,
      });

      // Difficulty wall height: log-scaled vs the first difficulty seen this
      // round, so 2x difficulty ≈ +3.2 units of wall and movement pops.
      const wall = walls[entry.algo];
      const diff = Number(entry.difficulty);
      if (wall && Number.isFinite(diff) && diff > 0) {
        if (!diffBaselines[entry.algo]) diffBaselines[entry.algo] = diff;
        if (Number.isFinite(entry.share)) laneShares[entry.algo] = entry.share;
        const ratio = diff / diffBaselines[entry.algo];
        const prevTarget = wall.targetH;
        wall.targetH = Math.min(16, Math.max(0.9, 2.2 + 3.2 * Math.log2(Math.max(ratio, 0.01))));
        wall.penalized = (entry.penaltyMultiplier || 1) > 1;
        // sharp spike → stage a failed delivery or two before the next block clears it
        if (wall.targetH - prevTarget > 1.6) {
          wall.pendingFails = Math.min(2, (wall.pendingFails || 0) + 1);
        }
        updateThreat(entry.algo);
      }
    }
  }

  /** Cadence weather input: rolling mean solve time vs target + wall-clock pacing. */
  function setCadence({ meanBt, target = 120, speedup = 120 } = {}) {
    if (!started) return;
    expectedGapMs = Math.max(300, (target / speedup) * 1000);
    if (Number.isFinite(meanBt) && meanBt > 0) {
      // meanBt 120 -> 0 heat; 60 -> full hot
      heat = Math.max(0, Math.min(1, (target - meanBt) / (target * 0.5)));
    }
  }

  /** Back-compat: totals without ownership info — render everything as neutral. */
  function setPowers(totals) {
    if (!started) return;
    setForces([0, 1, 2, 3].map((i) => ({ hostile: 0, mine: 0, other: Number(totals?.[i] || 0) })));
  }

  function towerSlot(i) {
    // 2x2 blocks per layer keeps the monument stout instead of a needle
    const level = Math.floor(i / 4);
    const q = i % 4;
    const dx = q % 2 === 0 ? -0.85 : 0.85;
    const dz = q < 2 ? -0.85 : 0.85;
    return new THREE.Vector3(dx, 2.5 + level * 1.7, dz);
  }

  /**
   * Launch a mined block from its army over that lane's difficulty wall.
   * Low wall = flat quick toss; tall wall = high, slow arc that barely clears.
   * After a sharp difficulty spike, a dim failed attempt slams into the wall
   * first (cosmetic only — the real block always lands).
   */
  function launchBlock(algo) {
    const [cx, cz] = ARMY_POS[algo];
    const wallH = walls[algo] ? Math.max(walls[algo].currentH, walls[algo].targetH) : 2.2;
    const cube = new THREE.Mesh(
      new THREE.BoxGeometry(1.6, 1.6, 1.6),
      new THREE.MeshLambertMaterial({
        color: LANE_COLORS[algo],
        emissive: LANE_COLORS[algo],
        emissiveIntensity: 0.35,
      })
    );
    cube.castShadow = true;
    const from = new THREE.Vector3(cx * 0.9, 1.2, cz * 0.9);
    const to = towerSlot(towerBlocks.length + flyingBlocks.length);
    cube.position.copy(from);
    scene.add(cube);
    // arc peaks just above the wall; taller wall = slower, more effortful flight
    const arc = Math.max(5, wallH + 2);
    const speed = Math.max(0.55, 1.4 * (6 / arc));
    flyingBlocks.push({ mesh: cube, from, to, t: 0, arc, speed });
  }

  /** A dim block that fails to clear the wall: slams into it and crumbles. */
  function failedAttempt(algo) {
    const [cx, cz] = ARMY_POS[algo];
    const wall = walls[algo];
    if (!wall) return;
    const cube = new THREE.Mesh(
      new THREE.BoxGeometry(1.5, 1.5, 1.5),
      new THREE.MeshLambertMaterial({
        color: LANE_COLORS[algo],
        emissive: 0x000000,
        transparent: true,
        opacity: 0.65,
      })
    );
    const from = new THREE.Vector3(cx * 0.9, 1.2, cz * 0.9);
    // aims at the wall face, at the height the wall USED to be
    const impactH = Math.max(1, wall.currentH * 0.55);
    const to = new THREE.Vector3(cx * 0.54, impactH, cz * 0.54);
    cube.position.copy(from);
    scene.add(cube);
    failFx.push({ mesh: cube, from, to, t: 0, phase: 'fly', vy: 0 });
  }

  function blockMined(block) {
    if (!started) return;
    const algo = block.algo;
    armies[algo].charge = 1;

    const wall = walls[algo];
    if (wall && wall.pendingFails > 0) {
      // stage the struggle: failed slam first, real block follows a beat later
      failedAttempt(algo);
      if (wall.pendingFails > 1) setTimeout(() => { if (started) failedAttempt(algo); }, 260);
      wall.pendingFails = 0;
      setTimeout(() => { if (started) launchBlock(algo); }, 700);
    } else {
      launchBlock(algo);
    }

    if (block.penaltyMultiplier > 1) flashPenalty(algo);

    lastBlockAt = performance.now();

    // consecutive wins build heat on the winner's wall crest
    for (let i = 0; i < 4; i++) {
      const wall = walls[i];
      if (!wall) continue;
      if (i === algo) wall.heat = Math.min(1, ((block.consecutive || 0) + 1) * 0.3);
      else wall.heat = Math.max(0, wall.heat - 0.5);
    }

    if (block.orphan) orphanBlock(block.orphan);
  }

  /**
   * Depth-1 orphan: a rival block races toward the tower, gets rejected,
   * grays out, crumbles and falls off while the canonical block wins.
   */
  function orphanBlock(orphan) {
    if (!started) return;
    const algo = orphan.algo ?? 0;
    const [cx, cz] = ARMY_POS[algo];
    const cube = new THREE.Mesh(
      new THREE.BoxGeometry(1.6, 1.6, 1.6),
      new THREE.MeshLambertMaterial({
        color: LANE_COLORS[algo],
        emissive: LANE_COLORS[algo],
        emissiveIntensity: 0.35,
        transparent: true,
        opacity: 1,
      })
    );
    const from = new THREE.Vector3(cx * 0.9, 4, cz * 0.9);
    // aims just beside the current tower top — close, but not canonical
    const slot = towerSlot(towerBlocks.length + flyingBlocks.length);
    const to = new THREE.Vector3(slot.x * 3.2 + (cx > 0 ? 2.2 : -2.2), slot.y, slot.z * 3.2 + (cz > 0 ? 2.2 : -2.2));
    cube.position.copy(from);
    scene.add(cube);
    orphanFx.push({ mesh: cube, from, to, t: 0, phase: 'fly', spin: (Math.random() - 0.5) * 6 });
  }

  /** Translucent hidden-chain blocks stacking beside the tower. */
  function setShadowCount(count, algo = null) {
    if (!started) return;
    if (algo !== null && LANE_COLORS[algo]) shadowAlgoColor = LANE_COLORS[algo];
    while (shadowGhosts.length > count) {
      const ghost = shadowGhosts.pop();
      scene.remove(ghost);
    }
    while (shadowGhosts.length < count) {
      const i = shadowGhosts.length;
      const ghost = new THREE.Mesh(
        new THREE.BoxGeometry(1.7, 1.7, 1.7),
        new THREE.MeshLambertMaterial({
          color: 0x2a1b4a,
          emissive: shadowAlgoColor,
          emissiveIntensity: 0.5,
          transparent: true,
          opacity: 0.38,
        })
      );
      ghost.position.set(8.5, 1.6 + i * 1.9, 8.5);
      scene.add(ghost);
      shadowGhosts.push(ghost);
    }
  }

  /**
   * Shadow chain revealed: the top `depth` canonical blocks topple off the
   * tower and the ghost blocks slam into their places as the new canon.
   */
  function reorgEvent(depth, algo) {
    if (!started) return;
    const color = LANE_COLORS[algo] ?? 0x8844ff;

    for (let i = 0; i < depth && towerBlocks.length > 0; i++) {
      const dead = towerBlocks.pop();
      dead.material = dead.material.clone();
      dead.material.transparent = true;
      dead.material.color.setHex(0x777777);
      dead.material.emissive?.setHex?.(0x222222);
      const dir = Math.random() * Math.PI * 2;
      toppleFx.push({
        mesh: dead,
        vel: new THREE.Vector3(Math.cos(dir) * (4 + Math.random() * 4), 6 + Math.random() * 3, Math.sin(dir) * (4 + Math.random() * 4)),
        spin: new THREE.Vector3(Math.random() * 8 - 4, Math.random() * 8 - 4, Math.random() * 8 - 4),
        t: 0,
      });
    }

    // ghosts become the new canonical blocks
    for (let i = 0; i < depth; i++) {
      const cube = new THREE.Mesh(
        new THREE.BoxGeometry(1.6, 1.6, 1.6),
        new THREE.MeshLambertMaterial({ color, emissive: color, emissiveIntensity: 0.45 })
      );
      const ghost = shadowGhosts[i];
      const from = ghost ? ghost.position.clone() : new THREE.Vector3(8.5, 2 + i * 1.9, 8.5);
      const to = towerSlot(towerBlocks.length + flyingBlocks.length);
      cube.position.copy(from);
      cube.castShadow = true;
      scene.add(cube);
      flyingBlocks.push({ mesh: cube, from, to, t: 0 });
    }
    setShadowCount(0);

    // camera shake sells the rewrite
    shakeUntil = performance.now() + 700;
  }

  let shakeUntil = 0;

  function flashPenalty(algo) {
    const cone = penaltyCones[algo];
    if (!cone) return;
    cone.visible = true;
    cone.userData.until = performance.now() + 2200;
  }

  function reset() {
    if (!started) return;
    for (const b of towerBlocks) scene.remove(b);
    towerBlocks.length = 0;
    for (const f of flyingBlocks) scene.remove(f.mesh);
    flyingBlocks.length = 0;
    for (const o of orphanFx) scene.remove(o.mesh);
    orphanFx.length = 0;
    for (const d of toppleFx) scene.remove(d.mesh);
    toppleFx.length = 0;
    for (const fx of failFx) scene.remove(fx.mesh);
    failFx.length = 0;
    setShadowCount(0);
    diffBaselines = [0, 0, 0, 0];
    heat = 0;
    lastBlockAt = performance.now();
    for (const wall of walls) {
      if (!wall) continue;
      wall.targetH = 2.2;
      wall.heat = 0;
      wall.penalized = false;
      wall.pendingFails = 0;
    }
    for (const invader of invaders) {
      if (!invader) continue;
      invader.threat = 0;
      invader.threatTarget = 0;
      invader.stagger = 0;
      invader.klaxonUntil = 0;
    }
  }

  function bindControls() {
    const el = renderer.domElement;
    el.style.touchAction = 'none';
    el.addEventListener('pointerdown', (e) => {
      dragging = true;
      autoRotate = false;
      lastX = e.clientX;
      lastY = e.clientY;
    });
    window.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      camAngle -= (e.clientX - lastX) * 0.005;
      // pitch range extends below horizontal so you can look UP at a tall tower
      camPitch = Math.max(-0.22, Math.min(1.35, camPitch + (e.clientY - lastY) * 0.003));
      lastX = e.clientX;
      lastY = e.clientY;
      lastInteractAt = performance.now();
    });
    window.addEventListener('pointerup', () => {
      dragging = false;
      lastInteractAt = performance.now();
    });
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      camDist = Math.max(28, Math.min(140, camDist + e.deltaY * 0.05));
      lastInteractAt = performance.now();
    }, { passive: false });
    el.addEventListener('dblclick', () => { autoRotate = true; });
  }

  function onResize() {
    if (!started || !container) return;
    const width = container.clientWidth, height = container.clientHeight;
    if (width < 10 || height < 10) return;
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height);
  }

  function animate() {
    requestAnimationFrame(animate);
    const dt = clock.getDelta();
    const t = clock.elapsedTime;

    // auto-rotate resumes after a few idle seconds
    if (!autoRotate && !dragging && performance.now() - lastInteractAt > AUTO_ROTATE_IDLE_MS) {
      autoRotate = true;
    }
    if (autoRotate && !dragging) camAngle += dt * 0.07;

    // auto-framing: as the tower grows, the camera and its aim rise with it
    const towerTopY = 2.5 + Math.ceil(towerBlocks.length / 4) * 1.7;
    const lift = Math.max(0, towerTopY - 10) * 0.45;
    camera.position.set(
      Math.cos(camAngle) * camDist * Math.cos(camPitch),
      Math.max(1.5, Math.sin(camPitch) * camDist + lift),
      Math.sin(camAngle) * camDist * Math.cos(camPitch)
    );
    camera.lookAt(0, 3 + Math.max(0, towerTopY - 10) * 0.55, 0);

    // armies idle bob + charge pulse
    for (let algo = 0; algo < 4; algo++) {
      const army = armies[algo];
      if (!army || army.count === 0) continue;
      if (army.charge > 0) army.charge = Math.max(0, army.charge - dt * 1.6);
      const [cx, cz] = ARMY_POS[algo];
      for (let i = 0; i < army.count; i++) {
        const p = army.basePositions[i];
        const bob = Math.sin(t * 3 + p.phase) * 0.06;
        // lunge toward the center while charging
        const lunge = army.charge * 3.2 * Math.sin(Math.min(1, 1 - army.charge) * Math.PI);
        const dirX = -cx / ARMY_RADIUS, dirZ = -cz / ARMY_RADIUS;
        dummy.position.set(p.x + dirX * lunge, bob, p.z + dirZ * lunge);
        dummy.rotation.set(0, p.rot, 0);
        const hop = army.charge > 0 ? Math.abs(Math.sin(t * 10 + p.phase)) * army.charge * 0.5 : 0;
        dummy.position.y += hop;
        dummy.updateMatrix();
        army.mesh.setMatrixAt(i, dummy.matrix);
        if (i < army.mineCount) {
          const markerPulse = 0.9 + 0.12 * Math.sin(t * 5 + p.phase);
          dummy.position.y += 2.45;
          dummy.rotation.y += Math.PI / 4;
          dummy.scale.set(markerPulse, markerPulse, markerPulse);
          dummy.updateMatrix();
          army.mineMarkerHalo.setMatrixAt(i, dummy.matrix);
          army.mineMarkerBackplate.setMatrixAt(i, dummy.matrix);
          army.mineMarker.setMatrixAt(i, dummy.matrix);
          dummy.scale.set(1, 1, 1);
        }
      }
      army.mesh.instanceMatrix.needsUpdate = true;
      if (army.mineCount > 0) {
        army.mineMarkerHalo.instanceMatrix.needsUpdate = true;
        army.mineMarkerBackplate.instanceMatrix.needsUpdate = true;
        army.mineMarker.instanceMatrix.needsUpdate = true;
      }
    }

    // flying blocks: arc over the lane wall (arc height/speed set at launch)
    for (let i = flyingBlocks.length - 1; i >= 0; i--) {
      const f = flyingBlocks[i];
      f.t = Math.min(1, f.t + dt * (f.speed || 1.4));
      const e = 1 - Math.pow(1 - f.t, 3);
      f.mesh.position.lerpVectors(f.from, f.to, e);
      f.mesh.position.y += Math.sin(e * Math.PI) * (f.arc || 6);
      f.mesh.rotation.x += dt * 4;
      f.mesh.rotation.y += dt * 3;
      if (f.t >= 1) {
        f.mesh.rotation.set(0, 0, 0);
        towerBlocks.push(f.mesh);
        flyingBlocks.splice(i, 1);
        // the tower is never capped — re-seat so the stack stays packed
        towerBlocks.forEach((b, idx) => b.position.copy(towerSlot(idx)));
        flyingBlocks.forEach((fb, idx) => fb.to.copy(towerSlot(towerBlocks.length + idx)));
      }
    }

    // penalty cones blink + spin
    const now = performance.now();
    for (const cone of penaltyCones) {
      if (!cone || !cone.visible) continue;
      cone.rotation.y += dt * 4;
      cone.material.color.setHex(Math.floor(t * 6) % 2 ? 0xffb640 : 0xff4d5e);
      if (cone.userData.until && now > cone.userData.until) cone.visible = false;
    }

    animateWalls(dt, t);
    animateInvaders(dt, t, now);
    animateFailFx(dt);
    animateWeather(dt, now, t);
    animateForkFx(dt, t, now);

    if (now < shakeUntil) {
      const s = (shakeUntil - now) / 700;
      camera.position.x += (Math.random() - 0.5) * s * 1.6;
      camera.position.y += (Math.random() - 0.5) * s * 1.2;
      camera.position.z += (Math.random() - 0.5) * s * 1.6;
    }

    renderer.render(scene, camera);
  }

  function animateWalls(dt, t) {
    for (let algo = 0; algo < 4; algo++) {
      const wall = walls[algo];
      if (!wall) continue;
      wall.currentH += (wall.targetH - wall.currentH) * Math.min(1, dt * 2.2);
      wall.mesh.scale.y = wall.currentH;
      wall.frost.scale.y = wall.currentH;
      wall.glow.position.y = wall.currentH;

      // penalty: frost shell + desaturated wall
      wall.frost.visible = wall.penalized;
      if (wall.penalized) {
        wall.mesh.material.color.copy(wall.baseColor).lerp(new THREE.Color(0x8fa8c0), 0.65);
        wall.mesh.material.emissiveIntensity = 0.03;
      } else {
        wall.mesh.material.color.copy(wall.baseColor);
        wall.mesh.material.emissiveIntensity = 0.08 + wall.heat * 0.5;
      }

      // streak heat: crest glows white-hot and pulses
      const pulse = wall.heat > 0 ? 0.5 + 0.5 * Math.sin(t * 8) : 0;
      wall.glow.material.opacity = 0.35 + wall.heat * 0.55 * (0.6 + 0.4 * pulse);
      wall.glow.material.color.copy(wall.baseColor).lerp(new THREE.Color(0xffffff), wall.heat * 0.7);
    }
  }

  /**
   * Enemy troops march along the lane: threat eases toward its target so
   * advances and retreats read as actual marching, not teleporting.
   * Radius 46 (arena edge) → 9 (at the tower walls).
   */
  function animateInvaders(dt, t, now) {
    for (let algo = 0; algo < 4; algo++) {
      const invader = invaders[algo];
      if (!invader) continue;

      // march toward the target line (retreats are a bit quicker — a rout)
      const delta = invader.threatTarget - invader.threat;
      const marchRate = delta >= 0 ? 0.09 : 0.16;
      const staggerBoost = invader.stagger > 0 ? 2.5 : 1;
      invader.threat += Math.sign(delta) * Math.min(Math.abs(delta), dt * marchRate * staggerBoost);
      if (invader.stagger > 0) invader.stagger = Math.max(0, invader.stagger - dt * 1.2);
      const marching = Math.abs(delta) > 0.005;

      // embattled-lane glow follows how deep they've pushed
      const siege = siegeLights[algo];
      if (siege) siege.material.opacity = invader.count > 0 ? 0.05 + invader.threat * 0.22 : 0;

      // klaxon flash
      const klaxon = klaxons[algo];
      if (klaxon) {
        if (now < invader.klaxonUntil) {
          const s = 1 + ((invader.klaxonUntil - now) % 450) / 450;
          klaxon.scale.set(s, s, 1);
          klaxon.material.opacity = Math.floor(t * 8) % 2 ? 0.75 : 0.25;
        } else {
          klaxon.material.opacity = 0;
        }
      }

      if (invader.count === 0) continue;
      const frontR = 46 - invader.threat * 37; // 46 edge → 9 tower gates
      const [dirX, dirZ] = invader.dir;
      const [perpX, perpZ] = invader.perp;
      for (let i = 0; i < invader.count; i++) {
        const o = invader.offsets[i];
        const r = frontR + o.depth;
        const marchBob = marching ? Math.abs(Math.sin(t * 9 + o.phase)) * 0.35 : Math.sin(t * 3 + o.phase) * 0.06;
        dummy.position.set(
          dirX * r + perpX * o.lat,
          marchBob,
          dirZ * r + perpZ * o.lat
        );
        // face the tower (they're always oriented at the objective)
        dummy.rotation.set(0, Math.atan2(-dirX, -dirZ), 0);
        dummy.scale.set(ENEMY_SCALE, ENEMY_SCALE, ENEMY_SCALE);
        dummy.updateMatrix();
        invader.mesh.setMatrixAt(i, dummy.matrix);
        dummy.scale.set(1, 1, 1);
        const warningPulse = 0.9 + 0.22 * Math.sin(t * 7 + o.phase);
        dummy.position.y += 2.75;
        dummy.rotation.x = Math.PI;
        dummy.scale.set(warningPulse, warningPulse, warningPulse);
        dummy.updateMatrix();
        invader.warningMarkers.setMatrixAt(i, dummy.matrix);
        dummy.scale.set(1, 1, 1);
      }
      invader.mesh.instanceMatrix.needsUpdate = true;
      invader.warningMarkers.instanceMatrix.needsUpdate = true;
    }
  }

  /** Failed deliveries: fly at the wall, slam, crumble down its face. */
  function animateFailFx(dt) {
    for (let i = failFx.length - 1; i >= 0; i--) {
      const fx = failFx[i];
      if (fx.phase === 'fly') {
        fx.t = Math.min(1, fx.t + dt * 2.2);
        const e = fx.t;
        fx.mesh.position.lerpVectors(fx.from, fx.to, e);
        fx.mesh.position.y += Math.sin(e * Math.PI) * 2.5; // flat, doomed arc
        fx.mesh.rotation.x += dt * 5;
        if (fx.t >= 1) {
          fx.phase = 'crumble';
          fx.t = 0;
          fx.vy = 0.5;
        }
      } else {
        fx.t += dt;
        fx.vy -= dt * 12;
        fx.mesh.position.y += fx.vy * dt;
        fx.mesh.rotation.z += dt * 3;
        const shrink = Math.max(0.05, 1 - fx.t * 1.2);
        fx.mesh.scale.set(shrink, shrink, shrink);
        fx.mesh.material.opacity = Math.max(0, 0.65 - fx.t);
        if (fx.mesh.position.y < 0 || fx.mesh.material.opacity <= 0) {
          scene.remove(fx.mesh);
          failFx.splice(i, 1);
        }
      }
    }
  }

  function animateWeather(dt, now, t) {
    if (!hemiLight || !sunLight) return;
    // stall pressure: how many expected block intervals have passed silently
    const stall = Math.max(0, (now - lastBlockAt) / expectedGapMs - 1.8);
    const gloom = Math.min(1, stall / 3);

    // lights: dim toward gloom, warm up with heat
    const dimmed = 1 - gloom * 0.55;
    hemiLight.intensity += ((HEMI_BASE * dimmed) - hemiLight.intensity) * Math.min(1, dt * 1.5);
    sunLight.intensity += ((SUN_BASE * (dimmed + heat * 0.25)) - sunLight.intensity) * Math.min(1, dt * 1.5);
    sunLight.color.setHex(0xfff3d6);
    if (heat > 0.25) sunLight.color.lerp(new THREE.Color(0xff5533), (heat - 0.25) * 0.5);

    // fog: thicken when stalled (augments the skybox, color stays sky-matched)
    if (scene.fog) {
      const near = FOG_NEAR * (1 - gloom * 0.62);
      const far = FOG_FAR * (1 - gloom * 0.5);
      scene.fog.near += (near - scene.fog.near) * Math.min(1, dt * 1.2);
      scene.fog.far += (far - scene.fog.far) * Math.min(1, dt * 1.2);
    }
  }

  function animateForkFx(dt, t, now) {
    // orphan blocks: fly in, hover + gray out, crumble off
    for (let i = orphanFx.length - 1; i >= 0; i--) {
      const fx = orphanFx[i];
      if (fx.phase === 'fly') {
        fx.t = Math.min(1, fx.t + dt * 1.6);
        const e = 1 - Math.pow(1 - fx.t, 3);
        fx.mesh.position.lerpVectors(fx.from, fx.to, e);
        fx.mesh.position.y += Math.sin(e * Math.PI) * 5;
        fx.mesh.rotation.x += dt * 4;
        fx.mesh.rotation.y += dt * 3;
        if (fx.t >= 1) { fx.phase = 'reject'; fx.t = 0; }
      } else if (fx.phase === 'reject') {
        // gray out in place, trembling
        fx.t += dt;
        const gray = Math.min(1, fx.t / 0.7);
        fx.mesh.material.color.lerp(new THREE.Color(0x6f6f6f), gray * 0.3);
        fx.mesh.material.emissiveIntensity = 0.35 * (1 - gray);
        fx.mesh.position.x += (Math.random() - 0.5) * 0.06;
        fx.mesh.position.z += (Math.random() - 0.5) * 0.06;
        if (fx.t >= 0.9) { fx.phase = 'fall'; fx.t = 0; fx.vy = 1.5; }
      } else {
        // crumble and fall off the tower
        fx.t += dt;
        fx.vy -= dt * 14;
        fx.mesh.position.y += fx.vy * dt;
        fx.mesh.rotation.x += dt * fx.spin;
        fx.mesh.rotation.z += dt * fx.spin * 0.7;
        const shrink = Math.max(0.05, 1 - fx.t * 0.8);
        fx.mesh.scale.set(shrink, shrink, shrink);
        fx.mesh.material.opacity = Math.max(0, 1 - fx.t * 1.1);
        if (fx.mesh.position.y < -2 || fx.mesh.material.opacity <= 0) {
          scene.remove(fx.mesh);
          orphanFx.splice(i, 1);
        }
      }
    }

    // reorg debris: toppled canonical blocks tumble away
    for (let i = toppleFx.length - 1; i >= 0; i--) {
      const fx = toppleFx[i];
      fx.t += dt;
      fx.vel.y -= dt * 16;
      fx.mesh.position.addScaledVector(fx.vel, dt);
      fx.mesh.rotation.x += fx.spin.x * dt;
      fx.mesh.rotation.y += fx.spin.y * dt;
      fx.mesh.rotation.z += fx.spin.z * dt;
      fx.mesh.material.opacity = Math.max(0, 1 - fx.t * 0.7);
      if (fx.mesh.position.y < -4 || fx.mesh.material.opacity <= 0) {
        scene.remove(fx.mesh);
        toppleFx.splice(i, 1);
      }
    }

    // shadow ghosts pulse ominously
    for (let i = 0; i < shadowGhosts.length; i++) {
      const ghost = shadowGhosts[i];
      ghost.material.opacity = 0.3 + 0.18 * Math.sin(t * 2.4 + i * 0.9);
      ghost.rotation.y += dt * 0.4;
    }
  }

  return {
    init, setPowers, blockMined, setTelemetry, reset, onResize, setSkybox, nextSkybox,
    setForces, setCadence, orphanBlock, setShadowCount, reorgEvent,
  };
})();

if (typeof window !== 'undefined') window.Battlefield = Battlefield;
