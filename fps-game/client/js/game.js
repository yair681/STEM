// ═══════════════════════════════════════════════════════════════
//  FPS Arena – Client Game Logic
// ═══════════════════════════════════════════════════════════════

// ─── Color Picker ───────────────────────────────────────────────
const COLORS = ['#e74c3c','#3498db','#2ecc71','#f39c12','#9b59b6','#1abc9c','#e67e22','#ecf0f1'];
let selectedColor = COLORS[0];
const colorRow = document.getElementById('color-row');
COLORS.forEach(c => {
  const btn = document.createElement('div');
  btn.className = 'color-btn' + (c === selectedColor ? ' selected' : '');
  btn.style.background = c;
  btn.onclick = () => {
    document.querySelectorAll('.color-btn').forEach(b => b.classList.remove('selected'));
    btn.classList.add('selected');
    selectedColor = c;
  };
  colorRow.appendChild(btn);
});

// ─── Scene Setup ────────────────────────────────────────────────
const canvas = document.getElementById('canvas');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.setClearColor(0x87ceeb);

const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0x87ceeb, 0.018);

const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 200);
camera.position.set(0, 1.6, 0);

window.addEventListener('resize', () => {
  renderer.setSize(window.innerWidth, window.innerHeight);
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
});

// ─── Lighting ────────────────────────────────────────────────────
const ambient = new THREE.AmbientLight(0xffffff, 0.5);
scene.add(ambient);
const sun = new THREE.DirectionalLight(0xffffff, 1);
sun.position.set(20, 40, 20);
sun.castShadow = true;
sun.shadow.mapSize.width = 2048;
sun.shadow.mapSize.height = 2048;
sun.shadow.camera.near = 0.1;
sun.shadow.camera.far = 200;
sun.shadow.camera.left = -60;
sun.shadow.camera.right = 60;
sun.shadow.camera.top = 60;
sun.shadow.camera.bottom = -60;
scene.add(sun);

// ─── Materials ───────────────────────────────────────────────────
const floorMat = new THREE.MeshLambertMaterial({ color: 0x4a5568 });
const wallMat  = new THREE.MeshLambertMaterial({ color: 0x718096 });
const boxMats  = [
  new THREE.MeshLambertMaterial({ color: 0x8B4513 }),
  new THREE.MeshLambertMaterial({ color: 0x6B8E23 }),
  new THREE.MeshLambertMaterial({ color: 0x2F4F4F }),
];
const skyMat   = new THREE.MeshBasicMaterial({ color: 0x87ceeb, side: THREE.BackSide });
const weaponPickupMat = new THREE.MeshLambertMaterial({ color: 0xffd700, emissive: 0x886600 });

// ─── Skydome ─────────────────────────────────────────────────────
const sky = new THREE.Mesh(new THREE.SphereGeometry(180, 16, 16), skyMat);
scene.add(sky);

// ─── State ───────────────────────────────────────────────────────
let myId = null;
let myName = '';
let gameInited = false;
let isLocked = false;
let isAlive = true;

let camYaw = 0, camPitch = 0;
const keys = {};

let health = 100;
let currentWeapon = 'pistol';
let myWeapons = {};
const WEAPONS_DEF = {};

let remotePlayers = {};
let bulletMeshes = {};
let mapMeshes = [];
let pickupMeshes = {};
let levelData = null;

let scores = {};
let showScoreboard = false;
let nearPickup = null;
let reloading = false;
let reloadTimeout = null;

const playerHeight = 1.6;
const gravity = 0.01;
let velY = 0;
let onGround = true;

// Weapon bob
let bobTime = 0;
let weaponMesh = null;
let muzzleFlash = null;
const clock = new THREE.Clock();

// ─── Socket ──────────────────────────────────────────────────────
let socket = null;

function joinGame() {
  const nameInput = document.getElementById('player-name').value.trim() || 'שחקן';
  myName = nameInput;

  document.getElementById('lobby').style.display = 'none';
  document.getElementById('connecting').style.display = 'flex';

  socket = io(window.location.origin);

  socket.on('connect', () => {
    socket.emit('join', { name: myName, color: selectedColor });
  });

  socket.on('init', (data) => {
    myId = data.id;
    Object.assign(WEAPONS_DEF, data.weapons);
    myWeapons = { pistol: { ...WEAPONS_DEF.pistol } };
    scores = data.scores || {};
    levelData = data.levelData;

    buildLevel(data.level, data.levelData);
    buildPickups(data.pickups || []);

    for (const [id, p] of Object.entries(data.players || {})) {
      if (id !== myId && p) createRemotePlayer(id, p);
    }

    document.getElementById('connecting').style.display = 'none';
    document.getElementById('hud').style.display = 'block';
    document.getElementById('crosshair').style.display = 'block';
    document.getElementById('level-display').style.display = 'block';
    document.getElementById('level-display').textContent = `שלב: ${data.levelData.name}`;
    document.getElementById('weapon-slots').style.display = 'flex';

    updateHUD();
    updateWeaponSlots();
    gameInited = true;

    document.getElementById('click-to-play').style.display = 'flex';
  });

  socket.on('gameState', (state) => {
    if (!gameInited) return;
    updateRemotePlayers(state.players);
    updateBullets(state.bullets);
    updatePickupVisibility(state.pickups);
    if (showScoreboard) renderScoreboard();
  });

  socket.on('playerJoined', (p) => { if (p && p.id !== myId) createRemotePlayer(p.id, p); });
  socket.on('playerLeft',   ({ id }) => removeRemotePlayer(id));
  socket.on('playerUpdate', (p) => { if (p && p.id !== myId) updateRemotePlayer(p.id, p); });

  socket.on('hit', ({ damage, health: h }) => {
    health = h;
    updateHealthBar();
    flashDamage();
  });

  socket.on('hitConfirm', () => {
    const ch = document.getElementById('crosshair');
    ch.classList.add('hit');
    setTimeout(() => ch.classList.remove('hit'), 80);
  });

  socket.on('playerDied', ({ deadId, killerId, scores: s }) => {
    scores = s;
    const killerName = deadId === myId ? 'אתה' : (remotePlayers[killerId]?.name || 'שחקן');
    const deadName   = deadId === myId ? 'אתה' : (remotePlayers[deadId]?.name || 'שחקן');
    addKillFeed(`${killerName} הרג את ${deadName}`);

    if (deadId === myId) {
      isAlive = false;
      showDeathScreen(remotePlayers[killerId]?.name || 'שחקן');
    }
  });

  socket.on('respawn', ({ x, z }) => {
    camera.position.set(x, playerHeight, z);
    camYaw = 0; camPitch = 0;
    health = 100; isAlive = true;
    updateHealthBar();
    document.getElementById('death-screen').style.display = 'none';
    updateHUD();
  });

  socket.on('ammoUpdate', ({ weapon, ammo, maxAmmo }) => {
    if (myWeapons[weapon]) {
      myWeapons[weapon].ammo = ammo;
      if (maxAmmo !== undefined) myWeapons[weapon].maxAmmo = maxAmmo;
    }
    if (weapon === currentWeapon) updateAmmoDisplay();
    if (reloading && maxAmmo !== undefined) {
      reloading = false;
      document.getElementById('reload-indicator').style.display = 'none';
    }
  });

  socket.on('weaponPickedUp', ({ weapon, weapons, currentWeapon: cw }) => {
    for (const [k, v] of Object.entries(weapons)) myWeapons[k] = v;
    currentWeapon = cw;
    updateWeaponSlots();
    updateAmmoDisplay();
    socket.emit('switchWeapon', { weapon: currentWeapon });
  });

  socket.on('pickupRespawn', ({ id }) => {
    const m = pickupMeshes[id];
    if (m) m.visible = true;
  });

  socket.on('levelChange', ({ level, levelData: ld, pickups }) => {
    clearLevel();
    buildLevel(level, ld);
    buildPickups(pickups);
    levelData = ld;
    document.getElementById('level-display').textContent = `שלב: ${ld.name}`;
  });

  socket.on('outOfAmmo', () => {
    if (!reloading) startReload();
  });

  socket.on('disconnect', () => {
    if (gameInited) {
      document.getElementById('click-to-play').style.display = 'none';
    }
  });
}

// ─── Level Builder ───────────────────────────────────────────────
function buildLevel(levelIndex, ld) {
  // Floor
  const floorGeo = new THREE.PlaneGeometry(120, 120, 20, 20);
  const floor = new THREE.Mesh(floorGeo, floorMat);
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);
  mapMeshes.push(floor);

  // Boxes
  ld.boxes.forEach((b, i) => {
    const geo  = new THREE.BoxGeometry(b.sx, b.sy, b.sz);
    const mat  = boxMats[i % boxMats.length];
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(b.x, b.sy / 2, b.z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    scene.add(mesh);
    mapMeshes.push(mesh);
  });

  // Sky color variation
  if (levelIndex === 1) {
    renderer.setClearColor(0xd4a0a0);
    scene.fog = new THREE.FogExp2(0xd4a0a0, 0.018);
    skyMat.color.set(0xd4a0a0);
  } else {
    renderer.setClearColor(0x87ceeb);
    scene.fog = new THREE.FogExp2(0x87ceeb, 0.018);
    skyMat.color.set(0x87ceeb);
  }
}

function clearLevel() {
  for (const m of mapMeshes) scene.remove(m);
  mapMeshes = [];
  for (const id of Object.keys(pickupMeshes)) {
    scene.remove(pickupMeshes[id]);
  }
  pickupMeshes = {};
}

function buildPickups(pickups) {
  pickups.forEach(p => {
    const geo  = new THREE.SphereGeometry(0.3, 8, 8);
    const mesh = new THREE.Mesh(geo, weaponPickupMat);
    mesh.position.set(p.x, 0.5, p.z);
    mesh.visible = p.active;
    mesh.userData = { weapon: p.weapon, id: p.id };
    scene.add(mesh);
    pickupMeshes[p.id] = mesh;
  });
}

function updatePickupVisibility(pickups) {
  for (const pu of (pickups || [])) {
    if (pickupMeshes[pu.id]) pickupMeshes[pu.id].visible = pu.active;
  }
}

// ─── Remote Players ──────────────────────────────────────────────
function createRemotePlayer(id, data) {
  const group = new THREE.Group();

  // Body
  const body = new THREE.Mesh(
    new THREE.CapsuleGeometry ? new THREE.CapsuleGeometry(0.4, 1.0, 4, 8)
                               : new THREE.CylinderGeometry(0.4, 0.4, 1.8, 8),
    new THREE.MeshLambertMaterial({ color: new THREE.Color(data.color || '#3498db') })
  );
  body.position.y = 0.9;
  group.add(body);

  // Head
  const head = new THREE.Mesh(
    new THREE.SphereGeometry(0.3, 8, 8),
    new THREE.MeshLambertMaterial({ color: new THREE.Color(data.color || '#3498db') })
  );
  head.position.y = 2.1;
  group.add(head);

  // Name tag (using a simple approach)
  group.position.set(data.x || 0, 0, data.z || 0);
  group.rotation.y = data.rotY || 0;
  scene.add(group);

  remotePlayers[id] = { mesh: group, name: data.name || 'שחקן', color: data.color, alive: true };
}

function removeRemotePlayer(id) {
  if (remotePlayers[id]) {
    scene.remove(remotePlayers[id].mesh);
    delete remotePlayers[id];
  }
}

function updateRemotePlayers(stateMap) {
  if (!stateMap) return;
  for (const [id, p] of Object.entries(stateMap)) {
    if (id === myId || !p) continue;
    if (!remotePlayers[id]) createRemotePlayer(id, p);
    const rp = remotePlayers[id];
    rp.mesh.position.set(p.x, 0, p.z);
    rp.mesh.rotation.y = p.rotY || 0;
    rp.mesh.visible = p.alive !== false;
    rp.name = p.name;
    rp.alive = p.alive;
  }
  // Remove players no longer in state
  for (const id of Object.keys(remotePlayers)) {
    if (!stateMap[id] && id !== myId) removeRemotePlayer(id);
  }
}

function updateRemotePlayer(id, p) {
  if (!remotePlayers[id]) createRemotePlayer(id, p);
  const rp = remotePlayers[id];
  rp.mesh.position.set(p.x, 0, p.z);
  rp.mesh.rotation.y = p.rotY || 0;
  rp.mesh.visible = p.alive !== false;
  rp.name = p.name;
}

// ─── Bullets ─────────────────────────────────────────────────────
const bulletGeo = new THREE.SphereGeometry(0.06, 4, 4);
const bulletMat = new THREE.MeshBasicMaterial({ color: 0xffff00 });

function updateBullets(serverBullets) {
  const ids = new Set((serverBullets || []).map(b => b.id));
  // Add new
  for (const b of (serverBullets || [])) {
    if (!bulletMeshes[b.id]) {
      const m = new THREE.Mesh(bulletGeo, bulletMat);
      scene.add(m);
      bulletMeshes[b.id] = m;
    }
    bulletMeshes[b.id].position.set(b.x, b.y, b.z);
  }
  // Remove old
  for (const id of Object.keys(bulletMeshes)) {
    if (!ids.has(Number(id))) {
      scene.remove(bulletMeshes[id]);
      delete bulletMeshes[id];
    }
  }
}

// ─── Weapon Model ────────────────────────────────────────────────
const weaponColors = { pistol: 0x888888, rifle: 0x336633, shotgun: 0x663333, sniper: 0x333366 };

function buildWeaponMesh(type) {
  const group = new THREE.Group();
  const color = weaponColors[type] || 0x888888;
  const mat = new THREE.MeshLambertMaterial({ color });

  // Barrel
  const barrel = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.06, type === 'sniper' ? 0.7 : 0.4), mat);
  barrel.position.set(0, 0, -0.2);
  group.add(barrel);

  // Body
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.2), mat);
  body.position.set(0, -0.02, 0.05);
  group.add(body);

  // Muzzle flash
  const flashMat = new THREE.MeshBasicMaterial({ color: 0xffff00, transparent: true, opacity: 0 });
  const flash = new THREE.Mesh(new THREE.SphereGeometry(0.08, 6, 6), flashMat);
  flash.position.set(0, 0, type === 'sniper' ? -0.62 : -0.42);
  group.add(flash);
  muzzleFlash = flash;

  return group;
}

function equip(type) {
  if (weaponMesh) camera.remove(weaponMesh);
  weaponMesh = buildWeaponMesh(type);
  weaponMesh.position.set(0.2, -0.22, -0.4);
  camera.add(weaponMesh);
}

// ─── Controls ────────────────────────────────────────────────────
function requestPointerLock() {
  canvas.requestPointerLock();
}

document.addEventListener('pointerlockchange', () => {
  isLocked = document.pointerLockElement === canvas;
  document.getElementById('click-to-play').style.display = isLocked ? 'none' : 'flex';
});

document.addEventListener('mousemove', (e) => {
  if (!isLocked || !isAlive) return;
  const sens = 0.002;
  camYaw   -= e.movementX * sens;
  camPitch -= e.movementY * sens;
  camPitch  = Math.max(-Math.PI * 0.45, Math.min(Math.PI * 0.45, camPitch));
});

document.addEventListener('keydown', (e) => {
  keys[e.code] = true;

  if (e.code === 'KeyR' && !reloading && isAlive) startReload();
  if (e.code === 'KeyF' && isAlive) tryPickup();
  if (e.code === 'Tab') { e.preventDefault(); showScoreboard = true; document.getElementById('scoreboard').style.display = 'block'; }

  // Weapon switch
  const slots = ['Digit1','Digit2','Digit3','Digit4'];
  const wKeys = ['pistol','rifle','shotgun','sniper'];
  const idx = slots.indexOf(e.code);
  if (idx !== -1 && myWeapons[wKeys[idx]] && isAlive) {
    currentWeapon = wKeys[idx];
    socket.emit('switchWeapon', { weapon: currentWeapon });
    equip(currentWeapon);
    updateWeaponSlots();
    updateAmmoDisplay();
  }
});

document.addEventListener('keyup', (e) => {
  keys[e.code] = false;
  if (e.code === 'Tab') { showScoreboard = false; document.getElementById('scoreboard').style.display = 'none'; }
});

let lastShot = 0;
document.addEventListener('mousedown', (e) => {
  if (!isLocked || !isAlive || !gameInited) return;
  if (e.button === 0) shoot();
});

document.addEventListener('mouseup', (e) => { keys['MouseLeft'] = false; });

// ─── Shooting ────────────────────────────────────────────────────
let autoFireInterval = null;
function startAutoFire() {
  if (!WEAPONS_DEF[currentWeapon]) return;
  if (currentWeapon === 'rifle') {
    autoFireInterval = setInterval(() => { if (keys['MouseLeft'] && isLocked && isAlive) shoot(); }, WEAPONS_DEF.rifle.fireRate);
  }
}

document.addEventListener('mousedown', (e) => { if (e.button === 0) { keys['MouseLeft'] = true; if (currentWeapon === 'rifle') startAutoFire(); } });
document.addEventListener('mouseup', (e) => { if (e.button === 0) { clearInterval(autoFireInterval); } });

function shoot() {
  if (!socket || !isAlive) return;
  const now = Date.now();
  const fireRate = WEAPONS_DEF[currentWeapon]?.fireRate || 400;
  if (now - lastShot < fireRate) return;
  lastShot = now;

  // Direction from camera
  const dir = new THREE.Vector3(0, 0, -1);
  dir.applyEuler(new THREE.Euler(camPitch, camYaw, 0, 'YXZ'));

  socket.emit('shoot', { dx: dir.x, dy: dir.y, dz: dir.z, weapon: currentWeapon });

  // Muzzle flash
  if (muzzleFlash) {
    muzzleFlash.material.opacity = 1;
    setTimeout(() => { if (muzzleFlash) muzzleFlash.material.opacity = 0; }, 60);
  }

  // Recoil bob
  bobTime += 0.5;
}

// ─── Reload ──────────────────────────────────────────────────────
const RELOAD_TIMES = { pistol: 1200, rifle: 1800, shotgun: 2200, sniper: 2500 };

function startReload() {
  if (reloading) return;
  const w = myWeapons[currentWeapon];
  if (!w || w.ammo === WEAPONS_DEF[currentWeapon]?.ammo) return;
  reloading = true;
  const t = RELOAD_TIMES[currentWeapon] || 1500;
  const ri = document.getElementById('reload-indicator');
  const rb = document.getElementById('reload-bar');
  ri.style.display = 'block';
  rb.style.transition = `width ${t}ms linear`;
  rb.style.width = '100%';

  reloadTimeout = setTimeout(() => {
    socket.emit('reload', { weapon: currentWeapon });
    reloading = false;
    ri.style.display = 'none';
    rb.style.width = '0%';
    rb.style.transition = 'none';
  }, t);
}

// ─── Pickup ──────────────────────────────────────────────────────
function tryPickup() {
  if (!nearPickup || !socket) return;
  socket.emit('pickupWeapon', { pickupId: nearPickup.id });
}

function checkNearPickups() {
  const px = camera.position.x, pz = camera.position.z;
  nearPickup = null;
  document.getElementById('pickup-hint').style.display = 'none';

  for (const [id, mesh] of Object.entries(pickupMeshes)) {
    if (!mesh.visible) continue;
    const dx = px - mesh.position.x, dz = pz - mesh.position.z;
    if (Math.sqrt(dx*dx + dz*dz) < 2.5) {
      nearPickup = mesh.userData;
      const wName = WEAPONS_DEF[nearPickup.weapon]?.name || nearPickup.weapon;
      const ph = document.getElementById('pickup-hint');
      ph.style.display = 'block';
      ph.textContent = `לחץ F לאסוף ${wName}`;
      break;
    }
  }
}

// ─── Player Movement ─────────────────────────────────────────────
const moveVec = new THREE.Vector3();

function updateMovement(dt) {
  if (!isAlive || !isLocked) return;

  const speed = PLAYER_SPEED * (dt / 16);
  moveVec.set(0, 0, 0);

  if (keys['KeyW'] || keys['ArrowUp'])    moveVec.z -= 1;
  if (keys['KeyS'] || keys['ArrowDown'])  moveVec.z += 1;
  if (keys['KeyA'] || keys['ArrowLeft'])  moveVec.x -= 1;
  if (keys['KeyD'] || keys['ArrowRight']) moveVec.x += 1;

  if (moveVec.length() > 0) {
    moveVec.normalize().multiplyScalar(speed);
    moveVec.applyAxisAngle(new THREE.Vector3(0, 1, 0), camYaw);
  }

  // Gravity / Jump
  if (keys['Space'] && onGround) { velY = 0.15; onGround = false; }
  velY -= gravity * (dt / 16);
  camera.position.y += velY;
  if (camera.position.y <= playerHeight) {
    camera.position.y = playerHeight;
    velY = 0;
    onGround = true;
  }

  camera.position.x += moveVec.x;
  camera.position.z += moveVec.z;

  // Clamp to map
  camera.position.x = Math.max(-29, Math.min(29, camera.position.x));
  camera.position.z = Math.max(-29, Math.min(29, camera.position.z));

  // Camera rotation
  camera.rotation.order = 'YXZ';
  camera.rotation.y = camYaw;
  camera.rotation.x = camPitch;

  // Send to server
  if (socket && gameInited) {
    socket.emit('move', {
      x: camera.position.x,
      y: camera.position.y - playerHeight,
      z: camera.position.z,
      rotY: camYaw
    });
  }
}

// ─── Weapon Bob ──────────────────────────────────────────────────
function updateWeaponBob(dt) {
  if (!weaponMesh) return;
  const moving = keys['KeyW'] || keys['KeyS'] || keys['KeyA'] || keys['KeyD'];
  if (moving && isLocked) bobTime += dt * 0.004;
  const bobX = Math.sin(bobTime) * 0.012;
  const bobY = Math.abs(Math.sin(bobTime)) * 0.008;
  weaponMesh.position.set(0.2 + bobX, -0.22 - bobY, -0.4);
}

// ─── Pickup Rotation ─────────────────────────────────────────────
function animatePickups(t) {
  for (const mesh of Object.values(pickupMeshes)) {
    mesh.rotation.y = t * 0.001;
    mesh.position.y = 0.5 + Math.sin(t * 0.002) * 0.1;
  }
}

// ─── HUD Helpers ─────────────────────────────────────────────────
function updateHealthBar() {
  const bar = document.getElementById('health-bar');
  const txt = document.getElementById('health-text');
  const pct = Math.max(0, health);
  bar.style.width = pct + '%';
  bar.style.background = pct > 60 ? '#4f4' : pct > 30 ? '#fa0' : '#f44';
  txt.textContent = Math.round(pct);
}

function updateAmmoDisplay() {
  const w = myWeapons[currentWeapon];
  const def = WEAPONS_DEF[currentWeapon];
  if (!w || !def) return;
  document.getElementById('weapon-name').textContent = def.name || currentWeapon;
  document.getElementById('ammo-count').innerHTML = `${w.ammo} <span style="font-size:14px;color:#aaa">/ ${w.maxAmmo ?? def.maxAmmo}</span>`;
}

function updateHUD() {
  updateHealthBar();
  updateAmmoDisplay();
}

function updateWeaponSlots() {
  const SLOT_WEAPONS = ['pistol','rifle','shotgun','sniper'];
  const container = document.getElementById('weapon-slots');
  container.innerHTML = '';
  SLOT_WEAPONS.forEach((w, i) => {
    const slot = document.createElement('div');
    slot.className = 'weapon-slot' +
      (w === currentWeapon ? ' active' : '') +
      (myWeapons[w] ? ' owned' : '');
    const def = WEAPONS_DEF[w];
    slot.innerHTML = `<div style="font-size:10px;color:#666">${i+1}</div>${def ? def.name : w}`;
    container.appendChild(slot);
  });
}

function addKillFeed(text) {
  const feed = document.getElementById('kill-feed');
  const div = document.createElement('div');
  div.className = 'kill-entry';
  div.textContent = text;
  feed.appendChild(div);
  setTimeout(() => div.remove(), 4000);
}

function flashDamage() {
  const d = document.getElementById('damage-indicator');
  d.style.opacity = '1';
  setTimeout(() => { d.style.opacity = '0'; }, 200);
}

function showDeathScreen(killerName) {
  const ds = document.getElementById('death-screen');
  document.getElementById('killed-by').textContent = `נהרגת על ידי ${killerName}`;
  ds.style.display = 'flex';
  let t = 3;
  document.getElementById('death-timer').textContent = t;
  const interval = setInterval(() => {
    t--;
    document.getElementById('death-timer').textContent = t;
    if (t <= 0) { clearInterval(interval); }
  }, 1000);
}

function renderScoreboard() {
  const rows = document.getElementById('scoreboard-rows');
  const entries = Object.entries(scores).sort(([,a],[,b]) => b - a);
  rows.innerHTML = entries.map(([id, kills]) => {
    const name = id === myId ? myName : (remotePlayers[id]?.name || 'שחקן');
    return `<div class="score-row ${id === myId ? 'me' : ''}">
      <span>${name}</span><span>${kills} הריגות</span>
    </div>`;
  }).join('');
}

// ─── Init weapon ─────────────────────────────────────────────────
equip('pistol');

// ─── Render Loop ─────────────────────────────────────────────────
let lastTime = performance.now();

function animate(time) {
  requestAnimationFrame(animate);
  const dt = Math.min(time - lastTime, 50);
  lastTime = time;

  if (gameInited) {
    updateMovement(dt);
    updateWeaponBob(dt);
    animatePickups(time);
    checkNearPickups();

    // Auto-fire for pistol/shotgun on hold
    if (keys['MouseLeft'] && isLocked && isAlive) {
      if (currentWeapon !== 'rifle') shoot();
    }
  }

  renderer.render(scene, camera);
}

animate(performance.now());
