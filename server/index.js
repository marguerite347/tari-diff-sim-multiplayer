'use strict';

const http = require('http');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { WebSocketServer } = require('ws');
const { RoomManager } = require('./room');
const { aggregate, archiveAndReset } = require('./research');
const { buildLlmContext } = require('./llm-context');

const PORT = Number(process.env.PORT || 8787);
const ROOT = path.join(__dirname, '..');
const SERVER_STARTED_AT = Date.now();
const LLM_CONTEXT = buildLlmContext(new Date(SERVER_STARTED_AT).toISOString());
const MAX_ACTIVE_ROOMS = 100;
const MAX_HUMANS_PER_ROOM = 32;
const MESSAGE_RATE_LIMIT = 30;
const MESSAGE_RATE_WINDOW_MS = 10_000;
const RESET_RATE_LIMIT = 5;
const RESET_RATE_WINDOW_MS = 10 * 60_000;
const ROOMS_RATE_LIMIT = 60;
const ROOMS_RATE_WINDOW_MS = 10_000;
const RESUME_SECRET = crypto.randomBytes(32);
const resetAttempts = new Map();
const roomListRequests = new Map();

const app = express();
app.set('trust proxy', 1);
app.use((_req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Content-Security-Policy': [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com",
      "img-src 'self' data: blob:",
      "connect-src 'self' https: ws: wss: http://localhost:11434 http://localhost:1234",
      "object-src 'none'",
      "base-uri 'self'",
      "frame-ancestors 'none'",
    ].join('; '),
  });
  next();
});

const staticOptions = { dotfiles: 'ignore', index: false };
app.get(['/', '/index.html'], (_req, res) => res.sendFile(path.join(ROOT, 'index.html')));
app.use('/js', express.static(path.join(ROOT, 'js'), staticOptions));
app.use('/css', express.static(path.join(ROOT, 'css'), staticOptions));
app.use('/lib', express.static(path.join(ROOT, 'lib'), staticOptions));
app.use('/assets', express.static(path.join(ROOT, 'assets'), staticOptions));
if (process.env.NODE_ENV !== 'production' || process.env.SKYBOX_GALLERY === '1') {
  app.get('/skyboxes.html', (_req, res) => res.sendFile(path.join(ROOT, 'skyboxes.html')));
}

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'tari-diff-sim-multiplayer' });
});

function isLocalRequest(req) {
  const address = req.socket.remoteAddress || '';
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function resetCapability(req) {
  const tokenConfigured = !!process.env.RESEARCH_ADMIN_TOKEN;
  const production = process.env.NODE_ENV === 'production';
  const local = isLocalRequest(req);
  return {
    resetAvailable: production ? tokenConfigured : (local || tokenConfigured),
    resetRequiresToken: production ? tokenConfigured : (!local && tokenConfigured),
  };
}

function tokenMatches(actual, expected) {
  const digest = (value) => crypto.createHash('sha256').update(String(value || '')).digest();
  return crypto.timingSafeEqual(digest(actual), digest(expected));
}

function resetRateLimited(req) {
  const now = Date.now();
  const key = req.ip || req.socket.remoteAddress || 'unknown';
  const recent = (resetAttempts.get(key) || []).filter((ts) => now - ts < RESET_RATE_WINDOW_MS);
  recent.push(now);
  resetAttempts.set(key, recent);
  return recent.length > RESET_RATE_LIMIT;
}

app.get('/api/research', (req, res) => {
  res.json({
    ok: true,
    ...resetCapability(req),
    results: aggregate('randomized'),
    exploratoryResults: aggregate('manual'),
  });
});

app.get('/api/llm-context', (_req, res) => {
  res.set('Cache-Control', 'public, max-age=300');
  res.json(LLM_CONTEXT);
});

app.post('/api/research/reset', (req, res) => {
  const capability = resetCapability(req);
  if (!capability.resetAvailable) {
    return res.status(503).json({ ok: false, error: 'Research reset is not configured' });
  }
  if (resetRateLimited(req)) {
    return res.status(429).json({ ok: false, error: 'Too many reset attempts; try again later' });
  }

  if (capability.resetRequiresToken) {
    const match = String(req.get('authorization') || '').match(/^Bearer (.+)$/);
    if (!match || !tokenMatches(match[1], process.env.RESEARCH_ADMIN_TOKEN)) {
      return res.status(401).json({ ok: false, error: 'Invalid admin token' });
    }
  }

  try {
    res.json({ ok: true, ...archiveAndReset() });
  } catch (err) {
    console.error('Failed to reset research data:', err.message);
    res.status(500).json({ ok: false, error: 'Research reset failed' });
  }
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
const rooms = new RoomManager();

function roomListRateLimited(req) {
  const now = Date.now();
  const key = String(req.ip || req.socket.remoteAddress || 'unknown').slice(0, 128);
  const recent = (roomListRequests.get(key) || []).filter((ts) => now - ts < ROOMS_RATE_WINDOW_MS);
  recent.push(now);
  roomListRequests.set(key, recent);
  if (roomListRequests.size > 1000) {
    for (const [requester, timestamps] of roomListRequests.entries()) {
      if (!timestamps.some((ts) => now - ts < ROOMS_RATE_WINDOW_MS)) roomListRequests.delete(requester);
    }
  }
  return recent.length > ROOMS_RATE_LIMIT;
}

app.get('/api/rooms', (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (roomListRateLimited(req)) {
    return res.status(429).json({ ok: false, error: 'Too many room-list requests; try again shortly' });
  }
  res.json({
    ok: true,
    generatedAt: new Date().toISOString(),
    rooms: rooms.publicListings(MAX_HUMANS_PER_ROOM),
  });
});

// Per-room debug snapshot for handing to a debugging agent. Localhost research
// tool — no auth, but only plain JSON (never socket objects) leaves here.
app.get('/api/debug/:roomCode', (req, res) => {
  const now = Date.now();
  const serverInfo = {
    startedAt: new Date(SERVER_STARTED_AT).toISOString(),
    uptimeSec: Math.round((now - SERVER_STARTED_AT) / 1000),
    // In-memory rooms don't survive restarts; a young process is the usual
    // explanation for a "room not found" that worked minutes ago.
    serverRestartedRecently: now - SERVER_STARTED_AT < 10 * 60 * 1000,
  };
  const room = rooms.get(req.params.roomCode);
  if (!room) {
    return res.json({
      ok: true,
      exists: false,
      roomCode: String(req.params.roomCode || '').trim().toUpperCase(),
      note: 'Room not found in memory. If serverRestartedRecently is true, it was likely lost in a restart.',
      server: serverInfo,
    });
  }
  const host = room.hostId ? room.players.get(room.hostId) : null;
  const players = [...room.players.values()];
  res.json({
    ok: true,
    exists: true,
    roomCode: room.code,
    running: room.running,
    roundOver: room.roundOver,
    listed: room.listed,
    ...room.lifecycleState(now),
    session: {
      id: room.listed ? room.sessionId : null,
      round: room.listed ? room.sessionRound : null,
      length: room.listed ? room.sessionLength : null,
      complete: room.listed ? room.sessionComplete : false,
      completedResults: room.listed ? room.sessionResults.length : 0,
      returnDeadline: room.listed ? room.sessionReturnDeadline : null,
    },
    variantMode: room.variantMode,
    winnerId: room.winnerId,
    height: room.height,
    hostPresent: !!host,
    hostIsBot: !!(host && host.isBot),
    createdAt: new Date(room.createdAt).toISOString(),
    connectedClients: room.clients.size,
    playerSummary: {
      total: players.length,
      connectedHumans: players.filter((p) => p.connected && !p.isBot).length,
      attackers: players.filter((p) => p.isBot && p.kind === 'attacker').length,
      aggregateHashrates: [0, 1, 2, 3].map((algo) => players.reduce(
        (sum, p) => sum + Number(p.hashrates?.[algo] || 0), 0
      )),
    },
    challenge: room.challenge
      ? {
          id: room.challenge.id,
          name: room.challenge.name,
          variantId: room.challenge.variant?.id ?? null,
          selectedVariant: room.challenge.variant?.id ?? null,
          assignmentMode: room.challenge.assignmentMode || 'randomized',
          durationBlocks: room.challenge.durationBlocks,
        }
      : null,
    objective: room.objective ? room.objective.progress() : null,
    lastResult: room.lastResult,
    recentBlocks: room.chain.slice(-10).map((b) => ({
      height: b.height,
      algo: b.algo,
      algoName: b.algoName,
      minerName: b.minerName,
      blockTime: b.blockTime,
      difficulty: b.difficulty,
    })),
    timers: {
      block: {
        scheduled: !!room.blockTimer,
        armedAt: room._timerArmedAt ? new Date(room._timerArmedAt).toISOString() : null,
        lastBlockAt: room._lastBlockAt ? new Date(room._lastBlockAt).toISOString() : null,
        msSinceLastBlock: room._lastBlockAt ? now - room._lastBlockAt : null,
      },
      lifecycle: {
        scheduled: !!room.lifecycleTimer,
        kind: room.lifecycleKind,
        deadline: room.lifecycleDeadline,
        armedAt: room._lifecycleArmedAt ? new Date(room._lifecycleArmedAt).toISOString() : null,
      },
      emptyRoomGrace: {
        scheduled: !!room.emptyRoomTimer,
        deadline: room.emptyRoomDeadline,
      },
    },
    server: serverInfo,
  });
});

setInterval(() => rooms.cleanupIdle(), 60_000).unref();

function send(ws, message) {
  if (ws.readyState === 1) ws.send(JSON.stringify(message));
}

function newPlayerId() {
  return crypto.randomBytes(8).toString('hex');
}

function resumeToken(playerId) {
  const signature = crypto.createHmac('sha256', RESUME_SECRET).update(playerId).digest('hex');
  return `${playerId}.${signature}`;
}

function playerIdFromResumeToken(token) {
  const [playerId, signature] = String(token || '').split('.');
  if (!/^[a-f0-9]{16}$/.test(playerId || '') || !/^[a-f0-9]{64}$/.test(signature || '')) return null;
  const expected = crypto.createHmac('sha256', RESUME_SECRET).update(playerId).digest();
  const supplied = Buffer.from(signature, 'hex');
  return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected) ? playerId : null;
}

wss.on('connection', (ws, req) => {
  const requestedResume = new URL(req.url, 'http://localhost').searchParams.get('resume');
  ws.playerId = playerIdFromResumeToken(requestedResume) || newPlayerId();
  ws.roomCode = null;
  ws.messageTimestamps = [];
  ws.nextChallengeResponses = new Map();

  send(ws, { type: 'hello', playerId: ws.playerId, resumeToken: resumeToken(ws.playerId) });

  ws.on('message', (raw) => {
    const now = Date.now();
    ws.messageTimestamps = ws.messageTimestamps.filter((ts) => now - ts < MESSAGE_RATE_WINDOW_MS);
    if (ws.messageTimestamps.length >= MESSAGE_RATE_LIMIT) {
      send(ws, { type: 'error', error: 'Message rate limit exceeded' });
      return ws.close(1008, 'Message rate limit exceeded');
    }
    ws.messageTimestamps.push(now);

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
      if (rooms.rooms.size >= MAX_ACTIVE_ROOMS) {
        return send(ws, { type: 'error', error: 'Server room limit reached; try again later' });
      }
      leaveRoom(ws);
      const room = rooms.create();
      room.hostId = ws.playerId;
      room.addClient(ws.playerId, ws, msg.name);
      ws.roomCode = room.code;
      send(ws, room.snapshot(ws.playerId));
      break;
    }
    case 'join_room': {
      const roomCode = String(msg.room ?? '').trim().toUpperCase();
      if (!/^[A-Z0-9]{5}$/.test(roomCode)) {
        return send(ws, { type: 'error', error: 'Room code must be exactly 5 letters or digits' });
      }
      const room = rooms.get(roomCode);
      if (!room) return send(ws, { type: 'error', error: 'Room not found' });
      if (room.clients.size >= MAX_HUMANS_PER_ROOM && !room.clients.has(ws.playerId)) {
        return send(ws, { type: 'error', error: 'Room is full (32 players maximum)' });
      }
      leaveRoom(ws);
      if (!room.hostId) room.hostId = ws.playerId;
      room.addClient(ws.playerId, ws, msg.name);
      ws.roomCode = room.code;
      room.broadcastState();
      break;
    }
    case 'set_name': {
      const room = rooms.get(ws.roomCode);
      if (!room) return;
      room.setPlayerName(ws.playerId, msg.name);
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
      const result = room.setSettings(ws.playerId, msg.settings || {});
      if (!result.ok) return send(ws, { type: 'error', error: result.error });
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
    case 'continue':
    case 'next_challenge': {
      const requestId = typeof msg.requestId === 'string' ? msg.requestId.slice(0, 64) : null;
      if (requestId && ws.nextChallengeResponses.has(requestId)) {
        send(ws, ws.nextChallengeResponses.get(requestId));
        break;
      }
      const room = rooms.get(ws.roomCode);
      if (!room) {
        const response = {
          type: 'next_challenge_result',
          requestId,
          ok: false,
          error: 'Room not found; rejoin or create a new room',
        };
        if (requestId) ws.nextChallengeResponses.set(requestId, response);
        send(ws, response);
        break;
      }
      const result = room.nextChallenge(ws.playerId);
      const response = {
        type: 'next_challenge_result',
        requestId,
        ok: result.ok,
        ...(result.ok ? { challengeId: room.challenge?.id || null } : { error: result.error }),
      };
      if (requestId) {
        ws.nextChallengeResponses.set(requestId, response);
        if (ws.nextChallengeResponses.size > 10) {
          ws.nextChallengeResponses.delete(ws.nextChallengeResponses.keys().next().value);
        }
      }
      send(ws, response);
      break;
    }
    case 'return_to_setup': {
      const room = rooms.get(ws.roomCode);
      if (!room) return send(ws, { type: 'error', error: 'Room not found; rejoin or create a new room' });
      const result = room.returnToSetup(ws.playerId);
      send(ws, {
        type: 'return_to_setup_result',
        ok: result.ok,
        ...(result.ok ? {} : { error: result.error }),
      });
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

function shutdown(signal) {
  console.log(`${signal} received; shutting down`);
  rooms.shutdown();
  wss.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));
