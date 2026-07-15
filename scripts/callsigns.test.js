'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Callsigns = require('../js/callsigns');
const { RoomManager, generateCallsign } = require('../server/room');

const GENERATED_PATTERN = /^MINER-[A-Z]+-[A-Z]+-\d{3}$/;
const OPEN_SOCKET = { readyState: 1, send() {} };

test('every curated callsign combination fits the server limit', () => {
  for (const adjective of Callsigns.ADJECTIVES) {
    for (const role of Callsigns.ROLES) {
      const callsign = Callsigns.format(adjective, role, 999);
      assert.match(callsign, GENERATED_PATTERN);
      assert.ok([...callsign].length <= Callsigns.MAX_LENGTH, callsign);
    }
  }
});

test('four deterministic generator contexts produce distinct valid names', () => {
  const contexts = [
    [0, 0, 1],
    [1, 1, 37],
    [2, 2, 482],
    [3, 3, 999],
  ];
  const names = contexts.map((values) => {
    let index = 0;
    return Callsigns.generate(() => values[index++]);
  });
  assert.equal(new Set(names).size, names.length);
  for (const name of names) {
    assert.match(name, GENERATED_PATTERN);
    assert.ok([...name].length <= 24);
  }
  assert.match(generateCallsign(), GENERATED_PATTERN);
});

test('room collisions are case-insensitive and readable', () => {
  const manager = new RoomManager();
  const room = manager.create();
  room.hostId = 'one';
  room.addClient('one', OPEN_SOCKET, 'Solar Guard');
  room.addClient('two', OPEN_SOCKET, 'solar guard');
  assert.equal(room.players.get('one').name, 'Solar Guard');
  assert.equal(room.players.get('two').name, 'solar guard-2');
  assert.ok([...room.players.get('two').name].length <= 24);
  manager.shutdown();
});

test('public listings respect privacy and contain safe metadata only', () => {
  const manager = new RoomManager();
  const room = manager.create();
  room.hostId = 'host';
  room.addClient('host', OPEN_SOCKET, 'PRIVATE PILOT');

  let listings = manager.publicListings(32);
  assert.equal(listings.length, 1);
  assert.deepEqual(Object.keys(listings[0]).sort(), [
    'capacity', 'challenge', 'code', 'connectedHumans', 'countdownDeadline',
    'countdownKind', 'createdAt', 'height', 'humans', 'joinable', 'lastActiveAt',
    'lifecycleMode', 'progress', 'remainingMs', 'state', 'variant',
  ]);
  assert.equal(JSON.stringify(listings).includes('PRIVATE PILOT'), false);
  assert.equal(room.publicListing(1).joinable, false);
  assert.equal(room.setSettings('guest', { listed: false }).ok, false);
  assert.equal(room.listed, true);
  assert.equal(room.setSettings('host', { listed: false }).ok, true);
  assert.equal(manager.publicListings(32).length, 0);
  assert.equal(room.setSettings('host', { listed: true }).ok, true);
  listings = manager.publicListings(32);
  assert.equal(listings[0].state, 'waiting');
  assert.equal(listings[0].humans, 1);
  manager.shutdown();
});
