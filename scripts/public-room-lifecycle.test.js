'use strict';

process.env.PUBLIC_LOBBY_COUNTDOWN_MS = '25';
process.env.PUBLIC_INTERMISSION_MS = '25';
process.env.PUBLIC_EMPTY_GRACE_MS = '35';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  Room,
  RoomManager,
  PUBLIC_LOBBY_COUNTDOWN_MS,
  PUBLIC_INTERMISSION_MS,
  PUBLIC_EMPTY_GRACE_MS,
} = require('../server/room');

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

test('private toggle restores hosted controls and public grief controls reject', () => {
  const room = new Room('QUIET', 'host');
  const hostSocket = socket();
  room.addClient('host', hostSocket, 'Host');
  assert.match(room.stop('host').error, /cannot be paused/i);
  assert.match(room.reset('host').error, /cannot be abandoned/i);

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

test('public listing exposes safe lifecycle metadata', () => {
  const room = new Room('SAFER', 'host');
  room.addClient('host', socket(), 'Secret Name');
  const listing = room.publicListing(32);

  assert.equal(listing.lifecycleMode, 'auto');
  assert.equal(listing.countdownKind, 'lobby');
  assert.equal(typeof listing.countdownDeadline, 'number');
  assert.equal(listing.connectedHumans, 1);
  assert.equal('players' in listing, false);
  assert.equal('hostId' in listing, false);
  assert.equal('listed' in listing, false);
  room.destroy();
});
