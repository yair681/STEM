const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, '../../')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, '../../fortcraft-3d.html')));

// ─── Rooms ────────────────────────────────────────────────────────────────────
const rooms = new Map();
let botIdCounter = 0;
const BOT_NAMES = ['בוט-אש','בוט-קרח','בוט-ברזל','בוט-סערה','בוט-נמר','בוט-רוח','בוט-לילה','בוט-ברק'];

function generateCode() {
  let code;
  do { code = Math.random().toString(36).substr(2, 6).toUpperCase(); }
  while (rooms.has(code));
  return code;
}

function getScores(room) {
  const s = {};
  room.players.forEach((p, id) => { s[id] = { name: p.name, kills: p.kills }; });
  return s;
}

function getRoomPlayers(room) {
  return Array.from(room.players.entries()).map(([id, p]) => ({
    id, name: p.name, kills: p.kills, isAdmin: id === room.adminId
  }));
}

function broadcastLobby(room) {
  io.to(room.code).emit('lobbyUpdate', {
    players: getRoomPlayers(room),
    mode: room.mode,
    timeLimit: room.timeLimit,
    map: room.map
  });
}

// ─── Bot AI ───────────────────────────────────────────────────────────────────
function spawnBot(room) {
  const a = Math.random() * Math.PI * 2;
  const d = 40 + Math.random() * 60;
  const id = `bot_${room.code}_${botIdCounter++}`;
  const bot = {
    id,
    name: BOT_NAMES[botIdCounter % BOT_NAMES.length],
    x: Math.cos(a) * d, y: 0, z: Math.sin(a) * d,
    rotY: 0, hp: 100, maxHp: 100, alive: true,
    speed: 2.5 + Math.random() * 1.5,
    shootTimer: 2 + Math.random() * 2,
    targetX: 0, targetZ: 0, roamTimer: 0
  };
  room.bots.set(id, bot);
  return bot;
}

function startBots(room, count) {
  room.bots = new Map();
  room.wave = 1;
  room.waveTimer = 40;
  for (let i = 0; i < count; i++) spawnBot(room);
  io.to(room.code).emit('botState', Array.from(room.bots.values()));
}

const DT = 0.05;
function updateBots(room) {
  if (!room.bots || room.status !== 'playing') return;

  room.waveTimer -= DT;
  if (room.waveTimer <= 0) {
    room.wave++;
    room.waveTimer = 35;
    for (let i = 0; i < Math.min(room.wave + 1, 4); i++) spawnBot(room);
    io.to(room.code).emit('waveUpdate', { wave: room.wave });
  }

  const players = [];
  room.players.forEach((p, id) => {
    if (p.x !== undefined) players.push({ ...p, socketId: id });
  });

  room.bots.forEach((bot) => {
    if (!bot.alive) return;

    let nearest = null, nearDist = Infinity;
    players.forEach(p => {
      const d = Math.sqrt((p.x - bot.x) ** 2 + (p.z - bot.z) ** 2);
      if (d < nearDist) { nearDist = d; nearest = p; }
    });

    bot.roamTimer--;
    if (nearest && nearDist < 60) {
      bot.targetX = nearest.x; bot.targetZ = nearest.z;
    } else if (bot.roamTimer <= 0) {
      bot.targetX = (Math.random() - 0.5) * 120;
      bot.targetZ = (Math.random() - 0.5) * 120;
      bot.roamTimer = 60 + Math.floor(Math.random() * 60);
    }
    const dx = bot.targetX - bot.x, dz = bot.targetZ - bot.z;
    const dist = Math.sqrt(dx * dx + dz * dz);
    if (dist > 3) {
      bot.x += (dx / dist) * bot.speed * DT;
      bot.z += (dz / dist) * bot.speed * DT;
      bot.rotY = Math.atan2(dx, dz);
    }

    bot.shootTimer -= DT;
    if (nearest && nearDist < 45 && bot.shootTimer <= 0) {
      bot.shootTimer = 2 + Math.random() * 2;
      const acc = Math.max(0, 1 - nearDist / 50) * 0.55;
      if (Math.random() < acc) {
        const dmg = 7 + Math.floor(Math.random() * 8);
        const p = room.players.get(nearest.socketId);
        if (p) {
          if (p.hp === undefined) p.hp = 100;
          p.hp -= dmg;
          io.to(nearest.socketId).emit('hit', { damage: dmg, from: bot.id, health: p.hp });
          if (p.hp <= 0) {
            p.hp = 100;
            io.to(room.code).emit('playerDied', { deadId: nearest.socketId, killerId: bot.id, scores: getScores(room) });
          }
        }
      }
    }
  });

  io.to(room.code).emit('botState', Array.from(room.bots.values()).filter(b => b.alive));
}

// ─── Socket Handlers ──────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log('Connect:', socket.id);

  socket.on('createRoom', ({ name }) => {
    const code = generateCode();
    const room = {
      code, adminId: socket.id,
      players: new Map([[socket.id, { name: name || 'Player', kills: 0, hp: 100 }]]),
      mode: 'ffa', timeLimit: 10, map: 'default', status: 'lobby',
      timer: null, botInterval: null, bots: null, wave: 1, waveTimer: 40
    };
    rooms.set(code, room);
    socket.join(code);
    socket.roomCode = code;
    socket.emit('roomCreated', { code });
    broadcastLobby(room);
    console.log(`Room ${code} created by ${name}`);
  });

  socket.on('joinRoom', ({ code, name }) => {
    const room = rooms.get(code);
    if (!room) { socket.emit('roomError', { msg: 'חדר לא נמצא' }); return; }
    if (room.status !== 'lobby') { socket.emit('roomError', { msg: 'המשחק כבר התחיל' }); return; }
    room.players.set(socket.id, { name: name || 'Player', kills: 0, hp: 100 });
    socket.join(code);
    socket.roomCode = code;
    socket.emit('roomJoined', { code, players: getRoomPlayers(room), mode: room.mode, timeLimit: room.timeLimit, map: room.map });
    broadcastLobby(room);
    console.log(`${name} joined room ${code}`);
  });

  socket.on('setMode', ({ mode }) => {
    const room = rooms.get(socket.roomCode);
    if (!room || room.adminId !== socket.id) return;
    room.mode = mode;
    broadcastLobby(room);
  });

  socket.on('setTime', ({ timeLimit }) => {
    const room = rooms.get(socket.roomCode);
    if (!room || room.adminId !== socket.id) return;
    room.timeLimit = timeLimit;
    broadcastLobby(room);
  });

  socket.on('setMap', ({ map }) => {
    const room = rooms.get(socket.roomCode);
    if (!room || room.adminId !== socket.id) return;
    room.map = map;
    broadcastLobby(room);
  });

  socket.on('chatMsg', ({ text }) => {
    const room = rooms.get(socket.roomCode);
    if (!room || !text || text.length > 200) return;
    const p = room.players.get(socket.id);
    if (!p) return;
    io.to(room.code).emit('chatMsg', { name: p.name, text: text.trim() });
  });

  socket.on('kickPlayer', ({ targetId }) => {
    const room = rooms.get(socket.roomCode);
    if (!room || room.adminId !== socket.id) return;
    room.players.delete(targetId);
    io.to(targetId).emit('kicked');
    const ts = io.sockets.sockets.get(targetId);
    if (ts) { ts.leave(room.code); ts.roomCode = null; }
    broadcastLobby(room);
  });

  socket.on('startGame', () => {
    const room = rooms.get(socket.roomCode);
    if (!room || room.adminId !== socket.id) return;
    room.status = 'playing';
    const initialBots = [];
    if (room.mode === 'coop') {
      startBots(room, 8);
      initialBots.push(...Array.from(room.bots.values()));
      room.botInterval = setInterval(() => updateBots(room), 50);
    }
    io.to(room.code).emit('gameStart', { mode: room.mode, timeLimit: room.timeLimit, bots: initialBots, map: room.map });
    console.log(`Room ${room.code} started. Mode: ${room.mode}, Map: ${room.map}`);
    // End game after timeLimit — reset room to lobby (don't delete)
    room.timer = setTimeout(() => {
      clearInterval(room.botInterval);
      room.botInterval = null;
      io.to(room.code).emit('gameEnd', { scores: getScores(room) });
      // Reset room to lobby after 10s (players return from game over screen)
      setTimeout(() => {
        if (!rooms.has(room.code)) return;
        room.status = 'lobby';
        room.bots = new Map();
        room.wave = 1; room.waveTimer = 40;
        room.players.forEach(p => { p.kills = 0; p.hp = 100; delete p.x; delete p.y; delete p.z; });
        broadcastLobby(room);
      }, 10000);
    }, room.timeLimit * 60 * 1000);
  });

  socket.on('playerMove', ({ x, y, z, rotY, currentWeapon }) => {
    const room = rooms.get(socket.roomCode);
    if (!room) return;
    const p = room.players.get(socket.id);
    if (!p) return;
    p.x = x; p.y = y; p.z = z; p.rotY = rotY;
    socket.to(room.code).emit('playerUpdate', { id: socket.id, name: p.name, x, y, z, rotY, kills: p.kills, currentWeapon });
  });

  socket.on('playerHit', ({ targetId, damage }) => {
    const room = rooms.get(socket.roomCode);
    if (!room) return;
    const victim = room.players.get(targetId);
    if (!victim) return;
    if (victim.hp === undefined) victim.hp = 100;
    victim.hp = Math.max(0, victim.hp - damage);
    io.to(targetId).emit('hit', { damage, from: socket.id, health: victim.hp });
    if (victim.hp <= 0) {
      victim.hp = 100;
      const killer = room.players.get(socket.id);
      if (killer) killer.kills++;
      io.to(room.code).emit('playerDied', { deadId: targetId, killerId: socket.id, scores: getScores(room) });
    }
  });

  socket.on('botHit', ({ botId, damage }) => {
    const room = rooms.get(socket.roomCode);
    if (!room || !room.bots) return;
    const bot = room.bots.get(botId);
    if (!bot || !bot.alive) return;
    bot.hp -= damage;
    if (bot.hp <= 0) {
      bot.alive = false;
      room.bots.delete(botId);
      const killer = room.players.get(socket.id);
      if (killer) killer.kills++;
      io.to(room.code).emit('botDied', { botId, killerId: socket.id, scores: getScores(room) });
      setTimeout(() => {
        if (room.status === 'playing' && room.bots) {
          const newBot = spawnBot(room);
          io.to(room.code).emit('botSpawned', newBot);
        }
      }, 4000);
    }
  });

  socket.on('leaveRoom', () => cleanupPlayer(socket));

  socket.on('disconnect', () => {
    console.log('Disconnect:', socket.id);
    cleanupPlayer(socket);
  });
});

function cleanupPlayer(socket) {
  const code = socket.roomCode;
  if (!code) return;
  const room = rooms.get(code);
  if (!room) return;
  room.players.delete(socket.id);
  socket.leave(code);
  socket.roomCode = null;
  if (room.players.size === 0) {
    clearTimeout(room.timer);
    clearInterval(room.botInterval);
    rooms.delete(code);
    console.log(`Room ${code} deleted (empty)`);
  } else {
    if (room.adminId === socket.id) room.adminId = room.players.keys().next().value;
    io.to(code).emit('playerLeft', { id: socket.id });
    broadcastLobby(room);
  }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🎮 FortCraft Server on http://localhost:${PORT}`));
