'use strict';

const crypto = require('crypto');
const Callsigns = require('../js/callsigns');
const {
  ALGO_IDS,
  ALGO_NAMES,
  createWindows,
  seedWindowsForPower,
  mulberry32,
  aggregateHashrates,
  mineOneBlock,
  powerToHashrate,
} = require('./engine');
const { drawChallenge, publicChallenge, ObjectiveTracker } = require('./challenges');
const { recordRound } = require('./research');

const ROOM_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const MAX_CHAIN = 200;
const DEFAULT_WINDOW = 45;
// 30x keeps a 120s target block around 3-4 real seconds — slow enough to
// watch an attack unfold on the battlefield. Hosts can still crank it up.
const DEFAULT_SPEEDUP = 30;
const DEFAULT_HASHRATE = 100;
const DEFAULT_GOAL = 20;
const POINTS_PER_BLOCK = 100;
const STREAK_BONUS = 25;
const PUBLIC_LOBBY_COUNTDOWN_MS = envDuration('PUBLIC_LOBBY_COUNTDOWN_MS', 10_000);
const PUBLIC_INTERMISSION_MS = envDuration('PUBLIC_INTERMISSION_MS', 5_000);
const PUBLIC_EMPTY_GRACE_MS = envDuration('PUBLIC_EMPTY_GRACE_MS', 120_000);
const PUBLIC_SESSION_RETURN_MS = envDuration('PUBLIC_SESSION_RETURN_MS', 20_000);
const PUBLIC_SESSION_LENGTH = 5;
// Separates this calibrated, textured simulation from legacy research rows.
const SIMULATION_VERSION = 'mainnet-texture-v2';

function envDuration(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

function sanitizePlayerName(name) {
  const normalized = String(name ?? '').normalize('NFKC')
    .replace(/[\p{Cc}\p{Cf}]/gu, '')
    .replace(/[^\p{L}\p{M}\p{N}\s_.-]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
  return [...normalized].slice(0, 24).join('') || 'Miner';
}

function generateCallsign() {
  return Callsigns.generate((max) => crypto.randomInt(max));
}

function randomCode(length = 5) {
  let code = '';
  for (let i = 0; i < length; i++) {
    code += ROOM_CODE_CHARS[Math.floor(Math.random() * ROOM_CODE_CHARS.length)];
  }
  return code;
}

function createPlayer(id, name, isBot = false, kind = null) {
  const hashrates = { 0: 0, 1: 0, 2: 0, 3: 0 };
  if (!isBot) hashrates[1] = DEFAULT_HASHRATE;
  return {
    id,
    name: sanitizePlayerName(name),
    hashrates,
    connected: true,
    isBot,
    kind,
    blocksMined: 0,
    score: 0,
    sessionBlocksMined: 0,
    sessionScore: 0,
    streak: 0,
    bestStreak: 0,
  };
}

class Room {
  constructor(code, hostId, onEmptyExpired = null) {
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
    this.variantMode = 'random';
    this.speedup = DEFAULT_SPEEDUP;
    this.goalBlocks = DEFAULT_GOAL;
    this.running = false;
    this.roundOver = false;
    this.winnerId = null;
    this.blockTimer = null;
    this.lifecycleTimer = null;
    this.lifecycleKind = null;
    this.lifecycleDeadline = null;
    this._lifecycleGeneration = 0;
    this.emptyRoomTimer = null;
    this.emptyRoomDeadline = null;
    this.onEmptyExpired = onEmptyExpired;
    this.rng = mulberry32((Date.now() ^ Math.floor(Math.random() * 1e9)) >>> 0);
    this.createdAt = Date.now();
    this.lastActiveAt = this.createdAt;
    this.listed = true;
    this.challenge = null;
    this.objective = null;
    this.lastResult = null;
    this.shadow = null;
    this.sessionId = crypto.randomBytes(8).toString('hex');
    this.sessionRound = 1;
    this.sessionLength = PUBLIC_SESSION_LENGTH;
    this.sessionResults = [];
    this.sessionComplete = false;
    this.sessionSummary = null;
    this.sessionReturnDeadline = null;
  }

  addClient(playerId, ws, name) {
    this._clearEmptyRoomTimer();
    let player = this.players.get(playerId);
    const requestedName = sanitizePlayerName(name);
    const defaultRequested = requestedName.toLowerCase() === 'miner';
    const preferredName = defaultRequested ? (player?.name || generateCallsign()) : requestedName;
    const displayName = this.uniqueHumanName(preferredName, playerId);
    if (!player) {
      player = createPlayer(playerId, displayName);
      this.players.set(playerId, player);
    } else {
      player.name = displayName;
      player.connected = true;
    }
    this.clients.set(playerId, ws);
    this.lastActiveAt = Date.now();
    // A rejoining human reclaims the host seat if the current host is a bot,
    // disconnected, or missing.
    const currentHost = this.hostId ? this.players.get(this.hostId) : null;
    if (!currentHost || currentHost.isBot || !currentHost.connected) this.hostId = playerId;
    this.reconcileLifecycle();
    return player;
  }

  uniqueHumanName(name, playerId = null) {
    const taken = (candidate) => [...this.players.values()].some((player) => (
      !player.isBot
      && player.id !== playerId
      && player.name.toLocaleLowerCase() === candidate.toLocaleLowerCase()
    ));
    if (!taken(name)) return name;
    for (let suffix = 2; suffix < 100; suffix += 1) {
      const tag = `-${suffix}`;
      const candidate = `${[...name].slice(0, 24 - tag.length).join('')}${tag}`;
      if (!taken(candidate)) return candidate;
    }
    for (let attempt = 0; attempt < 1000; attempt += 1) {
      const candidate = generateCallsign();
      if (!taken(candidate)) return candidate;
    }
    throw new Error('Unable to allocate a unique callsign');
  }

  setPlayerName(playerId, name) {
    const player = this.players.get(playerId);
    if (!player || player.isBot) return;
    const sanitized = sanitizePlayerName(name);
    const preferred = sanitized.toLowerCase() === 'miner' ? generateCallsign() : sanitized;
    player.name = this.uniqueHumanName(preferred, playerId);
    this.lastActiveAt = Date.now();
  }

  removeClient(playerId) {
    this.clients.delete(playerId);
    const player = this.players.get(playerId);
    if (player) {
      player.connected = false;
      // No score yet — nothing to preserve for a reconnect, drop the ghost entry.
      if (!player.score && !player.blocksMined && !player.sessionScore && !player.sessionBlocksMined) {
        this.players.delete(playerId);
      }
    }
    this.lastActiveAt = Date.now();

    if (this.hostId === playerId) {
      const nextHost = [...this.players.values()].find((p) => p.connected && !p.isBot);
      this.hostId = nextHost ? nextHost.id : null;
    }

    if (this.connectedHumanCount() === 0) {
      if (this.listed) this._handlePublicRoomEmpty();
      else this.stop();
    } else {
      this.reconcileLifecycle();
    }
  }

  setHashrates(playerId, hashrates) {
    const player = this.players.get(playerId);
    if (!player) return;
    for (const algoId of ALGO_IDS) {
      const value = Number(hashrates?.[algoId] ?? player.hashrates[algoId] ?? 0);
      player.hashrates[algoId] = Number.isFinite(value) ? Math.max(0, Math.min(1e15, value)) : 0;
    }
    this.lastActiveAt = Date.now();
  }

  setSettings(playerId, settings = {}) {
    if (playerId !== this.hostId) return { ok: false, error: 'Only the host can change settings' };
    if (typeof settings.listed === 'boolean' && settings.listed !== this.listed) {
      if (this.running || this.challenge || this.roundOver || this.lifecycleKind === 'intermission') {
        return { ok: false, error: 'Room privacy can only change while waiting for a challenge' };
      }
      this.listed = settings.listed;
      if (this.listed) this._startNewPublicSession();
      this.reconcileLifecycle();
    }
    if (settings.variantMode !== undefined) {
      const variantMode = String(settings.variantMode);
      if (!['random', 'lwma90', 'lwma45_tip004'].includes(variantMode)) {
        return { ok: false, error: 'Unknown network variant mode' };
      }
      if (this.running || this.challenge || this.lifecycleKind) {
        return { ok: false, error: 'Network variant locks when a public countdown begins' };
      }
      this.variantMode = variantMode;
    }
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
    this.lastActiveAt = Date.now();
    return { ok: true };
  }

  leaderboard() {
    return [...this.players.values()]
      .map((p) => ({
        id: p.id,
        name: p.name,
        score: p.score,
        blocksMined: p.blocksMined,
        sessionScore: p.sessionScore,
        sessionBlocksMined: p.sessionBlocksMined,
        streak: p.streak,
        bestStreak: p.bestStreak,
        connected: p.connected,
        isBot: !!p.isBot,
        kind: p.kind || null,
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
    miner.sessionScore += pointsEarned;
    miner.sessionBlocksMined += 1;
    miner.bestStreak = Math.max(miner.bestStreak, miner.streak);

    // Reset other players' personal streaks.
    for (const player of this.players.values()) {
      if (player.id !== miner.id) player.streak = 0;
    }

    block.pointsEarned = pointsEarned;
    block.minerStreak = miner.streak;
    block.minerScore = miner.score;
    this.lastActiveAt = Date.now();
    return { pointsEarned, streak: miner.streak };
  }

  discoveryState() {
    if (this.sessionComplete) return 'session_complete';
    if (this.running) return 'live';
    if (this.roundOver) return 'between_rounds';
    if (this.challenge) return 'paused';
    return 'waiting';
  }

  connectedHumanCount() {
    return [...this.players.values()].filter((player) => player.connected && !player.isBot).length;
  }

  hasSoloControl(playerId) {
    if (!this.listed || this.connectedHumanCount() !== 1) return false;
    const player = this.players.get(playerId);
    return !!player && player.connected && !player.isBot;
  }

  sessionState(forPlayerId = null) {
    if (!this.listed) {
      return {
        sessionId: null,
        sessionRound: null,
        sessionLength: null,
        sessionComplete: false,
        sessionReturnDeadline: null,
        sessionResults: [],
        sessionSummary: null,
        controlMode: 'host',
        canSoloControl: false,
      };
    }
    const solo = this.connectedHumanCount() === 1;
    return {
      sessionId: this.sessionId,
      sessionRound: this.sessionRound,
      sessionLength: this.sessionLength,
      sessionComplete: this.sessionComplete,
      sessionReturnDeadline: this.sessionReturnDeadline,
      sessionResults: this.sessionResults.map((entry) => ({
        round: entry.sessionRound,
        challengeId: entry.challenge?.id || null,
        challengeName: entry.challenge?.name || 'Challenge',
        success: !!entry.success,
        variantLabel: entry.challenge?.variantLabel || '',
        assignmentMode: entry.assignmentMode === 'manual' ? 'manual' : 'randomized',
      })),
      sessionSummary: this.sessionSummary,
      controlMode: solo ? 'solo' : 'auto',
      canSoloControl: forPlayerId ? this.hasSoloControl(forPlayerId) : false,
    };
  }

  lifecycleState(now = Date.now()) {
    return {
      lifecycleMode: this.listed ? 'auto' : 'hosted',
      countdownKind: this.lifecycleKind,
      countdownDeadline: this.lifecycleDeadline,
      remainingMs: this.lifecycleDeadline === null ? null : Math.max(0, this.lifecycleDeadline - now),
      connectedHumans: this.connectedHumanCount(),
    };
  }

  publicListing(capacity) {
    const humans = this.connectedHumanCount();
    const challenge = publicChallenge(this.challenge);
    return {
      code: this.code,
      state: this.discoveryState(),
      humans,
      capacity,
      joinable: humans < capacity,
      challenge: challenge ? { id: challenge.id, name: challenge.name } : null,
      variant: challenge
        ? { label: challenge.variantLabel, classification: challenge.assignmentMode }
        : null,
      height: this.height,
      sessionRound: this.sessionRound,
      sessionLength: this.sessionLength,
      sessionComplete: this.sessionComplete,
      progress: {
        currentBlock: this.height,
        durationBlocks: challenge?.durationBlocks || null,
        fraction: challenge?.durationBlocks
          ? Math.min(1, this.height / challenge.durationBlocks)
          : 0,
      },
      createdAt: new Date(this.createdAt).toISOString(),
      lastActiveAt: new Date(this.lastActiveAt).toISOString(),
      ...this.lifecycleState(),
    };
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
      variantMode: this.variantMode,
      listed: this.listed,
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
      shadow: this.shadow && !this.shadow.done && this.shadow.count > 0
        ? { count: this.shadow.count, algo: this.shadow.algo }
        : null,
      lastResult: this.lastResult,
      ...this.lifecycleState(),
      ...this.sessionState(forPlayerId),
    };
  }

  broadcast(message) {
    const payload = JSON.stringify(message);
    for (const ws of this.clients.values()) {
      if (ws.readyState === 1) ws.send(payload);
    }
  }

  broadcastState() {
    this.lastActiveAt = Date.now();
    for (const [playerId, ws] of this.clients.entries()) {
      if (ws.readyState === 1) ws.send(JSON.stringify(this.snapshot(playerId)));
    }
  }

  start(playerId) {
    if (this.running) return { ok: true };
    if (this.listed) {
      if (!this.hasSoloControl(playerId)) {
        return { ok: false, error: 'Public controls require exactly one connected human' };
      }
      if (this.sessionComplete) return { ok: false, error: 'This five-challenge session is complete' };
      if (this.challenge && !this.roundOver) return this._resumeChallengeAtomic();
      return this.roundOver ? this._nextChallengeAtomic() : this._startChallengeAtomic();
    }
    if (playerId !== this.hostId) return { ok: false, error: 'Only the host can start' };
    return this.roundOver ? this._nextChallengeAtomic() : this._startChallengeAtomic();
  }

  nextChallenge(playerId) {
    if (this.listed && !this.hasSoloControl(playerId)) {
      return { ok: false, error: 'Public controls require exactly one connected human' };
    }
    if (!this.listed && playerId !== this.hostId) return { ok: false, error: 'Only the host can continue' };
    if (this.listed && this.sessionComplete) return { ok: false, error: 'This five-challenge session is complete' };
    if (this.listed && this.running) return { ok: true };
    if (this.running) return { ok: false, error: 'A challenge is already running' };
    if (!this.roundOver) return { ok: false, error: 'The current round is not complete' };

    return this._nextChallengeAtomic();
  }

  _nextChallengeAtomic() {
    if (this.running) return { ok: false, error: 'A challenge is already running' };
    if (!this.roundOver) return { ok: false, error: 'The current round is not complete' };
    if (this.listed && this.connectedHumanCount() === 0) {
      return { ok: false, error: 'At least one connected player is required' };
    }
    this._clearLifecycleTimer();
    // Complete the entire transition before any state is broadcast. Clients
    // cannot observe an idle gap between reset and start.
    this._removeBots();
    this.challenge = null;
    this.objective = null;
    this.shadow = null;
    this.lastResult = null;
    if (this.listed) this.sessionRound = Math.min(this.sessionLength, this.sessionResults.length + 1);
    this._resetScoresAndChain(true);
    return this._startChallengeAtomic();
  }

  _startChallengeAtomic() {
    if (this.running) return { ok: true };
    this._clearLifecycleTimer();
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

  _resumeChallengeAtomic() {
    if (this.running) return { ok: true };
    if (!this.challenge || this.roundOver) return { ok: false, error: 'No paused challenge to resume' };
    this._clearLifecycleTimer();
    this.running = true;
    this.broadcast({ type: 'status', message: 'Race resumed', running: true });
    this.broadcastState();
    this.scheduleNext(200);
    return { ok: true };
  }

  returnToSetup(playerId) {
    if (playerId !== this.hostId) return { ok: false, error: 'Only the host can return to setup' };
    if (this.listed) return { ok: false, error: 'Public rooms continue automatically' };
    if (this.running) return { ok: false, error: 'A challenge is already running' };
    if (!this.roundOver) return { ok: false, error: 'The current round is not complete' };
    this._removeBots();
    this.challenge = null;
    this.objective = null;
    this.shadow = null;
    this.lastResult = null;
    this._resetScoresAndChain(true);
    this.broadcast({ type: 'status', message: 'Ready — choose a network variant or start the next challenge', running: false });
    this.broadcastState();
    return { ok: true };
  }

  _armChallenge() {
    this.challenge = drawChallenge(this.rng, this.variantMode);
    this.objective = new ObjectiveTracker(this.challenge);
    this.lastResult = null;

    // The drawn variant *is* the network config under test.
    this.windowSize = this.challenge.variant.windowSize;
    this.penalty = this.challenge.variant.penalty;
    this.goalBlocks = this.challenge.durationBlocks;
    this._resetScoresAndChain(true);

    for (const bot of this.challenge.bots) {
      const player = createPlayer(`bot:${bot.name}`, bot.name, true, bot.kind);
      this.players.set(player.id, player);
    }
    // Selfish-mining state: the shadow rig mines a hidden chain off the books.
    this.shadow = this.challenge.shadow
      ? { ...this.challenge.shadow, count: 0, done: false }
      : null;
    this._applyBotSchedules(0);
    // Start the round in difficulty equilibrium for the opening power mix so
    // the scored objective measures the attack response, not warm-up drift.
    // Windows are seeded with real mainnet texture (see engine.js).
    seedWindowsForPower(this.windows, aggregateHashrates(this.players), this.simTimestamp, this.rng);
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
    if (playerId && this.listed && !this.hasSoloControl(playerId)) {
      return { ok: false, error: 'Public pause requires exactly one connected human' };
    }
    if (playerId && !this.listed && playerId !== this.hostId) {
      return { ok: false, error: 'Only the host can stop' };
    }
    if (playerId && this.listed && (!this.running || !this.challenge || this.roundOver)) {
      return { ok: false, error: 'Only an active public challenge can be paused' };
    }
    this.running = false;
    this._clearBlockTimer();
    this._clearLifecycleTimer();
    this.broadcast({
      type: 'status',
      message: this.listed ? 'Solo control paused the race' : 'Race paused',
      running: false,
    });
    this.broadcastState();
    return { ok: true };
  }

  reset(playerId) {
    if (this.listed) {
      if (!this.hasSoloControl(playerId)) {
        return { ok: false, error: 'Public abandon requires exactly one connected human' };
      }
      if (!this.challenge || this.roundOver || this.sessionComplete) {
        return { ok: false, error: 'No active public round to abandon' };
      }
      this._resetPublicToWaiting();
      this.broadcast({
        type: 'status',
        message: `Challenge ${this.sessionRound} abandoned — no research datapoint recorded; replaying this slot`,
        running: false,
      });
      this._beginLifecycleCountdown('lobby', PUBLIC_LOBBY_COUNTDOWN_MS);
      return { ok: true };
    }
    if (playerId !== this.hostId) return { ok: false, error: 'Only the host can reset' };
    this.roundOver = false;
    this.winnerId = null;
    this._removeBots();
    this.challenge = null;
    this.objective = null;
    this.shadow = null;
    for (const [id, p] of this.players) {
      if (!p.connected) this.players.delete(id);
    }
    this.stop();
    this._resetScoresAndChain(true);
    this.broadcast({ type: 'status', message: 'Round abandoned — ready for a new challenge', running: false });
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

  _startNewPublicSession() {
    this.sessionId = crypto.randomBytes(8).toString('hex');
    this.sessionRound = 1;
    this.sessionResults = [];
    this.sessionComplete = false;
    this.sessionSummary = null;
    this.sessionReturnDeadline = null;
    for (const player of this.players.values()) {
      player.sessionScore = 0;
      player.sessionBlocksMined = 0;
    }
  }

  finishChallenge() {
    this.running = false;
    this.roundOver = true;
    this._clearBlockTimer();

    const result = this.objective.evaluate();
    const humans = [...this.players.values()].filter((p) => !p.isBot && p.connected);
    const mvp = this.leaderboard().find((p) => !p.isBot);

    this.lastResult = {
      ...result,
      challenge: publicChallenge(this.challenge),
      assignmentMode: this.challenge.assignmentMode || 'randomized',
      selectedVariant: this.challenge.variant.id,
      mvpName: mvp?.name || null,
      humans: humans.length,
      sessionId: this.listed ? this.sessionId : null,
      sessionRound: this.listed ? this.sessionRound : null,
      sessionLength: this.listed ? this.sessionLength : null,
    };

    recordRound({
      ts: Date.now(),
      room: this.code,
      simulationVersion: SIMULATION_VERSION,
      challenge: this.challenge.id,
      challengeName: this.challenge.name,
      variant: this.challenge.variant.id,
      variantLabel: this.challenge.variant.label,
      assignmentMode: this.challenge.assignmentMode || 'randomized',
      selectedVariant: this.challenge.variant.id,
      humans: humans.length,
      blocks: this.height,
      sessionId: this.listed ? this.sessionId : null,
      sessionRound: this.listed ? this.sessionRound : null,
      sessionLength: this.listed ? this.sessionLength : null,
      ...result,
    });

    if (this.listed) {
      this.sessionResults.push(this.lastResult);
      if (this.sessionResults.length >= this.sessionLength) {
        this.sessionComplete = true;
        this.sessionSummary = this._buildSessionSummary();
        this.sessionReturnDeadline = Date.now() + PUBLIC_SESSION_RETURN_MS;
        if (this.connectedHumanCount() > 0) {
          this._beginLifecycleCountdown('session_end', PUBLIC_SESSION_RETURN_MS);
        }
      } else if (this.connectedHumanCount() > 0) {
        this._beginLifecycleCountdown('intermission', PUBLIC_INTERMISSION_MS);
      }
    }
    this.broadcast({
      type: 'round_result',
      result: this.lastResult,
      leaderboard: this.leaderboard(),
    });
    if (this.sessionComplete) {
      this.broadcast({
        type: 'session_complete',
        summary: this.sessionSummary,
        returnDeadline: this.sessionReturnDeadline,
      });
    }
    this.broadcastState();
  }

  _buildSessionSummary() {
    const results = this.sessionResults.slice(0, this.sessionLength);
    const scoredBlocks = results.reduce((sum, entry) => sum + (Number(entry.scoredBlocks) || 0), 0);
    const weightedBt = results.reduce(
      (sum, entry) => sum + (Number(entry.meanBt) || 0) * (Number(entry.scoredBlocks) || 0),
      0
    );
    const classifications = results.reduce((counts, entry) => {
      const key = entry.assignmentMode === 'manual' ? 'exploratory' : 'official';
      counts[key] += 1;
      return counts;
    }, { official: 0, exploratory: 0 });
    const contributions = [...this.players.values()]
      .filter((player) => !player.isBot)
      .map((player) => ({
        id: player.id,
        name: player.name,
        score: player.sessionScore || 0,
        blocksMined: player.sessionBlocksMined || 0,
        connected: player.connected,
      }))
      .sort((a, b) => b.score - a.score || b.blocksMined - a.blocksMined || a.name.localeCompare(b.name));
    return {
      sessionId: this.sessionId,
      sessionLength: this.sessionLength,
      objectivesDefended: results.filter((entry) => entry.success).length,
      classifications,
      results: results.map((entry) => ({
        round: entry.sessionRound,
        challengeId: entry.challenge?.id || null,
        challengeName: entry.challenge?.name || 'Challenge',
        verdict: entry.success ? 'NETWORK DEFENDED' : 'NETWORK DEGRADED',
        success: !!entry.success,
        variantLabel: entry.challenge?.variantLabel || '',
        assignmentMode: entry.assignmentMode === 'manual' ? 'manual' : 'randomized',
      })),
      health: {
        meanBt: scoredBlocks ? Number((weightedBt / scoredBlocks).toFixed(1)) : 0,
        orphans: results.reduce((sum, entry) => sum + (Number(entry.orphans) || 0), 0),
        deepestReorg: Math.max(0, ...results.map((entry) => Number(entry.deepestReorg) || 0)),
        longestWait: Math.max(0, ...results.map((entry) => Number(entry.worstGap) || 0)),
        difficultySwing: Number(Math.max(1, ...results.map((entry) => Number(entry.diffSwing) || 1)).toFixed(2)),
      },
      contributions,
      note: 'Each challenge recorded one independent research datapoint; this session summary is not an additional datapoint.',
    };
  }

  /**
   * Selfish-mining simulation. While the round is between startAt and stopAt,
   * the shadow rig mines the target algo on a private chain: during each
   * public block's solve time it finds Poisson(shadowRate * blockTime) hidden
   * blocks, where shadowRate = hashrate / current public difficulty. Players
   * pushing hash onto that lane raise its difficulty and starve the rig.
   */
  _shadowStep(block) {
    const shadow = this.shadow;
    if (!shadow || shadow.done || this.roundOver) return;
    if (this.height < shadow.startAt) return;

    if (this.height >= shadow.stopAt) {
      if (shadow.count >= shadow.minReveal) {
        this._revealShadow();
      } else if (shadow.count > 0) {
        this.broadcast({
          type: 'shadow_fizzle',
          algo: shadow.algo,
          algoName: ALGO_NAMES[shadow.algo],
          count: shadow.count,
        });
        shadow.count = 0;
      }
      shadow.done = true;
      return;
    }

    const telemetry = (block.telemetry || []).find((t) => t.algo === shadow.algo);
    const difficulty = Number(telemetry?.difficulty || 0);
    if (difficulty <= 0) return;
    const lambda = (powerToHashrate(shadow.algo, shadow.power) / difficulty) * block.blockTime;

    // Knuth Poisson sampler — lambda is small (<< 1 at healthy difficulty).
    let found = 0;
    const limit = Math.exp(-lambda);
    let p = this.rng();
    while (p > limit) { found += 1; p *= this.rng(); }

    if (found > 0) {
      shadow.dryStreak = 0;
      shadow.count = Math.min(shadow.revealAt, shadow.count + found);
      this.broadcast({
        type: 'shadow_block',
        count: shadow.count,
        algo: shadow.algo,
        algoName: ALGO_NAMES[shadow.algo],
      });
      if (shadow.count >= shadow.revealAt) this._revealShadow();
    } else if (shadow.count > 0) {
      // Every public block found while the rig is dry pulls the honest chain
      // ahead; after staleAfter dry blocks the oldest hidden block goes stale.
      shadow.dryStreak = (shadow.dryStreak || 0) + 1;
      if (shadow.dryStreak >= shadow.staleAfter) {
        shadow.dryStreak = 0;
        shadow.count -= 1;
        this.broadcast({
          type: 'shadow_block',
          count: shadow.count,
          algo: shadow.algo,
          algoName: ALGO_NAMES[shadow.algo],
          stale: true,
        });
      }
    }
  }

  /**
   * The hidden chain is revealed: the last `depth` canonical blocks are
   * orphaned and replaced by the attacker's blocks. Points earned on the
   * orphaned blocks are clawed back; the attacker banks the replacements.
   * The reorged blocks count as consecutive shadow-algo wins, so under
   * TIP-004 the attacker's lane comes out of the reveal heavily penalized.
   */
  _revealShadow() {
    const shadow = this.shadow;
    const depth = Math.min(shadow.count, shadow.revealAt, this.chain.length);
    if (depth <= 0) { shadow.count = 0; return; }

    const attackerBot = this.challenge.bots.find((b) => b.kind === 'attacker');
    const attackerId = attackerBot ? `bot:${attackerBot.name}` : null;
    const attacker = attackerId ? this.players.get(attackerId) : null;

    const orphaned = this.chain.splice(-depth);
    for (const dead of orphaned) {
      const victim = dead.minerId ? this.players.get(dead.minerId) : null;
      if (victim) {
        victim.score = Math.max(0, victim.score - (dead.pointsEarned || 0));
        victim.blocksMined = Math.max(0, victim.blocksMined - 1);
        victim.sessionScore = Math.max(0, victim.sessionScore - (dead.pointsEarned || 0));
        victim.sessionBlocksMined = Math.max(0, victim.sessionBlocksMined - 1);
      }
    }

    // Roll the orphaned tip samples out of their algo windows, then feed the
    // replacement blocks into the shadow algo so future LWMA calculations
    // follow the rewritten canonical history.
    for (const dead of [...orphaned].reverse()) {
      const samples = this.windows[dead.algo]?.samples;
      if (samples?.length) samples.pop();
    }
    const newBlocks = orphaned.map((dead) => {
      const replacementDifficulty = this.windows[shadow.algo].calculate()
        || BigInt(dead.difficulty);
      this.windows[shadow.algo].add(dead.timestamp, replacementDifficulty);
      return {
        ...dead,
        algo: shadow.algo,
        algoName: ALGO_NAMES[shadow.algo],
        difficulty: replacementDifficulty.toString(),
        minerId: attackerId,
        minerName: attacker?.name || 'SHADOW RIG',
        pointsEarned: POINTS_PER_BLOCK,
        minerStreak: 0,
        minerScore: attacker ? attacker.score : 0,
        orphan: null,
        reorged: true,
        telemetry: (dead.telemetry || []).map((entry) => entry.algo === shadow.algo
          ? { ...entry, difficulty: replacementDifficulty.toString() }
          : entry),
      };
    });
    this.chain.push(...newBlocks);

    if (attacker) {
      attacker.score += depth * POINTS_PER_BLOCK;
      attacker.blocksMined += depth;
      attacker.sessionScore += depth * POINTS_PER_BLOCK;
      attacker.sessionBlocksMined += depth;
    }
    // Streaks don't survive a rewrite; the shadow algo now owns the tip.
    for (const player of this.players.values()) player.streak = 0;
    this.lastMinerId = attackerId;
    this.lastWinner = shadow.algo;
    this.consecutiveCount = depth - 1;

    if (this.objective) this.objective.noteReorg(depth);
    shadow.count = 0;

    this.broadcast({
      type: 'reorg',
      depth,
      algo: shadow.algo,
      algoName: ALGO_NAMES[shadow.algo],
      attackerName: attacker?.name || 'SHADOW RIG',
      orphanedBlocks: orphaned.map((b) => ({
        height: b.height, algo: b.algo, algoName: b.algoName, minerName: b.minerName,
      })),
      newBlocks,
      leaderboard: this.leaderboard(),
      objective: this.objective ? this.objective.progress() : null,
    });
  }

  scheduleNext(delayMs = 200) {
    if (!this.running) return;
    if (this.blockTimer) clearTimeout(this.blockTimer);

    // Debug breadcrumbs for /api/debug/:roomCode — a running room whose timer
    // fired long ago with nothing rearmed means the loop chain died.
    this._timerArmedAt = Date.now();
    this.blockTimer = setTimeout(() => {
      this.blockTimer = null;
      if (!this.running) return;

      const block = mineOneBlock(this, this.players, this.rng);
      if (!block) {
        this.scheduleNext(1000);
        return;
      }
      this._lastBlockAt = Date.now();

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

      this._shadowStep(block);

      if (this.challenge && this.height >= this.challenge.durationBlocks) {
        this.finishChallenge();
        return;
      }

      const nextDelay = Math.max(80, Math.min(3000, (block.blockTime / this.speedup) * 1000));
      this.scheduleNext(nextDelay);
    }, delayMs);
  }

  reconcileLifecycle() {
    if (!this.listed) {
      this._clearLifecycleTimer();
      return;
    }
    const humans = this.connectedHumanCount();
    if (humans === 0 || this.running) {
      this._clearLifecycleTimer();
      return;
    }
    if (this.sessionComplete) {
      const remaining = Math.max(0, (this.sessionReturnDeadline || Date.now()) - Date.now());
      if (remaining === 0) this._endPublicSession();
      else if (this.lifecycleKind !== 'session_end') this._beginLifecycleCountdown('session_end', remaining);
      return;
    }
    if (this.roundOver) {
      if (this.lifecycleKind !== 'intermission') {
        this._beginLifecycleCountdown('intermission', PUBLIC_INTERMISSION_MS);
      }
      return;
    }
    if (!this.challenge) {
      if (this.lifecycleKind !== 'lobby') {
        this._beginLifecycleCountdown('lobby', PUBLIC_LOBBY_COUNTDOWN_MS);
      }
      return;
    }
    // A solo pilot may pause. As soon as multiplayer resumes, the server
    // restarts the block loop so a newly joined player cannot inherit a stall.
    if (humans > 1) this._resumeChallengeAtomic();
  }

  _beginLifecycleCountdown(kind, durationMs) {
    this._clearLifecycleTimer();
    if (!this.listed || this.connectedHumanCount() === 0) return;
    const generation = this._lifecycleGeneration;
    this.lifecycleKind = kind;
    this.lifecycleDeadline = Date.now() + durationMs;
    this._lifecycleArmedAt = Date.now();
    this.lifecycleTimer = setTimeout(() => {
      this.lifecycleTimer = null;
      if (generation !== this._lifecycleGeneration || this.lifecycleKind !== kind) return;
      this.lifecycleKind = null;
      this.lifecycleDeadline = null;
      if (!this.listed || this.connectedHumanCount() === 0) return;
      if (kind === 'lobby' && !this.running && !this.challenge && !this.roundOver) {
        this._startChallengeAtomic();
      } else if (kind === 'intermission' && !this.running && this.roundOver) {
        this._nextChallengeAtomic();
      } else if (kind === 'session_end' && this.sessionComplete) {
        this._endPublicSession();
      }
    }, durationMs);
    this.broadcastState();
  }

  _clearLifecycleTimer() {
    this._lifecycleGeneration += 1;
    if (this.lifecycleTimer) clearTimeout(this.lifecycleTimer);
    this.lifecycleTimer = null;
    this.lifecycleKind = null;
    this.lifecycleDeadline = null;
  }

  _clearBlockTimer() {
    if (this.blockTimer) clearTimeout(this.blockTimer);
    this.blockTimer = null;
  }

  _resetPublicToWaiting() {
    this.running = false;
    this.roundOver = false;
    this._clearBlockTimer();
    this._clearLifecycleTimer();
    for (const player of this.players.values()) {
      player.sessionScore = Math.max(0, player.sessionScore - player.score);
      player.sessionBlocksMined = Math.max(0, player.sessionBlocksMined - player.blocksMined);
    }
    this._removeBots();
    this.challenge = null;
    this.objective = null;
    this.shadow = null;
    this.lastResult = null;
    this._resetScoresAndChain(true);
  }

  _handlePublicRoomEmpty() {
    const wasRoundOver = this.roundOver;
    this._clearBlockTimer();
    this._clearLifecycleTimer();
    if (!wasRoundOver) this._resetPublicToWaiting();
    this._clearEmptyRoomTimer();
    const sessionRemaining = this.sessionComplete && this.sessionReturnDeadline
      ? Math.max(0, this.sessionReturnDeadline - Date.now())
      : PUBLIC_EMPTY_GRACE_MS;
    const expiryMs = Math.min(PUBLIC_EMPTY_GRACE_MS, sessionRemaining);
    this.emptyRoomDeadline = Date.now() + expiryMs;
    this.emptyRoomTimer = setTimeout(() => {
      this.emptyRoomTimer = null;
      this.emptyRoomDeadline = null;
      if (this.connectedHumanCount() === 0 && this.onEmptyExpired) this.onEmptyExpired(this);
    }, expiryMs);
  }

  _endPublicSession() {
    if (!this.listed || !this.sessionComplete) return;
    this._clearBlockTimer();
    this._clearLifecycleTimer();
    this.broadcast({
      type: 'session_ended',
      sessionId: this.sessionId,
      message: 'Five-challenge session complete — returning to lobby',
    });
    if (this.onEmptyExpired) this.onEmptyExpired(this);
  }

  _clearEmptyRoomTimer() {
    if (this.emptyRoomTimer) clearTimeout(this.emptyRoomTimer);
    this.emptyRoomTimer = null;
    this.emptyRoomDeadline = null;
  }

  destroy() {
    this.running = false;
    this._clearBlockTimer();
    this._clearLifecycleTimer();
    this._clearEmptyRoomTimer();
    for (const ws of this.clients.values()) {
      if (ws.readyState === 1 && typeof ws.close === 'function') ws.close(1001, 'Room closed');
    }
    this.clients.clear();
  }
}

class RoomManager {
  constructor() {
    this.rooms = new Map();
  }

  create() {
    let code = randomCode();
    while (this.rooms.has(code)) code = randomCode();
    const room = new Room(code, null, (expiredRoom) => {
      if (this.rooms.get(code) !== expiredRoom) return;
      expiredRoom.destroy();
      this.rooms.delete(code);
    });
    this.rooms.set(code, room);
    return room;
  }

  get(code) {
    if (!code) return null;
    return this.rooms.get(String(code).trim().toUpperCase()) || null;
  }

  publicListings(capacity) {
    return [...this.rooms.values()]
      .filter((room) => room.listed && room.clients.size > 0)
      .map((room) => room.publicListing(capacity))
      .sort((a, b) => Date.parse(b.lastActiveAt) - Date.parse(a.lastActiveAt));
  }

  cleanupIdle(maxAgeMs = 1000 * 60 * 60 * 2) {
    const now = Date.now();
    for (const [code, room] of this.rooms.entries()) {
      if (room.clients.size === 0 && !room.emptyRoomTimer && now - room.createdAt > maxAgeMs) {
        room.destroy();
        this.rooms.delete(code);
      }
    }
  }

  shutdown() {
    for (const room of this.rooms.values()) room.destroy();
    this.rooms.clear();
  }
}

module.exports = {
  Room,
  RoomManager,
  DEFAULT_HASHRATE,
  PUBLIC_LOBBY_COUNTDOWN_MS,
  PUBLIC_INTERMISSION_MS,
  PUBLIC_EMPTY_GRACE_MS,
  PUBLIC_SESSION_RETURN_MS,
  PUBLIC_SESSION_LENGTH,
  sanitizePlayerName,
  generateCallsign,
};
