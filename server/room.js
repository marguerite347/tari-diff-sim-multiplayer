'use strict';

const {
  ALGO_IDS,
  ALGO_NAMES,
  createWindows,
  mulberry32,
  aggregateHashrates,
  mineOneBlock,
} = require('./engine');

const ROOM_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const MAX_CHAIN = 200;
const DEFAULT_WINDOW = 45;
const DEFAULT_SPEEDUP = 60;
const DEFAULT_HASHRATE = 100;

function randomCode(length = 5) {
  let code = '';
  for (let i = 0; i < length; i++) {
    code += ROOM_CODE_CHARS[Math.floor(Math.random() * ROOM_CODE_CHARS.length)];
  }
  return code;
}

function createPlayer(id, name) {
  const hashrates = { 0: 0, 1: 0, 2: 0, 3: 0 };
  hashrates[1] = DEFAULT_HASHRATE;
  return {
    id,
    name: String(name || 'Miner').slice(0, 24),
    hashrates,
    connected: true,
  };
}

class Room {
  constructor(code, hostId) {
    this.code = code;
    this.hostId = hostId;
    this.players = new Map();
    this.clients = new Map();
    this.chain = [];
    this.windows = createWindows(DEFAULT_WINDOW);
    this.height = 0;
    this.simTimestamp = 1_700_000_000;
    this.lastWinner = -1;
    this.consecutiveCount = 0;
    this.penalty = true;
    this.windowSize = DEFAULT_WINDOW;
    this.speedup = DEFAULT_SPEEDUP;
    this.running = false;
    this.timer = null;
    this.rng = mulberry32((Date.now() ^ Math.floor(Math.random() * 1e9)) >>> 0);
    this.createdAt = Date.now();
  }

  addClient(playerId, ws, name) {
    let player = this.players.get(playerId);
    if (!player) {
      player = createPlayer(playerId, name);
      this.players.set(playerId, player);
    } else {
      player.name = String(name || player.name).slice(0, 24);
      player.connected = true;
    }
    this.clients.set(playerId, ws);
    return player;
  }

  removeClient(playerId) {
    this.clients.delete(playerId);
    const player = this.players.get(playerId);
    if (player) player.connected = false;

    if (this.hostId === playerId) {
      const nextHost = [...this.players.values()].find((p) => p.connected);
      this.hostId = nextHost ? nextHost.id : null;
    }

    if (this.clients.size === 0) this.stop();
  }

  setHashrates(playerId, hashrates) {
    const player = this.players.get(playerId);
    if (!player) return;
    for (const algoId of ALGO_IDS) {
      const value = Number(hashrates?.[algoId] ?? player.hashrates[algoId] ?? 0);
      player.hashrates[algoId] = Number.isFinite(value) ? Math.max(0, Math.min(1e15, value)) : 0;
    }
  }

  setSettings(playerId, settings = {}) {
    if (playerId !== this.hostId) return false;
    if (typeof settings.penalty === 'boolean') this.penalty = settings.penalty;
    if (Number.isFinite(settings.speedup)) {
      this.speedup = Math.max(1, Math.min(600, Number(settings.speedup)));
    }
    if (Number.isFinite(settings.windowSize)) {
      const next = Math.max(10, Math.min(90, Math.floor(Number(settings.windowSize))));
      if (next !== this.windowSize && this.chain.length === 0) {
        this.windowSize = next;
        this.windows = createWindows(next);
      }
    }
    return true;
  }

  snapshot(forPlayerId = null) {
    return {
      type: 'room_state',
      room: this.code,
      you: forPlayerId,
      hostId: this.hostId,
      running: this.running,
      penalty: this.penalty,
      windowSize: this.windowSize,
      speedup: this.speedup,
      height: this.height,
      algoNames: ALGO_NAMES,
      players: [...this.players.values()].map((p) => ({
        id: p.id,
        name: p.name,
        hashrates: p.hashrates,
        connected: p.connected,
        isHost: p.id === this.hostId,
      })),
      totals: aggregateHashrates(this.players),
      recentBlocks: this.chain.slice(-40),
      shareUrlPath: `/?room=${this.code}`,
    };
  }

  broadcast(message) {
    const payload = JSON.stringify(message);
    for (const ws of this.clients.values()) {
      if (ws.readyState === 1) ws.send(payload);
    }
  }

  broadcastState() {
    for (const [playerId, ws] of this.clients.entries()) {
      if (ws.readyState === 1) ws.send(JSON.stringify(this.snapshot(playerId)));
    }
  }

  start(playerId) {
    if (playerId !== this.hostId) return { ok: false, error: 'Only the host can start' };
    if (this.running) return { ok: true };

    const totals = aggregateHashrates(this.players);
    const totalHr = ALGO_IDS.reduce((sum, id) => sum + totals[id], 0);
    if (totalHr <= 0) return { ok: false, error: 'Assign some hashrate before starting' };

    this.running = true;
    this.broadcast({ type: 'status', message: 'Simulation started', running: true });
    this.broadcastState();
    this.scheduleNext(80);
    return { ok: true };
  }

  stop(playerId = null) {
    if (playerId && playerId !== this.hostId) return { ok: false, error: 'Only the host can stop' };
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.broadcast({ type: 'status', message: 'Simulation paused', running: false });
    this.broadcastState();
    return { ok: true };
  }

  reset(playerId) {
    if (playerId !== this.hostId) return { ok: false, error: 'Only the host can reset' };
    this.stop();
    this.chain = [];
    this.windows = createWindows(this.windowSize);
    this.height = 0;
    this.simTimestamp = 1_700_000_000;
    this.lastWinner = -1;
    this.consecutiveCount = 0;
    this.broadcast({ type: 'status', message: 'Chain reset', running: false });
    this.broadcastState();
    return { ok: true };
  }

  scheduleNext(delayMs = 200) {
    if (!this.running) return;
    if (this.timer) clearTimeout(this.timer);

    this.timer = setTimeout(() => {
      if (!this.running) return;

      const block = mineOneBlock(this, this.players, this.rng);
      if (!block) {
        this.scheduleNext(1000);
        return;
      }

      this.chain.push(block);
      if (this.chain.length > MAX_CHAIN) this.chain.shift();
      this.broadcast({ type: 'block_mined', block, totals: aggregateHashrates(this.players) });

      const nextDelay = Math.max(80, Math.min(3000, (block.blockTime / this.speedup) * 1000));
      this.scheduleNext(nextDelay);
    }, delayMs);
  }
}

class RoomManager {
  constructor() {
    this.rooms = new Map();
  }

  create() {
    let code = randomCode();
    while (this.rooms.has(code)) code = randomCode();
    const room = new Room(code, null);
    this.rooms.set(code, room);
    return room;
  }

  get(code) {
    if (!code) return null;
    return this.rooms.get(String(code).trim().toUpperCase()) || null;
  }

  cleanupIdle(maxAgeMs = 1000 * 60 * 60 * 2) {
    const now = Date.now();
    for (const [code, room] of this.rooms.entries()) {
      if (room.clients.size === 0 && now - room.createdAt > maxAgeMs) {
        room.stop();
        this.rooms.delete(code);
      }
    }
  }
}

module.exports = { RoomManager, DEFAULT_HASHRATE };
