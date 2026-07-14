'use strict';

const {
  ALGO_IDS,
  ALGO_NAMES,
  createWindows,
  seedWindowsForPower,
  mulberry32,
  aggregateHashrates,
  mineOneBlock,
} = require('./engine');
const { drawChallenge, publicChallenge, ObjectiveTracker } = require('./challenges');
const { recordRound } = require('./research');

const ROOM_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const MAX_CHAIN = 200;
const DEFAULT_WINDOW = 45;
const DEFAULT_SPEEDUP = 120;
const DEFAULT_HASHRATE = 100;
const DEFAULT_GOAL = 20;
const POINTS_PER_BLOCK = 100;
const STREAK_BONUS = 25;

function randomCode(length = 5) {
  let code = '';
  for (let i = 0; i < length; i++) {
    code += ROOM_CODE_CHARS[Math.floor(Math.random() * ROOM_CODE_CHARS.length)];
  }
  return code;
}

function createPlayer(id, name, isBot = false) {
  const hashrates = { 0: 0, 1: 0, 2: 0, 3: 0 };
  if (!isBot) hashrates[1] = DEFAULT_HASHRATE;
  return {
    id,
    name: String(name || 'Miner').slice(0, 24),
    hashrates,
    connected: true,
    isBot,
    blocksMined: 0,
    score: 0,
    streak: 0,
    bestStreak: 0,
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
    this.lastMinerId = null;
    this.penalty = true;
    this.windowSize = DEFAULT_WINDOW;
    this.speedup = DEFAULT_SPEEDUP;
    this.goalBlocks = DEFAULT_GOAL;
    this.running = false;
    this.roundOver = false;
    this.winnerId = null;
    this.timer = null;
    this.rng = mulberry32((Date.now() ^ Math.floor(Math.random() * 1e9)) >>> 0);
    this.createdAt = Date.now();
    this.challenge = null;
    this.objective = null;
    this.lastResult = null;
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
    if (player) {
      player.connected = false;
      // No score yet — nothing to preserve for a reconnect, drop the ghost entry.
      if (!player.score && !player.blocksMined) this.players.delete(playerId);
    }

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
    if (Number.isFinite(settings.speedup)) {
      this.speedup = Math.max(1, Math.min(600, Number(settings.speedup)));
    }
    // Window size and penalty are part of the drawn challenge variant — the
    // experiment under test — so they can't be overridden once a round is armed.
    if (!this.challenge) {
      if (typeof settings.penalty === 'boolean') this.penalty = settings.penalty;
      if (Number.isFinite(settings.windowSize)) {
        const next = Math.max(10, Math.min(90, Math.floor(Number(settings.windowSize))));
        if (next !== this.windowSize && this.chain.length === 0) {
          this.windowSize = next;
          this.windows = createWindows(next);
        }
      }
    }
    return true;
  }

  leaderboard() {
    return [...this.players.values()]
      .map((p) => ({
        id: p.id,
        name: p.name,
        score: p.score,
        blocksMined: p.blocksMined,
        streak: p.streak,
        bestStreak: p.bestStreak,
        connected: p.connected,
        isBot: !!p.isBot,
        isHost: p.id === this.hostId,
        hashrates: p.hashrates,
      }))
      .sort((a, b) => (a.isBot - b.isBot) || b.score - a.score || b.blocksMined - a.blocksMined);
  }

  awardBlock(block) {
    if (!block.minerId) return { pointsEarned: 0, streak: 0 };
    const miner = this.players.get(block.minerId);
    if (!miner) return { pointsEarned: 0, streak: 0 };

    if (this.lastMinerId === block.minerId) miner.streak += 1;
    else miner.streak = 1;
    this.lastMinerId = block.minerId;

    const streakBonus = Math.max(0, miner.streak - 1) * STREAK_BONUS;
    const pointsEarned = POINTS_PER_BLOCK + streakBonus;
    miner.score += pointsEarned;
    miner.blocksMined += 1;
    miner.bestStreak = Math.max(miner.bestStreak, miner.streak);

    // Reset other players' personal streaks.
    for (const player of this.players.values()) {
      if (player.id !== miner.id) player.streak = 0;
    }

    block.pointsEarned = pointsEarned;
    block.minerStreak = miner.streak;
    block.minerScore = miner.score;
    return { pointsEarned, streak: miner.streak };
  }

  snapshot(forPlayerId = null) {
    const board = this.leaderboard();
    return {
      type: 'room_state',
      room: this.code,
      you: forPlayerId,
      hostId: this.hostId,
      running: this.running,
      roundOver: this.roundOver,
      winnerId: this.winnerId,
      penalty: this.penalty,
      windowSize: this.windowSize,
      speedup: this.speedup,
      goalBlocks: this.goalBlocks,
      height: this.height,
      algoNames: ALGO_NAMES,
      players: board,
      totals: aggregateHashrates(this.players),
      recentBlocks: this.chain.slice(-40),
      shareUrlPath: `/?room=${this.code}`,
      challenge: publicChallenge(this.challenge),
      objective: this.objective ? this.objective.progress() : null,
      lastResult: this.lastResult,
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

    if (this.roundOver) {
      this._removeBots();
      this.challenge = null;
      this._resetScoresAndChain(true);
    }
    if (!this.challenge) this._armChallenge();

    this.running = true;
    this.roundOver = false;
    this.winnerId = null;
    this.broadcastState();
    this.broadcast({
      type: 'challenge_brief',
      challenge: publicChallenge(this.challenge),
    });
    // Give players a beat to read the mission card before blocks start.
    this.scheduleNext(4000);
    return { ok: true };
  }

  _armChallenge() {
    this.challenge = drawChallenge(this.rng);
    this.objective = new ObjectiveTracker(this.challenge);
    this.lastResult = null;

    // The drawn variant *is* the network config under test.
    this.windowSize = this.challenge.variant.windowSize;
    this.penalty = this.challenge.variant.penalty;
    this.goalBlocks = this.challenge.durationBlocks;
    this._resetScoresAndChain(true);

    for (const bot of this.challenge.bots) {
      const player = createPlayer(`bot:${bot.name}`, bot.name, true);
      this.players.set(player.id, player);
    }
    this._applyBotSchedules(0);
    // Start the round in difficulty equilibrium for the opening power mix so
    // the scored objective measures the attack response, not warm-up drift.
    seedWindowsForPower(this.windows, aggregateHashrates(this.players), this.simTimestamp);
  }

  _applyBotSchedules(height) {
    if (!this.challenge) return;
    for (const bot of this.challenge.bots) {
      const player = this.players.get(`bot:${bot.name}`);
      if (!player) continue;
      let active = null;
      for (const phase of bot.schedule) {
        if (height >= phase.at) active = phase;
      }
      for (const algoId of ALGO_IDS) {
        player.hashrates[algoId] = Number(active?.hashrates?.[algoId] || 0);
      }
    }
  }

  _removeBots() {
    for (const id of [...this.players.keys()]) {
      if (id.startsWith('bot:')) this.players.delete(id);
    }
  }

  stop(playerId = null) {
    if (playerId && playerId !== this.hostId) return { ok: false, error: 'Only the host can stop' };
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.broadcast({ type: 'status', message: 'Race paused', running: false });
    this.broadcastState();
    return { ok: true };
  }

  reset(playerId) {
    if (playerId !== this.hostId) return { ok: false, error: 'Only the host can reset' };
    this.roundOver = false;
    this.winnerId = null;
    this._removeBots();
    this.challenge = null;
    this.objective = null;
    for (const [id, p] of this.players) {
      if (!p.connected) this.players.delete(id);
    }
    this.stop();
    this._resetScoresAndChain(true);
    this.broadcast({ type: 'status', message: 'New round ready', running: false });
    this.broadcastState();
    return { ok: true };
  }

  _resetScoresAndChain(resetWindows) {
    this.chain = [];
    if (resetWindows) this.windows = createWindows(this.windowSize);
    this.height = 0;
    this.simTimestamp = 1_700_000_000;
    this.lastWinner = -1;
    this.consecutiveCount = 0;
    this.lastMinerId = null;
    this.roundOver = false;
    this.winnerId = null;
    for (const player of this.players.values()) {
      player.blocksMined = 0;
      player.score = 0;
      player.streak = 0;
      player.bestStreak = 0;
    }
  }

  finishChallenge() {
    this.running = false;
    this.roundOver = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    const result = this.objective.evaluate();
    const humans = [...this.players.values()].filter((p) => !p.isBot && p.connected);
    const mvp = this.leaderboard().find((p) => !p.isBot);

    this.lastResult = {
      ...result,
      challenge: publicChallenge(this.challenge),
      mvpName: mvp?.name || null,
      humans: humans.length,
    };

    recordRound({
      ts: Date.now(),
      room: this.code,
      challenge: this.challenge.id,
      challengeName: this.challenge.name,
      variant: this.challenge.variant.id,
      variantLabel: this.challenge.variant.label,
      humans: humans.length,
      blocks: this.height,
      ...result,
    });

    this.broadcast({
      type: 'round_result',
      result: this.lastResult,
      leaderboard: this.leaderboard(),
    });
    this.broadcastState();
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

      this.awardBlock(block);
      this.chain.push(block);
      if (this.chain.length > MAX_CHAIN) this.chain.shift();

      if (this.objective) this.objective.addBlock(block);
      this._applyBotSchedules(this.height);

      this.broadcast({
        type: 'block_mined',
        block,
        totals: aggregateHashrates(this.players),
        leaderboard: this.leaderboard(),
        goalBlocks: this.goalBlocks,
        objective: this.objective ? this.objective.progress() : null,
      });

      if (this.challenge && this.height >= this.challenge.durationBlocks) {
        this.finishChallenge();
        return;
      }

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
