import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {runEventRoute} from '../src/run-event-routes.mjs';

const tenant = '00000000-0000-4000-8000-000000000001';
const run = '00000000-0000-4000-8000-000000000002';
const identity = '00000000-0000-4000-8000-000000000003';

async function serve(t, options) {
  const server = createServer((req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname;
    if (!runEventRoute(req, res, path, options)) {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => {
    server.close(resolve);
    server.closeAllConnections();
  }));
  return `http://127.0.0.1:${server.address().port}`;
}

const headers = origin => ({'x-sie-product': 'command', 'x-tenant-id': tenant, origin, cookie: 'sie=ok'});

test('replays tenant-authorized events after a durable cursor', async t => {
  let input;
  const options = {
    auth: {session: async () => ({identityId: identity})},
    service: {events: async value => {
      input = value;
      return [{id: 42, type: 'job.succeeded', payload: {nodeId: 'collect'}, createdAt: '2026-10-13T08:00:00.000Z'}];
    }},
    authorizedOrigins: []
  };
  const base = await serve(t, options);
  const origin = new URL(base).origin;
  options.authorizedOrigins.push(origin);
  const response = await fetch(`${base}/v1/runs/${run}/events`, {headers: {...headers(origin), 'last-event-id': '41'}});
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.match(body, /id: 42\nevent: job.succeeded/);
  assert.match(body, /event: replay-end\ndata: {"cursor":42}/);
  assert.deepEqual(input, {tenantId: tenant, runId: run, identityId: identity, after: 41, limit: 200});
});

test('subscribes before replay and delivers a concurrent event once', async t => {
  let publish;
  let unsubscribed = false;
  let notifyUnsubscribe;
  const unsubscribeComplete = new Promise(resolve => { notifyUnsubscribe = resolve; });
  const options = {
    auth: {session: async () => ({identityId: identity})},
    service: {
      subscribe: async ({onEvent}) => {
        publish = onEvent;
        return () => { unsubscribed = true; notifyUnsubscribe(); };
      },
      events: async () => {
        publish({id: 43, type: 'job.progress', payload: {percent: 50}, createdAt: '2026-10-13T08:00:01.000Z'});
        return [{id: 42, type: 'job.started', payload: {}, createdAt: '2026-10-13T08:00:00.000Z'}];
      }
    },
    authorizedOrigins: []
  };
  const base = await serve(t, options);
  const origin = new URL(base).origin;
  options.authorizedOrigins.push(origin);
  const controller = new AbortController();
  t.after(() => controller.abort());
  const response = await fetch(`${base}/v1/runs/${run}/events?after=41`, {
    headers: headers(origin),
    signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)])
  });
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let replay = '';
  try {
    while (!replay.includes('event: replay-end\ndata: {"cursor":43}\n\n')) {
      const {value, done} = await reader.read();
      assert.equal(done, false, 'stream closed before the replay-end cursor');
      replay += decoder.decode(value, {stream: true});
      assert.ok(Buffer.byteLength(replay) <= 65536, 'replay exceeded its fixture bound');
    }
    assert.match(replay, /id: 42[\s\S]*id: 43[\s\S]*replay-end/);
    assert.equal((replay.match(/^id: 42$/gm) || []).length, 1);
    assert.equal((replay.match(/^id: 43$/gm) || []).length, 1);
  } finally {
    await reader.cancel();
    controller.abort();
  }
  let cleanupTimer;
  try {
    await Promise.race([
      unsubscribeComplete,
      new Promise((_, reject) => {
        cleanupTimer = setTimeout(() => reject(new Error('subscription cleanup did not complete')), 2000);
      })
    ]);
  } finally {
    clearTimeout(cleanupTimer);
  }
  assert.equal(unsubscribed, true);
});

test('fails closed and releases a subscription that errors before replay', async t => {
  let unsubscribed = false;
  const options = {
    auth: {session: async () => ({identityId: identity})},
    service: {
      subscribe: async ({onError}) => {
        onError();
        return () => { unsubscribed = true; };
      },
      events: async () => assert.fail('replay must not start after a subscription error')
    },
    authorizedOrigins: []
  };
  const base = await serve(t, options);
  const origin = new URL(base).origin;
  options.authorizedOrigins.push(origin);
  const response = await fetch(`${base}/v1/runs/${run}/events`, {headers: headers(origin)});
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {code: 'run_events_unavailable'});
  assert.equal(unsubscribed, true);
});

test('fails closed for invalid cursors, origins and sessions', async t => {
  let calls = 0;
  const options = {auth: {session: async () => null}, service: {events: async () => { calls++; return []; }}, authorizedOrigins: []};
  const base = await serve(t, options);
  const origin = new URL(base).origin;
  options.authorizedOrigins.push(origin);
  let response = await fetch(`${base}/v1/runs/${run}/events?after=unsafe`, {headers: headers(origin)});
  assert.equal(response.status, 401);
  options.auth = {session: async () => ({identityId: identity})};
  response = await fetch(`${base}/v1/runs/${run}/events?after=unsafe`, {headers: headers(origin)});
  assert.equal(response.status, 400);
  response = await fetch(`${base}/v1/runs/${run}/events`, {headers: headers('https://attacker.invalid')});
  assert.equal(response.status, 403);
  assert.equal(calls, 0);
});
