/**
 * Pixel Synapse — Multiplayer Prototype Server
 * Stack: Express + Socket.io
 * Run:   node server/server.js
 */

const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const path       = require('path');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });

// Serve client files at http://localhost:3000
app.use(express.static(path.join(__dirname, '../client')));

// ── Game state ──
const players = {};
// players[id] = { id, name, color, x, y, chat }

const WORLD_W = 800, WORLD_H = 600;
const ADJ  = ['Swift','Bold','Calm','Keen','Sage','Wry','Deft','Grim'];
const NOUN = ['Fox','Elk','Owl','Lynx','Bear','Hawk','Wolf','Crow'];
const COLS = ['#4fc3f7','#81c784','#ffb74d','#f06292','#ce93d8','#80cbc4','#fff176','#ff8a65'];

const randName  = () => ADJ[Math.random()*8|0] + NOUN[Math.random()*8|0];
const randColor = () => COLS[Math.random()*8|0];
const randSpawn = () => ({ x: 60 + Math.random()*680, y: 60 + Math.random()*480 });

io.on('connection', (socket) => {
  const spawn  = randSpawn();
  const player = { id: socket.id, name: randName(), color: randColor(), ...spawn, chat: '' };
  players[socket.id] = player;
  console.log(`[+] ${player.name} joined — ${Object.keys(players).length} online`);

  // Tell the new client about themselves and everyone else
  socket.emit('init', {
    self:    player,
    players: Object.values(players).filter(p => p.id !== socket.id),
  });
  // Tell everyone else
  socket.broadcast.emit('playerJoined', player);

  socket.on('move', ({ x, y }) => {
    const p = players[socket.id];
    if (!p) return;
    p.x = Math.max(8, Math.min(WORLD_W - 8, x));
    p.y = Math.max(8, Math.min(WORLD_H - 8, y));
    socket.broadcast.emit('playerMoved', { id: socket.id, x: p.x, y: p.y });
  });

  socket.on('chat', (text) => {
    const p = players[socket.id];
    if (!p) return;
    p.chat = String(text).slice(0, 80);
    io.emit('playerChat', { id: socket.id, name: p.name, msg: p.chat });
    setTimeout(() => { if (players[socket.id]) players[socket.id].chat = ''; }, 4000);
  });

  socket.on('disconnect', () => {
    console.log(`[-] ${players[socket.id]?.name} left`);
    delete players[socket.id];
    io.emit('playerLeft', socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🎮  http://localhost:${PORT}  — open in two tabs\n`);
});
