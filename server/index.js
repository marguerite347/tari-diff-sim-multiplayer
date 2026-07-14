'use strict';

const http = require('http');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { WebSocketServer } = require('ws');
const { RoomManager } = require('./room');

const PORT = Number(process.env.PORT || 8787);
const ROOT = path.join(__dirname, '..');

const app = express();
app.use(express.static(ROOT));

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'tari-diff-sim-multiplayer' });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
const rooms = new RoomManager();

setInterval(() => rooms.cleanupIdle(), 60_000).unref();

function send(ws, message) {
  if (ws.readyState === 1) ws.send(JSON.stringify(message));
}

function newPlayerId() {
  return crypto.randomBytes(8).toString('hex');
}

wss.on('connection', (ws) => {
  ws.playerId = newPlayerId();
  ws.roomCode = null;

  send(ws, { type: 'hello', playerId: ws.playerId });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return send(ws, { type: 'error', error: 'Invalid JSON' });
    }

    try {
      handleMessage(ws, msg);
    } catch (err) {
      console.error(err);
      send(ws, { type: 'error', error: err.message || 'Server error' });
    }
  });

  ws.on('close', () => {
    leaveRoom(ws);
  });
});

function leaveRoom(ws) {
  if (!ws.roomCode) return;
  const room = rooms.get(ws.roomCode);
  if (!room) {
    ws.roomCode = null;
    return;
  }
  room.removeClient(ws.playerId);
  ws.roomCode = null;
  room.broadcastState();
}

function handleMessage(ws, msg) {
  switch (msg.type) {
    case 'create_room': {
      leaveRoom(ws);
      const room = rooms.create();
      room.hostId = ws.playerId;
      room.addClient(ws.playerId, ws, msg.name || 'Host');
      ws.roomCode = room.code;
      send(ws, room.snapshot(ws.playerId));
      break;
    }
    case 'join_room': {
      const room = rooms.get(msg.room);
      if (!room) return send(ws, { type: 'error', error: 'Room not found' });
      leaveRoom(ws);
      if (!room.hostId) room.hostId = ws.playerId;
      room.addClient(ws.playerId, ws, msg.name || 'Miner');
      ws.roomCode = room.code;
      room.broadcastState();
      break;
    }
    case 'set_name': {
      const room = rooms.get(ws.roomCode);
      if (!room) return;
      const player = room.players.get(ws.playerId);
      if (player) player.name = String(msg.name || player.name).slice(0, 24);
      room.broadcastState();
      break;
    }
    case 'set_hashrates': {
      const room = rooms.get(ws.roomCode);
      if (!room) return;
      room.setHashrates(ws.playerId, msg.hashrates || {});
      room.broadcastState();
      break;
    }
    case 'set_settings': {
      const room = rooms.get(ws.roomCode);
      if (!room) return;
      const ok = room.setSettings(ws.playerId, msg.settings || {});
      if (!ok) return send(ws, { type: 'error', error: 'Only the host can change settings' });
      room.broadcastState();
      break;
    }
    case 'start': {
      const room = rooms.get(ws.roomCode);
      if (!room) return;
      const result = room.start(ws.playerId);
      if (!result.ok) send(ws, { type: 'error', error: result.error });
      break;
    }
    case 'stop': {
      const room = rooms.get(ws.roomCode);
      if (!room) return;
      const result = room.stop(ws.playerId);
      if (!result.ok) send(ws, { type: 'error', error: result.error });
      break;
    }
    case 'reset': {
      const room = rooms.get(ws.roomCode);
      if (!room) return;
      const result = room.reset(ws.playerId);
      if (!result.ok) send(ws, { type: 'error', error: result.error });
      break;
    }
    case 'leave': {
      leaveRoom(ws);
      send(ws, { type: 'left' });
      break;
    }
    default:
      send(ws, { type: 'error', error: `Unknown message type: ${msg.type}` });
  }
}

server.listen(PORT, () => {
  console.log(`Tari multiplayer sim listening on http://localhost:${PORT}`);
  console.log(`Share a room with /?room=CODE after creating one`);
});
