const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  transports: ['websocket', 'polling']
});
const PORT = process.env.PORT || 3000;
const players = new Map();
app.get('/', (_req, res) => res.status(200).send('LAST STAND ARENA multiplayer server is online.'));
app.get('/health', (_req, res) => res.json({ ok: true, players: players.size }));
function safeText(value, fallback, max = 18) {
  return String(value || fallback).replace(/[<>]/g, '').slice(0, max) || fallback;
}
function safeColor(value) {
  return /^#[0-9a-f]{6}$/i.test(String(value || '')) ? value : '#48d9d2';
}
io.on('connection', socket => {
  socket.on('joinArena', data => {
    const player = {
      id: socket.id,
      name: safeText(data?.name, 'ROOKIE', 18),
      color: safeColor(data?.color),
      x: Number.isFinite(data?.x) ? Math.max(20, Math.min(3580, data.x)) : 1800,
      y: Number.isFinite(data?.y) ? Math.max(20, Math.min(2580, data.y)) : 1300,
      angle: 0,
      hp: 100
    };
    players.set(socket.id, player);
    socket.emit('players', [...players.values()]);
    socket.broadcast.emit('playerJoined', player);
  });
  socket.on('move', data => {
    const p = players.get(socket.id);
    if (!p || !data) return;
    if (Number.isFinite(data.x)) p.x = Math.max(13, Math.min(3587, data.x));
    if (Number.isFinite(data.y)) p.y = Math.max(13, Math.min(2587, data.y));
    if (Number.isFinite(data.angle)) p.angle = data.angle;
    p.name = safeText(data.name, p.name, 18);
    p.color = safeColor(data.color);
    io.emit('playerMoved', p);
  });
  socket.on('disconnect', () => {
    if (players.delete(socket.id)) io.emit('playerLeft', socket.id);
  });
});
server.listen(PORT, '0.0.0.0', () => console.log(`LAST STAND ARENA server listening on ${PORT}`));
