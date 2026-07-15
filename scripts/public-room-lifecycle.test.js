'use strict';

process.env.PUBLIC_LOBBY_COUNTDOWN_MS = '25';
process.env.PUBLIC_INTERMISSION_MS = '25';
process.env.PUBLIC_EMPTY_GRACE_MS = '35';
process.env.PUBLIC_SESSION_RETURN_MS = '35';
process.env.RESEARCH_DATA_DIR = `/tmp/tari-public-session-tests-${process.pid}`;

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  Room,
  RoomManager,
  PUBLIC_LOBBY_COUNTDOWN_MS,
  PUBLIC_INTERMISSION_MS,
  PUBLIC_EMPTY_GRACE_MS,
  PUBLIC_SESSION_RETURN_MS,
  PUBLIC_SESSION_LENGTH,
} = require('../server/room');

const RESEARCH_FILE = path.join(process.env.RESEARCH_DATA_DIR, 'rounds.jsonl');
fs.rmSync(process.env.RESEARCH_DATA_DIR, { recursive: true, force: true });
test.after(() => fs.rmSync(process.env.RESEARCH_DATA_DIR, { recursive: true, force: true }));

function socket() {
  return {
    readyState: 1,
    messages: [],
    send(payload) {
      this.messages.push(JSON.parse(payload));
    },
    close() {
      this.readyState = 3;
    },
  };
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

test('public countdown starts once and survives host reassignment', async (t) => {
  const room = new Room('ABCDE', 'host');
  t.after(() => room.destroy());
  const hostSocket = socket();
  const peerSocket = socket();

  room.addClient('host', hostSocket, 'Host');
  const deadline = room.lifecycleDeadline;
  room.addClient('peer', peerSocket, 'Peer');
  assert.equal(room.lifecycleKind, 'lobby');
  assert.equal(room.lifecycleDeadline, deadline);
  assert.equal(room.connectedHumanCount(), 2);

  room.removeClient('host');
  assert.equal(room.hostId, 'peer');
  assert.equal(room.lifecycleDeadline, deadline);
  await delay(PUBLIC_LOBBY_COUNTDOWN_MS + 20);

  assert.equal(room.running, true);
  assert.ok(room.challenge);
  assert.equal(room.lifecycleTimer, null);
  assert.ok(room.blockTimer);
});

test('start-now and countdown race remain idempotent', async (t) => {
  const room = new Room('START', 'host');
  t.after(() => room.destroy());
  room.addClient('host', socket(), 'Host');

  await delay(PUBLIC_LOBBY_COUNTDOWN_MS - 5);
  const first = room.start('host');
  const challenge = room.challenge;
  const blockTimer = room.blockTimer;
  await delay(15);
  const duplicate = room.start('host');

  assert.equal(first.ok, true);
  assert.equal(duplicate.ok, true);
  assert.equal(room.challenge, challenge);
  assert.equal(room.blockTimer, blockTimer);
  assert.equal([...room.players.keys()].filter((id) => id.startsWith('bot:')).length, room.challenge.bots.length);
});

test('public intermission advances without a host click', async (t) => {
  const room = new Room('ROUND', 'host');
  t.after(() => room.destroy());
  room.addClient('host', socket(), 'Host');
  room.start('host');
  room._clearBlockTimer();
  const completedChallenge = room.challenge;
  room.running = false;
  room.roundOver = true;
  room._beginLifecycleCountdown('intermission', PUBLIC_INTERMISSION_MS);

  assert.equal(room.lifecycleKind, 'intermission');
  await delay(PUBLIC_INTERMISSION_MS + 20);

  assert.equal(room.running, true);
  assert.equal(room.roundOver, false);
  assert.notEqual(room.challenge, completedChallenge);
  assert.ok(room.blockTimer);
});

test('live reinforcement joins without resetting shared progress', () => {
  const room = new Room('REINF', 'host');
  room.addClient('host', socket(), 'Host');
  room.start('host');
  room._clearBlockTimer();
  room.height = 10;
  const challenge = room.challenge;
  const objective = room.objective;

  room.addClient('late', socket(), 'Late Pilot');
  const late = room.players.get('late');
  assert.equal(late.score, 0);
  assert.equal(late.blocksMined, 0);
  assert.equal(room.height, 10);
  assert.equal(room.challenge, challenge);
  assert.equal(room.objective, objective);
  assert.equal(room.running, true);

  const totalsBefore = room.snapshot('late').totals;
  room.setHashrates('late', { 0: 30, 1: 40, 2: 50, 3: 60 });
  const state = room.snapshot('late');
  assert.deepEqual(state.totals, {
    0: totalsBefore[0] + 30,
    1: totalsBefore[1] - 100 + 40,
    2: totalsBefore[2] + 50,
    3: totalsBefore[3] + 60,
  });
  assert.equal(state.challenge.durationBlocks - state.height, state.challenge.durationBlocks - 10);
  room.destroy();
});

test('empty public room pauses, safely rejoins, then expires', async () => {
  const manager = new RoomManager();
  const room = manager.create();
  room.hostId = 'host';
  room.addClient('host', socket(), 'Host');
  const code = room.code;

  room.removeClient('host');
  assert.equal(room.blockTimer, null);
  assert.equal(room.lifecycleTimer, null);
  assert.ok(room.emptyRoomTimer);
  assert.equal(manager.publicListings(32).length, 0);

  await delay(10);
  room.addClient('host', socket(), 'Host');
  assert.equal(room.emptyRoomTimer, null);
  assert.equal(room.lifecycleKind, 'lobby');
  assert.equal(room.running, false);

  room.removeClient('host');
  await delay(PUBLIC_EMPTY_GRACE_MS + 20);
  assert.equal(manager.get(code), null);
  manager.shutdown();
});

test('private toggle preserves hosted controls and public multi-human grief controls reject', () => {
  const room = new Room('QUIET', 'host');
  const hostSocket = socket();
  room.addClient('host', hostSocket, 'Host');
  room.addClient('guest', socket(), 'Guest');
  assert.match(room.stop('host').error, /exactly one connected human/i);
  assert.match(room.reset('host').error, /exactly one connected human/i);
  room.removeClient('guest');

  const toggled = room.setSettings('host', { listed: false });
  assert.equal(toggled.ok, true);
  assert.equal(room.lifecycleState().lifecycleMode, 'hosted');
  assert.equal(room.lifecycleTimer, null);
  assert.equal(room.setSettings('host', { variantMode: 'lwma90' }).ok, true);

  room.addClient('guest', socket(), 'Guest');
  assert.equal(room.connectedHumanCount(), 2);
  assert.equal(room.start('host').ok, true);
  assert.equal(room.stop('host').ok, true);
  room.destroy();
});

test('solo public controls pause, resume, and abandon without recording', () => {
  const room = new Room('SOLOX', 'pilot');
  const before = fs.existsSync(RESEARCH_FILE)
    ? fs.readFileSync(RESEARCH_FILE, 'utf8').split('\n').filter(Boolean).length
    : 0;
  room.addClient('pilot', socket(), 'Solo Pilot');
  assert.equal(room.snapshot('pilot').canSoloControl, true);
  assert.equal(room.start('pilot').ok, true);
  room._clearBlockTimer();
  assert.equal(room.stop('pilot').ok, true);
  assert.equal(room.running, false);

  room.addClient('peer', socket(), 'Peer');
  assert.equal(room.running, true);
  assert.ok(room.blockTimer);
  assert.equal(room.snapshot('pilot').canSoloControl, false);
  assert.match(room.stop('pilot').error, /exactly one connected human/i);
  room.removeClient('peer');
  assert.equal(room.snapshot('pilot').canSoloControl, true);

  room._clearBlockTimer();
  room.running = true;
  assert.equal(room.stop('pilot').ok, true);
  assert.equal(room.start('pilot').ok, true);
  room._clearBlockTimer();
  room.awardBlock({ minerId: 'pilot' });
  assert.equal(room.players.get('pilot').sessionBlocksMined, 1);
  assert.equal(room.reset('pilot').ok, true);
  assert.equal(room.sessionRound, 1);
  assert.equal(room.sessionResults.length, 0);
  assert.equal(room.challenge, null);
  assert.equal(room.lifecycleKind, 'lobby');
  assert.equal(room.players.get('pilot').sessionScore, 0);
  assert.equal(room.players.get('pilot').sessionBlocksMined, 0);
  const after = fs.existsSync(RESEARCH_FILE)
    ? fs.readFileSync(RESEARCH_FILE, 'utf8').split('\n').filter(Boolean).length
    : 0;
  assert.equal(after, before);
  room.destroy();
});

test('four clients finish exactly five synchronized public challenges and return to lobby', async () => {
  const manager = new RoomManager();
  const room = manager.create();
  const clients = ['one', 'two', 'three', 'four'].map((id) => [id, socket()]);
  room.hostId = 'one';
  clients.forEach(([id, ws]) => room.addClient(id, ws, `Pilot ${id}`));
  const recordsBefore = fs.existsSync(RESEARCH_FILE)
    ? fs.readFileSync(RESEARCH_FILE, 'utf8').split('\n').filter(Boolean).length
    : 0;

  await delay(PUBLIC_LOBBY_COUNTDOWN_MS + 20);
  for (let round = 1; round <= PUBLIC_SESSION_LENGTH; round += 1) {
    assert.equal(room.running, true);
    assert.equal(room.sessionRound, round);
    clients.forEach(([id]) => {
      const state = room.snapshot(id);
      assert.equal(state.sessionRound, round);
      assert.equal(state.sessionLength, PUBLIC_SESSION_LENGTH);
      assert.equal(state.sessionResults.length, round - 1);
    });
    room._clearBlockTimer();
    room.awardBlock({ minerId: clients[(round - 1) % clients.length][0] });
    room.finishChallenge();
    if (round < PUBLIC_SESSION_LENGTH) {
      assert.equal(room.lifecycleKind, 'intermission');
      await delay(PUBLIC_INTERMISSION_MS + 20);
    }
  }

  assert.equal(room.sessionComplete, true);
  assert.equal(room.sessionResults.length, PUBLIC_SESSION_LENGTH);
  assert.equal(room.lifecycleKind, 'session_end');
  assert.equal(room.blockTimer, null);
  const summaries = clients.map(([, ws]) => ws.messages.findLast((message) => message.type === 'session_complete')?.summary);
  summaries.forEach((summary) => assert.deepEqual(summary, room.sessionSummary));
  assert.equal(room.sessionSummary.results.length, PUBLIC_SESSION_LENGTH);
  assert.equal(room.sessionSummary.contributions.length, clients.length);
  assert.equal(
    room.sessionSummary.classifications.official + room.sessionSummary.classifications.exploratory,
    PUBLIC_SESSION_LENGTH
  );
  const recordsAfter = fs.readFileSync(RESEARCH_FILE, 'utf8').split('\n').filter(Boolean);
  assert.equal(recordsAfter.length - recordsBefore, PUBLIC_SESSION_LENGTH);
  assert.deepEqual(
    recordsAfter.slice(-PUBLIC_SESSION_LENGTH).map((line) => JSON.parse(line).sessionRound),
    [1, 2, 3, 4, 5]
  );

  const code = room.code;
  await delay(PUBLIC_SESSION_RETURN_MS + 20);
  assert.equal(manager.get(code), null);
  clients.forEach(([, ws]) => {
    assert.equal(ws.messages.some((message) => message.type === 'session_ended'), true);
    assert.equal(ws.readyState, 3);
  });
  const finalRecords = fs.readFileSync(RESEARCH_FILE, 'utf8').split('\n').filter(Boolean);
  assert.equal(finalRecords.length, recordsAfter.length);
  manager.shutdown();
});

test('host departure does not stop automation and round-three live joins start at zero', async (t) => {
  const room = new Room('LIVR3', 'host');
  t.after(() => room.destroy());
  room.addClient('host', socket(), 'Host');
  room.addClient('peer', socket(), 'Peer');
  await delay(PUBLIC_LOBBY_COUNTDOWN_MS + 20);
  room.removeClient('host');
  assert.equal(room.running, true);

  for (let round = 1; round <= 2; round += 1) {
    room._clearBlockTimer();
    room.finishChallenge();
    await delay(PUBLIC_INTERMISSION_MS + 20);
  }
  assert.equal(room.sessionRound, 3);
  room.height = 7;
  room.addClient('late', socket(), 'Late Pilot');
  const lateState = room.snapshot('late');
  const late = lateState.players.find((player) => player.id === 'late');
  assert.equal(lateState.sessionRound, 3);
  assert.equal(late.score, 0);
  assert.equal(late.blocksMined, 0);
  assert.equal(late.sessionScore, 0);
  assert.equal(late.sessionBlocksMined, 0);
  assert.equal(room.height, 7);
});

test('public listing exposes safe lifecycle metadata', () => {
  const room = new Room('SAFER', 'host');
  room.addClient('host', socket(), 'Secret Name');
  const listing = room.publicListing(32);

  assert.equal(listing.lifecycleMode, 'auto');
  assert.equal(listing.countdownKind, 'lobby');
  assert.equal(typeof listing.countdownDeadline, 'number');
  assert.equal(listing.connectedHumans, 1);
  assert.equal(listing.sessionRound, 1);
  assert.equal(listing.sessionLength, PUBLIC_SESSION_LENGTH);
  assert.equal('players' in listing, false);
  assert.equal('hostId' in listing, false);
  assert.equal('listed' in listing, false);
  room.destroy();
});
