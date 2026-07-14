'use strict';

/**
 * Challenge ("level") definitions for community research rounds.
 *
 * Every round draws a random challenge (an attack scenario driven by bots)
 * and a random network variant (status quo vs proposed change). Humans play
 * defense with their hashrate sliders; the round outcome becomes one research
 * datapoint comparing how the two configs hold up under the same stress.
 */

const ALGO_NAMES = ['RandomXM', 'Sha3x', 'RandomXT', 'Cuckaroo'];
const TARGET_BT = 120;

// The two network configs under test. Status quo mirrors mainnet (LWMA-90,
// no TIP-004); the candidate is the proposed change this sim exists to study.
const VARIANTS = [
  {
    id: 'lwma90',
    label: 'STATUS QUO · LWMA-90 · no penalty',
    windowSize: 90,
    penalty: false,
  },
  {
    id: 'lwma45_tip004',
    label: 'PROPOSED · LWMA-45 + TIP-004 penalty',
    windowSize: 45,
    penalty: true,
  },
];

function noiseBot() {
  return {
    name: 'Town Miners',
    kind: 'noise',
    schedule: [{ at: 0, hashrates: { 0: 30, 1: 30, 2: 30, 3: 30 } }],
  };
}

const CHALLENGE_FACTORIES = [
  function hashFlood(rng) {
    const algo = Math.floor(rng() * 4);
    return {
      id: 'flood',
      name: 'HASH FLOOD',
      brief: `A whale is renting a mountain of ${ALGO_NAMES[algo]} hash and will dump it on the chain mid-round. Rebalance your rigs to keep block times on target.`,
      durationBlocks: 80,
      scoredFromBlock: 20,
      objective: {
        type: 'stability',
        threshold: 0.6,
        label: 'Keep 60% of blocks within 0.5x-2x target during the assault',
      },
      bots: [
        noiseBot(),
        {
          name: 'UNKNOWN RIG',
          kind: 'attacker',
          schedule: [
            { at: 0, hashrates: {} },
            { at: 20, hashrates: { [algo]: 600 } },
            { at: 60, hashrates: {} },
          ],
        },
      ],
    };
  },

  function algoHopper(rng) {
    const start = Math.floor(rng() * 4);
    const schedule = [{ at: 0, hashrates: {} }];
    for (let i = 0; i < 6; i++) {
      const algo = (start + i) % 4;
      schedule.push({ at: 15 + i * 10, hashrates: { [algo]: 450 } });
    }
    return {
      id: 'hopper',
      name: 'ALGO HOPPER',
      brief: 'A nomad miner rotates rented hash across all four algorithms, farming each difficulty floor before moving on. Stop any single algo from dominating the chain.',
      durationBlocks: 85,
      scoredFromBlock: 15,
      objective: {
        type: 'dominance',
        maxShare: 0.6,
        label: 'No algorithm may peak above 60% of recent blocks',
      },
      bots: [noiseBot(), { name: 'NOMAD RIG', kind: 'attacker', schedule }],
    };
  },

  function whiplash(rng) {
    const algo = Math.floor(rng() * 4);
    const schedule = [{ at: 0, hashrates: {} }];
    for (let i = 0; i < 5; i++) {
      schedule.push({ at: 15 + i * 14, hashrates: { [algo]: 550 } });
      schedule.push({ at: 22 + i * 14, hashrates: {} });
    }
    return {
      id: 'whiplash',
      name: 'WHIPLASH',
      brief: `A burst miner strikes ${ALGO_NAMES[algo]} in waves — pumping difficulty then vanishing so it crashes. Smooth out the oscillation with your own power.`,
      durationBlocks: 90,
      scoredFromBlock: 15,
      objective: {
        type: 'stability',
        threshold: 0.55,
        label: 'Keep 55% of blocks within 0.5x-2x target through the waves',
      },
      bots: [noiseBot(), { name: 'GHOST RIG', kind: 'attacker', schedule }],
    };
  },

  function goldRush() {
    return {
      id: 'goldrush',
      name: 'GOLD RUSH',
      brief: 'No attacker this round — the chaos is you. Chase blocks as hard as you can; the research question is whether the network absorbs greedy human hash-shuffling.',
      durationBlocks: 70,
      scoredFromBlock: 10,
      objective: {
        type: 'stability',
        threshold: 0.65,
        label: 'Keep 65% of blocks within 0.5x-2x target while you compete',
      },
      bots: [noiseBot()],
    };
  },
];

function drawChallenge(rng) {
  const factory = CHALLENGE_FACTORIES[Math.floor(rng() * CHALLENGE_FACTORIES.length)];
  const challenge = factory(rng);
  challenge.variant = VARIANTS[Math.floor(rng() * VARIANTS.length)];
  return challenge;
}

function publicChallenge(challenge) {
  if (!challenge) return null;
  return {
    id: challenge.id,
    name: challenge.name,
    brief: challenge.brief,
    durationBlocks: challenge.durationBlocks,
    objectiveLabel: challenge.objective.label,
    variantId: challenge.variant.id,
    variantLabel: challenge.variant.label,
  };
}

/**
 * Incremental objective tracker over the scored portion of a round.
 *
 * Single block times are exponential (wildly noisy even on a healthy chain),
 * so stability judges the trailing-15 mean against a 0.7x-1.5x band around
 * target. Dominance judges the max algo share within any trailing-20 window,
 * so algo-hopping can't hide in the whole-round average.
 */
const BT_WINDOW = 15;
const SHARE_WINDOW = 20;

class ObjectiveTracker {
  constructor(challenge) {
    this.challenge = challenge;
    this.scoredBlocks = 0;
    this.stableBlocks = 0;
    this.penaltyEvents = 0;
    this.btSum = 0;
    this.recentBts = [];
    this.recentWinners = [];
    this.worstShare = 0;
    this.currentShare = 0;
  }

  addBlock(block) {
    if (block.penaltyMultiplier > 1) this.penaltyEvents += 1;
    if (block.height < this.challenge.scoredFromBlock) return;
    this.scoredBlocks += 1;
    this.btSum += block.blockTime;

    this.recentBts.push(block.blockTime);
    if (this.recentBts.length > BT_WINDOW) this.recentBts.shift();
    const rollingMean = this.recentBts.reduce((a, b) => a + b, 0) / this.recentBts.length;
    if (rollingMean >= TARGET_BT * 0.7 && rollingMean <= TARGET_BT * 1.5) {
      this.stableBlocks += 1;
    }

    this.recentWinners.push(block.algo);
    if (this.recentWinners.length > SHARE_WINDOW) this.recentWinners.shift();
    if (this.recentWinners.length >= 10) {
      const counts = [0, 0, 0, 0];
      for (const algo of this.recentWinners) counts[algo] += 1;
      this.currentShare = Math.max(...counts) / this.recentWinners.length;
      this.worstShare = Math.max(this.worstShare, this.currentShare);
    }
  }

  stability() {
    return this.scoredBlocks > 0 ? this.stableBlocks / this.scoredBlocks : 1;
  }

  maxShare() {
    return this.worstShare;
  }

  meanBt() {
    return this.scoredBlocks > 0 ? this.btSum / this.scoredBlocks : 0;
  }

  /** Progress snapshot for the HUD: value climbs toward 1 when on track. */
  progress() {
    const obj = this.challenge.objective;
    if (obj.type === 'dominance') {
      return {
        type: obj.type,
        value: this.currentShare,
        target: obj.maxShare,
        ok: this.worstShare <= obj.maxShare,
        label: `TOP ALGO NOW ${Math.round(this.currentShare * 100)}% · PEAK ${Math.round(this.worstShare * 100)}% · LIMIT ${Math.round(obj.maxShare * 100)}%`,
      };
    }
    return {
      type: obj.type,
      value: this.stability(),
      target: obj.threshold,
      ok: this.stability() >= obj.threshold,
      label: `STABILITY ${Math.round(this.stability() * 100)}% · NEED ${Math.round(obj.threshold * 100)}%`,
    };
  }

  evaluate() {
    const obj = this.challenge.objective;
    const success = obj.type === 'dominance'
      ? this.maxShare() <= obj.maxShare
      : this.stability() >= obj.threshold;
    return {
      success,
      stability: Number(this.stability().toFixed(4)),
      maxShare: Number(this.maxShare().toFixed(4)),
      meanBt: Number(this.meanBt().toFixed(1)),
      penaltyEvents: this.penaltyEvents,
      scoredBlocks: this.scoredBlocks,
    };
  }
}

module.exports = { drawChallenge, publicChallenge, ObjectiveTracker, VARIANTS, TARGET_BT };
