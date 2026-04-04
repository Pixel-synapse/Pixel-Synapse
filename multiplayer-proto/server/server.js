/**
 * Pixel Synapse — Multiplayer Prototype Server
 * Stack: Express + Socket.io
 * Run:   node server/server.js
 * Open:  http://localhost:3000
 */

const express   = require('express');
const http      = require('http');
const { Server } = require('socket.io');
const path      = require('path');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*' }   // allow any origin for local dev
});

// ─────────────────────────────────────────────
// STATIC FILES
// Serve /client as the web root
// ─────────────────────────────────────────────
app.use(express.static(path.join(__dirname, '../client')));

// ─────────────────────────────────────────────
// GAME STATE
// players[id] = { id, x, y, color, name }
// ─────────────────────────────────────────────
const players = {};

const WORLD_W = 800;
const WORLD_H = 600;
const COLORS  = [
  '#4fc3f7','#81c784','#ffb74d','#f06292',
  '#ce93d8','#80cbc4','#fff176','#ff8a65'
];

function randomColor() {
  return COLORS[Math.floor(Math.random() * COLORS.length)];
}
function randomName() {
  const adj  = ['Swift','Bold','Keen','Calm','Bright','Wild','Shy','Sharp'];
  const noun = ['Fox','Wolf','Hawk','Bear','Lynx','Raven','Otter','Lynx'];
  return adj[Math.floor(Math.random()*adj.length)] + noun[Math.floor(Math.random()*noun.length)];
}

// ─────────────────────────────────────────────
// SOCKET EVENTS
// ─────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`[+] ${socket.id} connected`);

  // Create this player's initial state
  const player = {
    id:    socket.id,
    x:     100 + Math.floor(Math.random() * (WORLD_W - 200)),
    y:     100 + Math.floor(Math.random() * (WORLD_H - 200)),
    color: randomColor(),
    name:  randomName(),
  };
  players[socket.id] = player;

  // ── Send the new player the current world state ──
  socket.emit('currentPlayers', players);

  // ── Tell everyone else about the new player ──
  socket.broadcast.emit('newPlayer', player);

  // ── Movement ──
  socket.on('playerMovement', (data) => {
    const p = players[socket.id];
    if (!p) return;

    // Clamp to world bounds
    p.x = Math.round(Math.max(8, Math.min(WORLD_W - 8, data.x)));
    p.y = Math.round(Math.max(8, Math.min(WORLD_H - 8, data.y)));

    // Broadcast updated position to all other clients
    socket.broadcast.emit('playerMoved', { id: socket.id, x: p.x, y: p.y });
  });

  // ── Chat ──
  socket.on('chatMessage', (text) => {
    if (!text || typeof text !== 'string') return;
    const safe = text.slice(0, 120).replace(/</g, '&lt;');
    io.emit('chatMessage', { id: socket.id, name: players[socket.id]?.name || '?', text: safe });
  });

  // ── Disconnect ──
  socket.on('disconnect', () => {
    console.log(`[-] ${socket.id} left`);
    delete players[socket.id];
    io.emit('playerDisconnected', socket.id);
  });
});

// ─────────────────────────────────────────────
// START
// ─────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🎮 Pixel Synapse proto running → http://localhost:${PORT}`);
});
