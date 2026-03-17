const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, '../client')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, '../client/index.html')));

// ─── Rooms ────────────────────────────────────────────────────────────────────
const rooms = new Map(); // code -> room

function generateCode() {
  let code;
  do { code = Math.random().toString(36).substr(2, 6).toUpperCase(); }
  while (rooms.has(code));
  return code;
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
    timeLimit: room.timeLimit
  });
}

// ─── Socket Handlers ──────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log('Connect:', socket.id);

  socket.on('createRoom', ({ name }) => {
    const code = generateCode();
    const room = {
      code,
      adminId: socket.id,
      players: new Map([[socket.id, { name: name || 'Player', kills: 0 }]]),
      mode: 'ffa',
      timeLimit: 10,
      status: 'lobby',
      timer: null
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
    if (!room) { socket.emit('error', { msg: 'חדר לא נמצא' }); return; }
    if (room.status !== 'lobby') { socket.emit('error', { msg: 'המשחק כבר התחיל' }); return; }
    room.players.set(socket.id, { name: name || 'Player', kills: 0 });
    socket.join(code);
    socket.roomCode = code;
    socket.emit('roomJoined', {
      code,
      players: getRoomPlayers(room),
      mode: room.mode,
      timeLimit: room.timeLimit
    });
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

  socket.on('kickPlayer', ({ targetId }) => {
    const room = rooms.get(socket.roomCode);
    if (!room || room.adminId !== socket.id) return;
    room.players.delete(targetId);
    io.to(targetId).emit('kicked');
    const targetSocket = io.sockets.sockets.get(targetId);
    if (targetSocket) { targetSocket.leave(room.code); targetSocket.roomCode = null; }
    broadcastLobby(room);
  });

  socket.on('startGame', () => {
    const room = rooms.get(socket.roomCode);
    if (!room || room.adminId !== socket.id) return;
    room.status = 'playing';
    io.to(room.code).emit('gameStart', { mode: room.mode, timeLimit: room.timeLimit });
    console.log(`Room ${room.code} game started. Mode: ${room.mode}`);
    // End game after timeLimit
    room.timer = setTimeout(() => {
      const scores = {};
      room.players.forEach((p, id) => { scores[id] = { name: p.name, kills: p.kills }; });
      io.to(room.code).emit('gameEnd', { scores });
      rooms.delete(room.code);
    }, room.timeLimit * 60 * 1000);
  });

  socket.on('playerMove', ({ x, y, z, rotY }) => {
    const room = rooms.get(socket.roomCode);
    if (!room) return;
    const p = room.players.get(socket.id);
    if (!p) return;
    p.x = x; p.y = y; p.z = z; p.rotY = rotY;
    socket.to(room.code).emit('playerUpdate', {
      id: socket.id, name: p.name, x, y, z, rotY, kills: p.kills
    });
  });

  socket.on('playerKill', ({ victimId }) => {
    const room = rooms.get(socket.roomCode);
    if (!room) return;
    const killer = room.players.get(socket.id);
    const victim = room.players.get(victimId);
    if (killer) killer.kills++;
    const scores = {};
    room.players.forEach((p, id) => { scores[id] = { name: p.name, kills: p.kills }; });
    io.to(room.code).emit('playerDied', {
      deadId: victimId,
      killerId: socket.id,
      scores
    });
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
    rooms.delete(code);
    console.log(`Room ${code} deleted (empty)`);
  } else {
    // Pass admin to next player if admin left
    if (room.adminId === socket.id) {
      room.adminId = room.players.keys().next().value;
    }
    io.to(code).emit('playerLeft', { id: socket.id });
    broadcastLobby(room);
  }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🎮 FortCraft Server on http://localhost:${PORT}`));
