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
  const TOWER_MAX = 40;

  let renderer = null;
  let scene = null;
  let camera = null;
  let container = null;
  let started = false;

  const armies = [];        // per algo: { mesh, count, basePositions, charge }
  const towerBlocks = [];   // meshes stacked in the middle
  const flyingBlocks = [];  // { mesh, from, to, t }
  const penaltyCones = [];
  const banners = [];       // per algo floating telemetry sprite
  let dummy = null;
  let clock = null;

  // camera orbit
  let camAngle = 0.6;
  let camPitch = 0.32;
  let camDist = 62;
  let autoRotate = true;
  let dragging = false;
  let lastX = 0, lastY = 0;

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
    scene.background = new THREE.Color(0x9db8d6);
    scene.fog = new THREE.Fog(0x9db8d6, 90, 220);

    camera = new THREE.PerspectiveCamera(48, width / height, 0.1, 500);

    // Lights
    const hemi = new THREE.HemisphereLight(0xdfeaff, 0x59684a, 1.05);
    scene.add(hemi);
    const sun = new THREE.DirectionalLight(0xfff3d6, 1.4);
    sun.position.set(40, 60, 25);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.left = -70;
    sun.shadow.camera.right = 70;
    sun.shadow.camera.top = 70;
    sun.shadow.camera.bottom = -70;
    scene.add(sun);

    buildTerrain();
    buildMonumentBase();
    for (let algo = 0; algo < 4; algo++) buildArmy(algo);

    dummy = new THREE.Object3D();
    clock = new THREE.Clock();

    bindControls();
    window.addEventListener('resize', onResize);
    animate();
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
    const mat = new THREE.MeshLambertMaterial({ color: LANE_COLORS[algo], flatShading: true });
    const mesh = new THREE.InstancedMesh(geo, mat, MAX_UNITS);
    mesh.castShadow = true;
    mesh.count = 0;
    scene.add(mesh);

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

    armies[algo] = { mesh, count: 0, basePositions, charge: 0 };
    buildBanner(algo, cx, cz);
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
    }
  }

  function setPowers(totals) {
    if (!started) return;
    const values = [0, 1, 2, 3].map((i) => Number(totals?.[i] || 0));
    const max = Math.max(1, ...values);
    for (let algo = 0; algo < 4; algo++) {
      const share = values[algo] / max;
      armies[algo].count = values[algo] > 0 ? Math.max(6, Math.round(share * MAX_UNITS)) : 0;
      armies[algo].mesh.count = armies[algo].count;
      armies[algo].mesh.instanceMatrix.needsUpdate = true;
    }
  }

  function towerSlot(i) {
    // 2x2 blocks per layer keeps the monument stout instead of a needle
    const level = Math.floor(i / 4);
    const q = i % 4;
    const dx = q % 2 === 0 ? -0.85 : 0.85;
    const dz = q < 2 ? -0.85 : 0.85;
    return new THREE.Vector3(dx, 2.5 + level * 1.7, dz);
  }

  function blockMined(block) {
    if (!started) return;
    const algo = block.algo;
    armies[algo].charge = 1;

    // spawn a block cube above the winning army, fly it to the tower
    const [cx, cz] = ARMY_POS[algo];
    const cube = new THREE.Mesh(
      new THREE.BoxGeometry(1.6, 1.6, 1.6),
      new THREE.MeshLambertMaterial({
        color: LANE_COLORS[algo],
        emissive: LANE_COLORS[algo],
        emissiveIntensity: 0.35,
      })
    );
    cube.castShadow = true;
    const from = new THREE.Vector3(cx * 0.9, 4, cz * 0.9);
    const to = towerSlot(towerBlocks.length + flyingBlocks.length);
    cube.position.copy(from);
    scene.add(cube);
    flyingBlocks.push({ mesh: cube, from, to, t: 0 });

    if (block.penaltyMultiplier > 1) flashPenalty(algo);
  }

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
      camPitch = Math.max(0.12, Math.min(1.2, camPitch + (e.clientY - lastY) * 0.003));
      lastX = e.clientX;
      lastY = e.clientY;
    });
    window.addEventListener('pointerup', () => { dragging = false; });
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      camDist = Math.max(28, Math.min(120, camDist + e.deltaY * 0.05));
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

    if (autoRotate && !dragging) camAngle += dt * 0.07;
    camera.position.set(
      Math.cos(camAngle) * camDist * Math.cos(camPitch),
      Math.sin(camPitch) * camDist,
      Math.sin(camAngle) * camDist * Math.cos(camPitch)
    );
    camera.lookAt(0, 3, 0);

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
      }
      army.mesh.instanceMatrix.needsUpdate = true;
    }

    // flying blocks
    for (let i = flyingBlocks.length - 1; i >= 0; i--) {
      const f = flyingBlocks[i];
      f.t = Math.min(1, f.t + dt * 1.4);
      const e = 1 - Math.pow(1 - f.t, 3);
      f.mesh.position.lerpVectors(f.from, f.to, e);
      f.mesh.position.y += Math.sin(e * Math.PI) * 6; // arc
      f.mesh.rotation.x += dt * 4;
      f.mesh.rotation.y += dt * 3;
      if (f.t >= 1) {
        f.mesh.rotation.set(0, 0, 0);
        towerBlocks.push(f.mesh);
        flyingBlocks.splice(i, 1);
        if (towerBlocks.length > TOWER_MAX) {
          scene.remove(towerBlocks.shift());
        }
        // re-seat every landed block so the stack stays packed after removals
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

    renderer.render(scene, camera);
  }

  return { init, setPowers, blockMined, setTelemetry, reset, onResize };
})();

if (typeof window !== 'undefined') window.Battlefield = Battlefield;
