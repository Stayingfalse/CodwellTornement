const test = require('node:test');
const assert = require('node:assert/strict');
const bridge = require('../src/codenamesBridge');

const GROUPING = {
  blue: { spymaster: '1', guesser: '2' },
  red: { spymaster: '3', guesser: '4' },
};
// Game 2 swaps roles within each team.
const SWAPPED = {
  blue: { spymaster: '2', guesser: '1' },
  red: { spymaster: '4', guesser: '3' },
};

function seat(id, name = `p${id}`) {
  return { player_id: id, name, discord_user_id: id };
}

function seatsFor(g) {
  return {
    blue: { spymasters: [seat(g.blue.spymaster)], operatives: [seat(g.blue.guesser)] },
    red: { spymasters: [seat(g.red.spymaster)], operatives: [seat(g.red.guesser)] },
  };
}

function payload(overrides = {}) {
  return {
    event: 'codenames.game_finished',
    event_id: 'room:match1',
    channel_id: '600',
    winner: 'blue',
    assassin: false,
    loser_remaining: 3,
    seats: seatsFor(GROUPING),
    ...overrides,
  };
}

test('parseUrlList trims entries and trailing slashes', () => {
  assert.deepEqual(bridge.parseUrlList(' http://bga-bot:8081/ , https://x.example.com//,'), [
    'http://bga-bot:8081',
    'https://x.example.com',
  ]);
  assert.deepEqual(bridge.parseUrlList(undefined), []);
});

test('isAuthorized accepts only the exact bearer token', () => {
  assert.equal(bridge.isAuthorized('Bearer abc', 'abc'), true);
  assert.equal(bridge.isAuthorized('bearer   abc', 'abc'), true);
  assert.equal(bridge.isAuthorized('Bearer abd', 'abc'), false);
  assert.equal(bridge.isAuthorized('abc', 'abc'), false);
  assert.equal(bridge.isAuthorized(undefined, 'abc'), false);
  assert.equal(bridge.isAuthorized('Bearer ', ''), false);
});

test('seats must match the grouping exactly', () => {
  assert.equal(bridge.seatsMatchGrouping(seatsFor(GROUPING), GROUPING), true);
  assert.equal(bridge.seatsMatchGrouping(seatsFor(SWAPPED), GROUPING), false);

  const unlinked = seatsFor(GROUPING);
  unlinked.red.operatives = [{ player_id: '9', name: 'Dave', discord_user_id: null }];
  assert.equal(bridge.seatsMatchGrouping(unlinked, GROUPING), false);

  const extra = seatsFor(GROUPING);
  extra.blue.operatives.push(seat('5'));
  assert.equal(bridge.seatsMatchGrouping(extra, GROUPING), false);
});

test('findGameForSeats picks the game whose line-up the room used', () => {
  const groupingFor = idx => (idx === 1 ? GROUPING : SWAPPED);
  assert.equal(bridge.findGameForSeats(seatsFor(SWAPPED), 2, groupingFor), 2);
  assert.equal(bridge.findGameForSeats(seatsFor(GROUPING), 2, groupingFor), 1);
  assert.equal(bridge.findGameForSeats({}, 2, groupingFor), null);
});

test('validateResultPayload rejects malformed results', () => {
  assert.equal(bridge.validateResultPayload(payload()), null);
  assert.match(bridge.validateResultPayload(null), /object/);
  assert.match(bridge.validateResultPayload(payload({ event: 'other' })), /event/);
  assert.match(bridge.validateResultPayload(payload({ event_id: '' })), /event_id/);
  assert.match(bridge.validateResultPayload(payload({ channel_id: 'abc' })), /channel_id/);
  assert.match(bridge.validateResultPayload(payload({ winner: 'green' })), /winner/);
  assert.match(bridge.validateResultPayload(payload({ seats: null })), /seats/);
});

test('remainingCardsFromPayload uses the loser\'s cards, 0 for assassin, clamped to 0-8', () => {
  assert.equal(bridge.remainingCardsFromPayload(payload()), 3);
  assert.equal(bridge.remainingCardsFromPayload(payload({ assassin: true })), 0);
  assert.equal(bridge.remainingCardsFromPayload(payload({ loser_remaining: 12 })), 8);
  assert.equal(bridge.remainingCardsFromPayload(payload({ loser_remaining: null })), 0);
});

function fakeFetch(script) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, ...options });
    const next = script.shift();
    if (next instanceof Error) throw next;
    return { status: next, json: async () => ({}) };
  };
  return { fetchImpl, calls };
}

const quietLog = { warn() {} };

test('client falls back to the next URL on network errors and 5xx', async () => {
  const { fetchImpl, calls } = fakeFetch([new Error('ECONNREFUSED'), 200]);
  const client = bridge.createBridgeClient({
    token: 't', baseUrls: ['http://bga-bot:8081', 'https://bga.example.com'], fetchImpl, log: quietLog,
  });
  const res = await client.putBinding('600', { guild_id: '1', external_ref: 'R1M1', players: [] });
  assert.equal(res.ok, true);
  assert.equal(res.base, 'https://bga.example.com');
  assert.deepEqual(calls.map(c => c.url), [
    'http://bga-bot:8081/api/bridge/codenames/bindings/600',
    'https://bga.example.com/api/bridge/codenames/bindings/600',
  ]);
  assert.equal(calls[0].headers.Authorization, 'Bearer t');
  assert.equal(calls[0].method, 'PUT');
});

test('client does not fall back on a 4xx', async () => {
  const { fetchImpl, calls } = fakeFetch([401]);
  const client = bridge.createBridgeClient({ token: 't', baseUrls: ['http://a', 'http://b'], fetchImpl, log: quietLog });
  const res = await client.deleteBinding('600');
  assert.equal(res.ok, false);
  assert.equal(res.status, 401);
  assert.equal(calls.length, 1);
});

test('reconcile binds new threads, skips unchanged ones and unbinds finished ones', async () => {
  const { fetchImpl, calls } = fakeFetch([200, 200]);
  const client = bridge.createBridgeClient({ token: 't', baseUrls: ['http://a'], fetchImpl, log: quietLog });
  const unchanged = { guild_id: '1', external_ref: 'R1M1', players: ['1'] };
  const synced = { '600': JSON.stringify(unchanged), '700': 'old' };
  const desired = new Map([
    ['600', unchanged],
    ['800', { guild_id: '1', external_ref: 'R1M2', players: ['2'] }],
  ]);

  assert.equal(await client.reconcile(desired, synced), true);
  assert.deepEqual(calls.map(c => `${c.method} ${c.url}`), [
    'PUT http://a/api/bridge/codenames/bindings/800',
    'DELETE http://a/api/bridge/codenames/bindings/700',
  ]);
  assert.deepEqual(Object.keys(synced).sort(), ['600', '800']);
});

test('reconcile keeps failed bindings unsynced so they are retried', async () => {
  const { fetchImpl } = fakeFetch([new Error('down')]);
  const client = bridge.createBridgeClient({ token: 't', baseUrls: ['http://a'], fetchImpl, log: quietLog });
  const synced = {};
  const changed = await client.reconcile(new Map([['600', { guild_id: '1', external_ref: 'R1M1', players: [] }]]), synced);
  assert.equal(changed, false);
  assert.deepEqual(synced, {});
});

test('reconcile is a no-op when the bridge is not configured', async () => {
  const client = bridge.createBridgeClient({ token: '', baseUrls: ['http://a'], fetchImpl: () => { throw new Error('called'); } });
  assert.equal(client.enabled, false);
  assert.equal(await client.reconcile(new Map([['600', {}]]), {}), false);
});
