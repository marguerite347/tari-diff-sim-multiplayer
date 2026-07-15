'use strict';

/**
 * Round result storage: every finished challenge round appends one JSONL
 * datapoint, and the aggregate view compares variants per challenge.
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.RESEARCH_DATA_DIR
  ? path.resolve(process.env.RESEARCH_DATA_DIR)
  : path.join(__dirname, '..', 'data');
const DATA_FILE = path.join(DATA_DIR, 'rounds.jsonl');
const ARCHIVE_DIR = path.join(DATA_DIR, 'archive');

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

function aggregate(assignmentMode = 'randomized') {
  const rounds = loadRounds();
  const groups = new Map();
  for (const round of rounds) {
    const roundMode = round.assignmentMode === 'manual' ? 'manual' : 'randomized';
    if (roundMode !== assignmentMode) continue;
    const simulationVersion = round.simulationVersion || 'legacy';
    const key = `${simulationVersion}::${round.challenge}::${round.variant}`;
    if (!groups.has(key)) {
      groups.set(key, {
        simulationVersion,
        challenge: round.challenge,
        challengeName: round.challengeName,
        variant: round.variant,
        variantLabel: round.variantLabel,
        assignmentMode: roundMode,
        rounds: 0,
        wins: 0,
        stabilitySum: 0,
        meanBtSum: 0,
        penaltySum: 0,
        orphanSum: 0,
        reorgDepthSum: 0,
        worstGapSum: 0,
        diffSwingSum: 0,
        worstGapCount: 0,
        diffSwingCount: 0,
      });
    }
    const g = groups.get(key);
    g.rounds += 1;
    if (round.success) g.wins += 1;
    g.stabilitySum += round.stability || 0;
    g.meanBtSum += round.meanBt || 0;
    g.penaltySum += round.penaltyEvents || 0;
    g.orphanSum += round.orphans || 0;
    g.reorgDepthSum += round.deepestReorg || 0;
    // Optional metrics average only rows that actually recorded them.
    if (Number.isFinite(Number(round.worstGap))) {
      g.worstGapSum += Number(round.worstGap);
      g.worstGapCount += 1;
    }
    if (Number.isFinite(Number(round.diffSwing))) {
      g.diffSwingSum += Number(round.diffSwing);
      g.diffSwingCount += 1;
    }
  }

  return [...groups.values()].map((g) => ({
    simulationVersion: g.simulationVersion,
    challenge: g.challenge,
    challengeName: g.challengeName,
    variant: g.variant,
    variantLabel: g.variantLabel,
    assignmentMode: g.assignmentMode,
    rounds: g.rounds,
    winRate: g.rounds ? Number((g.wins / g.rounds).toFixed(3)) : 0,
    avgStability: g.rounds ? Number((g.stabilitySum / g.rounds).toFixed(3)) : 0,
    avgMeanBt: g.rounds ? Number((g.meanBtSum / g.rounds).toFixed(1)) : 0,
    avgPenaltyEvents: g.rounds ? Number((g.penaltySum / g.rounds).toFixed(1)) : 0,
    avgOrphans: g.rounds ? Number((g.orphanSum / g.rounds).toFixed(1)) : 0,
    avgDeepestReorg: g.rounds ? Number((g.reorgDepthSum / g.rounds).toFixed(1)) : 0,
    avgWorstGap: g.worstGapCount ? Number((g.worstGapSum / g.worstGapCount).toFixed(0)) : null,
    avgDiffSwing: g.diffSwingCount ? Number((g.diffSwingSum / g.diffSwingCount).toFixed(1)) : null,
  }));
}

function archiveAndReset(dataFile = DATA_FILE, archiveDir = ARCHIVE_DIR) {
  if (!fs.existsSync(dataFile)) return { reset: true, archived: false, archive: null };

  const raw = fs.readFileSync(dataFile, 'utf8');
  let archivePath = null;
  if (raw.length > 0) {
    fs.mkdirSync(archiveDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    archivePath = path.join(archiveDir, `rounds-${stamp}.jsonl`);
    fs.copyFileSync(dataFile, archivePath, fs.constants.COPYFILE_EXCL);
  }

  fs.mkdirSync(path.dirname(dataFile), { recursive: true });
  const tempFile = `${dataFile}.reset-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tempFile, '');
  fs.renameSync(tempFile, dataFile);
  return {
    reset: true,
    archived: !!archivePath,
    archive: archivePath ? path.relative(path.join(__dirname, '..'), archivePath) : null,
  };
}

module.exports = { recordRound, aggregate, archiveAndReset };
