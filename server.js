'use strict';

const express = require('express');
const { createServer } = require('node:http');
const { randomBytes } = require('node:crypto');
const path = require('node:path');
const { Server } = require('socket.io');

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  maxHttpBufferSize: 64 * 1024,
  cors: { origin: false }
});
const PORT = Number(process.env.PORT) || 3000;
const rooms = new Map();
const MAX_MESSAGES = 80;
const MAX_PEOPLE = 2;
const ROOM_PATTERN = /^[a-zA-Z0-9_-]{12,64}$/;

app.disable('x-powered-by');
app.use(express.static(path.join(__dirname, 'public')));
app.get('/api/new-room', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ roomId: randomBytes(16).toString('hex') });
});
app.get('/healthz', (_req, res) => res.json({ ok: true }));

function newRoom() {
  return {
    members: new Map(),
    movie: null,
    playing: false,
    position: 0,
    changedAt: Date.now(),
    revision: 0,
    messages: [],
    lastActivity: Date.now()
  };
}

function snapshot(room) {
  return {
    movie: room.movie,
    playing: room.playing,
    position: room.position,
    changedAt: room.changedAt,
    revision: room.revision,
    sentAt: Date.now()
  };
}

function presence(room) {
  return [...room.members.entries()].map(([id, member]) => ({ id, name: member.name }));
}

function sanitizeName(value) {
  return typeof value === 'string' ? value.trim().slice(0, 24) : '';
}

function validateMovie(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const title = typeof raw.title === 'string' ? raw.title.trim().slice(0, 100) : '';
  if (!title) return null;

  if (raw.type === 'youtube') {
    if (typeof raw.id !== 'string' || !/^[a-zA-Z0-9_-]{11}$/.test(raw.id)) return null;
    return { type: 'youtube', id: raw.id, title, key: `youtube:${raw.id}` };
  }

  if (raw.type === 'video' && typeof raw.url === 'string' && raw.url.length <= 2000) {
    try {
      const url = new URL(raw.url);
      if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
      if (url.username || url.password) return null;
      if (!/\.(mp4|webm|ogg)(?:$|[?#])/i.test(url.href)) return null;
      return { type: 'video', url: url.href, title, key: `video:${url.href}` };
    } catch {
      return null;
    }
  }
  return null;
}

function inRoom(socket) {
  const roomId = socket.data.roomId;
  const room = roomId && rooms.get(roomId);
  return room && room.members.has(socket.id) ? { roomId, room } : null;
}

function sayToRoom(roomId, message) {
  const room = rooms.get(roomId);
  if (!room) return;
  room.messages.push(message);
  if (room.messages.length > MAX_MESSAGES) room.messages.shift();
  room.lastActivity = Date.now();
  io.to(roomId).emit('chat:message', message);
}

function memberName(room, preferredName) {
  if (preferredName) return preferredName;
  const names = [...room.members.values()].map((x) => x.name);
  return names.includes('Мистер Кивив') ? 'Поколоко' : 'Мистер Кивив';
}

io.on('connection', (socket) => {
  socket.on('room:join', (payload) => {
    if (socket.data.roomId) return;
    const roomId = payload && payload.roomId;
    if (typeof roomId !== 'string' || !ROOM_PATTERN.test(roomId)) {
      socket.emit('room:error', { code: 'bad_room', message: 'Неверная ссылка на комнату.' });
      return;
    }

    let room = rooms.get(roomId);
    if (!room) {
      room = newRoom();
      rooms.set(roomId, room);
    }
    if (room.members.size >= MAX_PEOPLE) {
      socket.emit('room:error', { code: 'full', message: 'В кинозале уже двое. Попробуй зайти позже.' });
      return;
    }

    const preferredName = sanitizeName(payload.preferredName);
    const name = memberName(room, preferredName);
    socket.data.roomId = roomId;
    socket.data.name = name;
    socket.data.lastChatTimes = [];
    room.members.set(socket.id, { name });
    room.lastActivity = Date.now();
    socket.join(roomId);
    socket.emit('room:joined', {
      yourId: socket.id,
      yourName: name,
      roomId,
      members: presence(room),
      messages: room.messages,
      state: snapshot(room)
    });
    io.to(roomId).emit('room:presence', presence(room));
  });

  socket.on('profile:name', (newName) => {
    const joined = inRoom(socket);
    if (!joined) return;
    const name = sanitizeName(newName);
    if (!name) return;
    socket.data.name = name;
    joined.room.members.get(socket.id).name = name;
    joined.room.lastActivity = Date.now();
    io.to(joined.roomId).emit('room:presence', presence(joined.room));
  });

  socket.on('movie:select', (raw) => {
    const joined = inRoom(socket);
    if (!joined) return;
    const movie = validateMovie(raw);
    if (!movie) {
      socket.emit('room:error', { code: 'bad_movie', message: 'Нужна ссылка YouTube или прямая ссылка на видео .mp4 / .webm / .ogg.' });
      return;
    }

    const { room, roomId } = joined;
    room.movie = movie;
    room.position = 0;
    room.playing = false;
    room.changedAt = Date.now();
    room.revision++;
    room.lastActivity = Date.now();
    io.to(roomId).emit('player:state', snapshot(room));
    sayToRoom(roomId, {
      id: randomBytes(8).toString('hex'),
      kind: 'system',
      text: `${socket.data.name} выбрал(а) «${movie.title}» 🎬`,
      createdAt: Date.now()
    });
  });

  socket.on('player:command', (raw) => {
    const joined = inRoom(socket);
    if (!joined || !joined.room.movie || !raw || typeof raw !== 'object') return;
    const { room, roomId } = joined;
    const action = raw.action;
    const value = Number(raw.position);
    if (!['play', 'pause', 'seek'].includes(action)) return;
    if (!Number.isFinite(value) || value < 0 || value > 172800) return;

    room.position = value;
    room.changedAt = Date.now();
    if (action === 'play') room.playing = true;
    if (action === 'pause') room.playing = false;
    room.revision++;
    room.lastActivity = Date.now();
    io.to(roomId).emit('player:state', snapshot(room));
  });

  socket.on('chat:send', (raw) => {
    const joined = inRoom(socket);
    if (!joined || typeof raw !== 'string') return;
    const text = raw.trim().slice(0, 500);
    if (!text) return;

    const now = Date.now();
    socket.data.lastChatTimes = socket.data.lastChatTimes.filter((t) => now - t < 10000);
    if (socket.data.lastChatTimes.length >= 8) return;
    socket.data.lastChatTimes.push(now);
    sayToRoom(joined.roomId, {
      id: randomBytes(8).toString('hex'),
      kind: 'user',
      authorId: socket.id,
      name: socket.data.name,
      text,
      createdAt: now
    });
  });

  socket.on('disconnect', () => {
    const joined = inRoom(socket);
    if (!joined) return;
    const { room, roomId } = joined;
    room.members.delete(socket.id);
    room.lastActivity = Date.now();
    io.to(roomId).emit('room:presence', presence(room));
  });
});

// Напоминаем плеерам общую позицию, даже если один из них немного отстал.
setInterval(() => {
  for (const [roomId, room] of rooms) {
    if (room.members.size && room.movie) {
      io.to(roomId).emit('player:pulse', snapshot(room));
    }
    if (!room.members.size && Date.now() - room.lastActivity > 6 * 60 * 60 * 1000) {
      rooms.delete(roomId);
    }
  }
}, 4000).unref();

if (require.main === module) {
  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`Мистер Кивив и Поколоко: http://localhost:${PORT}`);
  });
}

module.exports = { app, httpServer, io, validateMovie };
