'use strict';

/**
 * Server-side LWMA + mining race engine for multiplayer rooms.
 * Ported from the original client-side lwma.js / simulation.js logic.
 */

const fs = require('fs');
const path = require('path');

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

  seedFlat(difficulty, targetTime, count, endTimestamp = null) {
    const diff = BigInt(difficulty);
    const step = BigInt(targetTime);
    // End the synthetic history at the sim clock so the first live block
    // doesn't register as one giant (clamped) solve time.
    let ts = endTimestamp !== null
      ? BigInt(endTimestamp) - step * BigInt(count - 1)
      : 1_000_000n;
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

/**
 * Real Tari mainnet history (js/data.js: 2,122 blocks, heights 294400-296521),
 * reduced to per-algo solve-time and difficulty sequences. Round starts seed
 * each LWMA window from a contiguous run of this data — normalized to the
 * game's difficulty scale — so the opening window has authentic texture
 * (real solve-time spacing and difficulty wobble) instead of flat history.
 */
const MAINNET_SEED = (() => {
  try {
    let raw = fs.readFileSync(path.join(__dirname, '..', 'js', 'data.js'), 'utf8');
    raw = raw.slice(raw.indexOf('=') + 1).trim().replace(/;\s*$/, '');
    const data = JSON.parse(raw);
    const perAlgo = {};
    for (const algoId of [0, 1, 2, 3]) {
      const blocks = data.blocks.filter((b) => b.pow_algo === algoId);
      perAlgo[algoId] = {
        // deltas[i] = solve-time between that algo's block i and i+1.
        deltas: blocks.slice(1).map((b, i) => Math.max(1, b.timestamp - blocks[i].timestamp)),
        diffs: blocks.map((b) => Number(b.difficulty)),
      };
    }
    return perAlgo;
  } catch {
    return null; // fall back to flat seeding
  }
})();

/** LWMA over plain-number samples [{t, d}] — mirror of LwmaWindow.calculate(). */
function lwmaNumeric(samples, targetTime, maxBlockTime) {
  const n = samples.length - 1;
  let diffSum = 0;
  for (let i = 1; i <= n; i++) diffSum += samples[i].d;
  let weightedTimes = 0;
  let prev = samples[0].t;
  for (let i = 1; i <= n; i++) {
    let t = samples[i].t;
    if (t <= prev) t = prev + 1;
    let solve = t - prev;
    if (solve > maxBlockTime) solve = maxBlockTime;
    prev = t;
    weightedTimes += solve * i;
  }
  if (weightedTimes === 0) weightedTimes = 1;
  return ((diffSum / n) * ((n * (n + 1) * targetTime) / 2)) / weightedTimes;
}

/**
 * Fill a window with `count` samples whose spacing and relative difficulty
 * follow a random contiguous run of real mainnet blocks of this algo,
 * anchored so the round still opens in equilibrium (mean block time near
 * target). Anchoring only the window's *first* LWMA output is not enough:
 * as textured samples roll out over the next `count` blocks, the convexity
 * of difficulty = k / weightedTime makes the average output drift above the
 * anchor, running the chain measurably slow. So instead we simulate a
 * mean-field roll-out (each live block arrives at the pace its difficulty
 * implies) and rescale the seeds until the roll-out's MEAN output sits at
 * the equilibrium difficulty — headless validation across seeds shows this
 * matches flat seeding's block-time behavior while keeping the real texture.
 */
function seedTextured(window, algoId, equilibriumDiff, targetTime, count, endTimestamp, rng) {
  const real = MAINNET_SEED?.[algoId];
  if (!real || real.diffs.length < count) return false;

  const start = Math.floor(rng() * (real.diffs.length - count));
  const deltas = real.deltas.slice(start, start + count - 1);
  const diffs = real.diffs.slice(start, start + count);
  const T = Number(targetTime);
  const maxBlockTime = Number(LWMA_MAX_BLOCK_TIME_RATIO) * T;

  // Normalize spacing so the run's mean solve time equals the game target
  // (outlier gaps pre-clamped at 6x the run's own mean so they don't skew it).
  const rawMean = deltas.reduce((a, b) => a + b, 0) / deltas.length;
  const clamped = deltas.map((d) => Math.min(d, 6 * rawMean));
  const meanDelta = clamped.reduce((a, b) => a + b, 0) / clamped.length;
  const scaled = clamped.map((d) => Math.max(1, Math.round((d * T) / meanDelta)));

  // Relative difficulty texture around the equilibrium anchor.
  const meanDiff = diffs.reduce((a, b) => a + b, 0) / diffs.length;
  const anchor = Number(equilibriumDiff);
  if (!(anchor > 0) || !(meanDiff > 0)) return false;
  const seeds = [{ t: 0, d: anchor * (diffs[0] / meanDiff) }];
  for (let i = 0; i < scaled.length; i++) {
    seeds.push({ t: seeds[i].t + scaled[i], d: anchor * (diffs[i + 1] / meanDiff) });
  }

  // Mean-field roll-out rescale (roll-out is ~linear in seed difficulties,
  // so a few passes converge).
  const rollout = (initial) => {
    const s = initial.map((x) => ({ ...x }));
    const outs = [];
    for (let step = 0; step < count - 1; step++) {
      const out = lwmaNumeric(s, T, maxBlockTime);
      outs.push(out);
      s.push({ t: s[s.length - 1].t + Math.max(1, T * (out / anchor)), d: out });
      s.shift();
    }
    return outs.reduce((a, b) => a + b, 0) / outs.length;
  };
  for (let pass = 0; pass < 3; pass++) {
    const meanOut = rollout(seeds);
    if (!(meanOut > 0)) return false;
    const ratio = anchor / meanOut;
    for (const s of seeds) s.d *= ratio;
  }

  window.samples = [];
  let ts = BigInt(endTimestamp) - BigInt(scaled.reduce((a, b) => a + b, 0));
  for (let i = 0; i < seeds.length; i++) {
    window.add(ts, BigInt(Math.max(1, Math.round(seeds[i].d))));
    if (i < scaled.length) ts += BigInt(scaled[i]);
  }
  return true;
}

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

/**
 * Re-seed each algo window at the difficulty that puts the CURRENT power
 * distribution in equilibrium (expected 120s overall blocks), so challenge
 * rounds measure the response to the attack, not to a mismatched baseline.
 */
function seedWindowsForPower(windows, totals, endTimestamp, rng = Math.random) {
  for (const algoId of ALGO_IDS) {
    const cfg = ALGO_CONFIG[algoId];
    const power = Math.max(0, Math.round(Number(totals[algoId] || 0)));
    const seedDiff = cfg.minDifficulty * SEED_DIFFICULTY_FACTOR;
    let diff = (seedDiff * BigInt(power)) / 100n;
    if (diff < cfg.minDifficulty) diff = cfg.minDifficulty;
    const count = windows[algoId].blockWindow + 1;
    // Prefer real-mainnet texture; flat synthetic history is the fallback.
    if (!seedTextured(windows[algoId], algoId, diff, cfg.targetTime, count, endTimestamp, rng)) {
      windows[algoId].samples = [];
      windows[algoId].seedFlat(diff, cfg.targetTime, count, endTimestamp);
    }
  }
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
  for (const algoId of ALGO_IDS) {
    const cfg = ALGO_CONFIG[algoId];
    const penaltyMultiplier = applyPenalty(
      windows[algoId], algoId, lastWinner, consecutiveCount, penaltyEnabled
    );
    let targetDifficulty = windows[algoId].calculate();
    if (targetDifficulty === null) targetDifficulty = cfg.minDifficulty;

    const power = Number(hashrates[algoId] || 0);
    const hashrate = powerToHashrate(algoId, power);
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

/**
 * Block propagation window (sim-seconds). If a rival algo's next solve lands
 * inside this window after the winner, the network briefly sees two tips and
 * the loser becomes a depth-1 orphan. Solve times are memoryless, so
 * P(orphan) = 1 - exp(-rivalRateSum * ORPHAN_WINDOW); at target cadence
 * (total rate 1/120s, rivals ~3/4 of it) that's roughly a 5% orphan rate.
 * Env override is a debug hook (ORPHAN_WINDOW=60 makes orphans frequent).
 */
const ORPHAN_WINDOW = Number(process.env.ORPHAN_WINDOW || 8);

function maybeOrphan(algoRates, winningAlgo, players, rng) {
  const rivals = algoRates.filter((entry) => entry.algo !== winningAlgo && entry.rate > 0);
  const rivalRate = rivals.reduce((sum, entry) => sum + entry.rate, 0);
  if (rivalRate <= 0) return null;
  if (rng() >= 1 - Math.exp(-rivalRate * ORPHAN_WINDOW)) return null;

  // Which rival "almost won": proportional to its solve rate.
  let cursor = rng() * rivalRate;
  let rival = rivals[rivals.length - 1];
  for (const entry of rivals) {
    cursor -= entry.rate;
    if (cursor <= 0) { rival = entry; break; }
  }
  const minerId = pickMinerForAlgo(players, rival.algo, rng);
  return {
    algo: rival.algo,
    algoName: ALGO_NAMES[rival.algo],
    difficulty: rival.targetDifficulty.toString(),
    deltaTime: Math.max(1, Math.round(rng() * ORPHAN_WINDOW)),
    minerId,
    minerName: minerId ? players.get(minerId)?.name || 'unknown' : null,
  };
}

/** Abstract "power" -> hashrate anchored at the seeded difficulty (see computeAlgoRates). */
function powerToHashrate(algoId, power) {
  const cfg = ALGO_CONFIG[algoId];
  const seedDifficulty = Number(cfg.minDifficulty * SEED_DIFFICULTY_FACTOR);
  return (Number(power) / 100) * (seedDifficulty / Number(cfg.targetTime));
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
  const orphan = maybeOrphan(algoRates, winningAlgo, players, rng);

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
    // A rival algo solved within the propagation window: depth-1 orphan.
    orphan,
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
  seedWindowsForPower,
  mulberry32,
  aggregateHashrates,
  mineOneBlock,
  powerToHashrate,
  ORPHAN_WINDOW,
};
