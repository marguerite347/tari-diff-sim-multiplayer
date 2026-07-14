'use strict';

/**
 * Round result storage: every finished challenge round appends one JSONL
 * datapoint, and the aggregate view compares variants per challenge.
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DATA_FILE = path.join(DATA_DIR, 'rounds.jsonl');

function recordRound(entry) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.appendFileSync(DATA_FILE, JSON.stringify(entry) + '\n');
  } catch (err) {
    console.error('Failed to record round:', err.message);
  }
}

function loadRounds() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    return raw
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function aggregate() {
  const rounds = loadRounds();
  const groups = new Map();
  for (const round of rounds) {
    const key = `${round.challenge}::${round.variant}`;
    if (!groups.has(key)) {
      groups.set(key, {
        challenge: round.challenge,
        challengeName: round.challengeName,
        variant: round.variant,
        variantLabel: round.variantLabel,
        rounds: 0,
        wins: 0,
        stabilitySum: 0,
        meanBtSum: 0,
        penaltySum: 0,
      });
    }
    const g = groups.get(key);
    g.rounds += 1;
    if (round.success) g.wins += 1;
    g.stabilitySum += round.stability || 0;
    g.meanBtSum += round.meanBt || 0;
    g.penaltySum += round.penaltyEvents || 0;
  }

  return [...groups.values()].map((g) => ({
    challenge: g.challenge,
    challengeName: g.challengeName,
    variant: g.variant,
    variantLabel: g.variantLabel,
    rounds: g.rounds,
    winRate: g.rounds ? Number((g.wins / g.rounds).toFixed(3)) : 0,
    avgStability: g.rounds ? Number((g.stabilitySum / g.rounds).toFixed(3)) : 0,
    avgMeanBt: g.rounds ? Number((g.meanBtSum / g.rounds).toFixed(1)) : 0,
    avgPenaltyEvents: g.rounds ? Number((g.penaltySum / g.rounds).toFixed(1)) : 0,
  }));
}

module.exports = { recordRound, aggregate };
