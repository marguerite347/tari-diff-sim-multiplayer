'use strict';

/**
 * Server-side LWMA + mining race engine for multiplayer rooms.
 * Ported from the original client-side lwma.js / simulation.js logic.
 */

const LWMA_MAX_BLOCK_TIME_RATIO = 6n;
const MAX_U64 = 18446744073709551615n;
const RATE_PRECISION = 1_000_000_000n;
const PENALTY_BASE = 2n;
const LOG_EPSILON = 1e-10;

const ALGO_IDS = [0, 1, 2, 3];
const ALGO_NAMES = ['RandomXM', 'Sha3x', 'RandomXT', 'Cuckaroo'];
const ALGO_CONFIG = {
  0: { name: 'RandomXM', minDifficulty: 1_200_000n, targetTime: 480n },
  1: { name: 'Sha3x', minDifficulty: 150_000_000_000n, targetTime: 480n },
  2: { name: 'RandomXT', minDifficulty: 1_200_000n, targetTime: 480n },
  3: { name: 'Cuckaroo', minDifficulty: 1n, targetTime: 480n },
};

class LwmaWindow {
  constructor(blockWindow, targetTime, minDifficulty, maxDifficulty) {
    this.blockWindow = blockWindow;
    this.baseTargetTime = BigInt(targetTime);
    this.targetTime = this.baseTargetTime;
    this.maxBlockTime = this.targetTime * LWMA_MAX_BLOCK_TIME_RATIO;
    this.minDifficulty = BigInt(minDifficulty);
    this.maxDifficulty = BigInt(maxDifficulty);
    this.samples = [];
  }

  updateTargetTime(targetTime) {
    this.targetTime = BigInt(targetTime);
    this.maxBlockTime = this.targetTime * LWMA_MAX_BLOCK_TIME_RATIO;
  }

  add(timestamp, difficulty) {
    this.samples.push({ timestamp: BigInt(timestamp), difficulty: BigInt(difficulty) });
    if (this.samples.length > this.blockWindow + 1) this.samples.shift();
  }

  seedFlat(difficulty, targetTime, count) {
    const diff = BigInt(difficulty);
    const step = BigInt(targetTime);
    let ts = 1_000_000n;
    for (let i = 0; i < count; i++) {
      this.add(ts, diff);
      ts += step;
    }
  }

  calculate() {
    if (this.samples.length <= 1) return null;
    const n = BigInt(this.samples.length - 1);

    let difficultySum = 0n;
    for (let i = 1; i < this.samples.length; i++) difficultySum += this.samples[i].difficulty;
    const avgDifficulty = difficultySum / n;

    let weightedTimes = 0n;
    let prevTimestamp = this.samples[0].timestamp;
    for (let i = 1; i < this.samples.length; i++) {
      let thisTimestamp = this.samples[i].timestamp;
      if (thisTimestamp <= prevTimestamp) thisTimestamp = prevTimestamp + 1n;
      let solveTime = thisTimestamp - prevTimestamp;
      if (solveTime > this.maxBlockTime) solveTime = this.maxBlockTime;
      prevTimestamp = thisTimestamp;
      weightedTimes += solveTime * BigInt(i);
    }
    if (weightedTimes === 0n) weightedTimes = 1n;

    const k = (n * (n + 1n) * this.targetTime) / 2n;
    let target = (avgDifficulty * k) / weightedTimes;
    if (target < this.minDifficulty) target = this.minDifficulty;
    if (target > this.maxDifficulty) target = this.maxDifficulty;
    return target;
  }
}

const SEED_DIFFICULTY_FACTOR = 10n;

function createWindows(windowSize) {
  const windows = {};
  for (const algoId of ALGO_IDS) {
    const cfg = ALGO_CONFIG[algoId];
    const window = new LwmaWindow(windowSize, cfg.targetTime, cfg.minDifficulty, MAX_U64);
    // Seed so the first live blocks have a full window.
    window.seedFlat(cfg.minDifficulty * SEED_DIFFICULTY_FACTOR, cfg.targetTime, windowSize + 1);
    windows[algoId] = window;
  }
  return windows;
}

function mulberry32(seed) {
  let t = seed >>> 0;
  return function next() {
    t += 0x6D2B79F5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function applyPenalty(window, algoId, lastWinner, consecutiveCount, penaltyEnabled) {
  const cfg = ALGO_CONFIG[algoId];
  const consecutive = lastWinner === algoId ? consecutiveCount : 0;
  if (penaltyEnabled && consecutive > 0) {
    const multiplier = PENALTY_BASE ** BigInt(consecutive);
    window.updateTargetTime(cfg.targetTime * multiplier);
    return Number(multiplier);
  }
  window.updateTargetTime(cfg.targetTime);
  return 1;
}

function computeAlgoRates(windows, hashrates, lastWinner, consecutiveCount, penaltyEnabled) {
  const algoRates = [];
  // Abstract power maps to a hashrate anchored at the seeded difficulty, so
  // rate = hashrate / difficulty and the LWMA feedback loop stays intact:
  // 100 power on an algo is in equilibrium at the seed difficulty (480s/algo,
  // 120s overall when all four algos run at 100).
  const REFERENCE_POWER = 100;

  for (const algoId of ALGO_IDS) {
    const cfg = ALGO_CONFIG[algoId];
    const penaltyMultiplier = applyPenalty(
      windows[algoId], algoId, lastWinner, consecutiveCount, penaltyEnabled
    );
    let targetDifficulty = windows[algoId].calculate();
    if (targetDifficulty === null) targetDifficulty = cfg.minDifficulty;

    const power = Number(hashrates[algoId] || 0);
    const seedDifficulty = Number(cfg.minDifficulty * SEED_DIFFICULTY_FACTOR);
    const hashrate = (power / REFERENCE_POWER) * (seedDifficulty / Number(cfg.targetTime));
    const rate = power > 0 ? hashrate / Number(targetDifficulty) : 0;

    algoRates.push({ algo: algoId, targetDifficulty, rate, penaltyMultiplier });
  }
  return algoRates;
}

function sampleWinningAlgo(algoRates, totalRate, rng) {
  const randomValue = rng();
  let cumulative = 0;
  let winner = algoRates[algoRates.length - 1].algo;
  for (const entry of algoRates) {
    cumulative += entry.rate / totalRate;
    if (randomValue <= cumulative) {
      winner = entry.algo;
      break;
    }
  }
  return winner;
}

function sampleBlockTime(totalRate, rng) {
  const u = Math.max(rng(), LOG_EPSILON);
  return Math.max(1, Math.round(-Math.log(u) / totalRate));
}

function aggregateHashrates(players) {
  const totals = { 0: 0, 1: 0, 2: 0, 3: 0 };
  for (const player of players.values()) {
    for (const algoId of ALGO_IDS) {
      totals[algoId] += Number(player.hashrates[algoId] || 0);
    }
  }
  return totals;
}

function mineOneBlock(state, players, rng) {
  const hashrates = aggregateHashrates(players);
  const algoRates = computeAlgoRates(
    state.windows, hashrates, state.lastWinner, state.consecutiveCount, state.penalty
  );
  const totalRate = algoRates.reduce((sum, entry) => sum + entry.rate, 0);
  if (totalRate <= 0) return null;

  const winningAlgo = sampleWinningAlgo(algoRates, totalRate, rng);
  const simBlockTime = sampleBlockTime(totalRate, rng);
  const winnerEntry = algoRates.find((entry) => entry.algo === winningAlgo);

  if (winningAlgo === state.lastWinner) state.consecutiveCount += 1;
  else state.consecutiveCount = 0;
  state.lastWinner = winningAlgo;

  state.simTimestamp += simBlockTime;
  state.height += 1;
  state.windows[winningAlgo].add(Math.floor(state.simTimestamp), winnerEntry.targetDifficulty);

  const minerId = pickMinerForAlgo(players, winningAlgo, rng);

  return {
    height: state.height,
    algo: winningAlgo,
    algoName: ALGO_NAMES[winningAlgo],
    difficulty: winnerEntry.targetDifficulty.toString(),
    blockTime: simBlockTime,
    timestamp: Math.floor(state.simTimestamp),
    consecutive: state.consecutiveCount,
    penaltyMultiplier: winnerEntry.penaltyMultiplier,
    minerId,
    minerName: minerId ? players.get(minerId)?.name || 'unknown' : null,
    hashrates,
    // Full per-algo state so clients can chart LWMA response, not just the winner.
    telemetry: algoRates.map((entry) => ({
      algo: entry.algo,
      difficulty: entry.targetDifficulty.toString(),
      penaltyMultiplier: entry.penaltyMultiplier,
      share: totalRate > 0 ? entry.rate / totalRate : 0,
    })),
  };
}

function pickMinerForAlgo(players, algoId, rng) {
  const contributors = [];
  let total = 0;
  for (const player of players.values()) {
    const hr = Number(player.hashrates[algoId] || 0);
    if (hr > 0) {
      contributors.push({ id: player.id, hr });
      total += hr;
    }
  }
  if (total <= 0) return null;
  let cursor = rng() * total;
  for (const contributor of contributors) {
    cursor -= contributor.hr;
    if (cursor <= 0) return contributor.id;
  }
  return contributors[contributors.length - 1].id;
}

module.exports = {
  ALGO_IDS,
  ALGO_NAMES,
  ALGO_CONFIG,
  createWindows,
  mulberry32,
  aggregateHashrates,
  mineOneBlock,
};
