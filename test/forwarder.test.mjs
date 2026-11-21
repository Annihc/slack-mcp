import assert from 'node:assert/strict';
import { mkdtemp, rm, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createForwarder } from '../forwarder.mjs';

const env = { SLACK_BOT_TOKEN: 'xoxb-fixture', DESTINATION_URL: 'https://receiver.example/messages', DESTINATION_TOKEN: 'fixture-token', STATE_PATH: ':memory:' };
const ok = data => Response.json({ ok: true, ...data });
const message = (ts, text, extra) => ({ type: 'message', ts, text, user: 'U123', ...extra });

test('pages through Slack, includes threads and DMs, sends edits, and persists delivery state', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'slack-forwarder-'));
  const config = { ...env, STATE_PATH: join(folder, 'state.sqlite') };
  const delivered = [];
  const waits = [];
  let limitOnce = true;
  let edited = false;
  let profileReads = 0;
  const fixture = async (url, options) => {
    assert.equal(options.redirect, 'error');
    if (url.origin === 'https://receiver.example') {
      assert.equal(url.pathname, '/messages');
      assert.equal(options.method, 'POST');
      assert.equal(options.headers.Authorization, 'Bearer fixture-token');
      assert.match(options.headers['Idempotency-Key'], /^[a-f0-9]{64}$/);
      delivered.push({ payload: JSON.parse(options.body), key: options.headers['Idempotency-Key'] });
      if (limitOnce) {
        limitOnce = false;
        return new Response(null, { status: 429, headers: { 'retry-after': '2' } });
      }
      return new Response(null, { status: 204 });
    }
    assert.equal(url.origin, 'https://slack.com');
    assert.equal(options.headers.Authorization, 'Bearer xoxb-fixture');
    const { channel, cursor, latest } = Object.fromEntries(url.searchParams);
    switch (url.pathname) {
      case '/api/auth.test': return ok({ team_id: 'T123' });
      case '/api/users.info':
        profileReads++;
        assert.equal(url.searchParams.get('user'), 'U123');
        return ok({ user: { profile: { display_name: 'Demo Sender', real_name: 'Demo Person' } } });
      case '/api/conversations.list': return cursor
        ? ok({ channels: [{ id: 'D123', is_im: true }] })
        : ok({ channels: [{ id: 'C123', name: 'test', is_member: true }, { id: 'C999', is_member: false }], response_metadata: { next_cursor: 'channels=' } });
      case '/api/conversations.history': {
        if (channel === 'D123') return ok({ messages: [message('1.000001', 'Direct message')] });
        assert.equal(channel, 'C123');
        if (latest) {
          assert.equal(latest, '2.000001');
          return ok({ messages: [message('1.000001', 'Earlier history')] });
        }
        return ok({ has_more: true, messages: [
          message('4.000001', 'Broadcast reply', { thread_ts: '2.000001', subtype: 'thread_broadcast' }),
          message('2.000001', edited ? 'Updated root' : 'Root', { reply_count: 2, ...(edited ? { edited: { ts: '5.000001' } } : {}) }),
        ] });
      }
      case '/api/conversations.replies': {
        assert.equal(channel, 'C123');
        assert.equal(url.searchParams.get('ts'), '2.000001');
        return cursor ? ok({ messages: [message('4.000001', 'Broadcast reply', { thread_ts: '2.000001' })] })
          : ok({ messages: [message('2.000001', 'Parent duplicate'), message('3.000001', 'Thread reply')], response_metadata: { next_cursor: 'thread=' } });
      }
      default: assert.fail(`Unexpected endpoint: ${url.pathname}`);
    }
  };
  const makeReader = () => createForwarder(config, { fetcher: fixture, pause: async ms => { waits.push(ms); } });
  let reader;
  try {
    reader = makeReader();
    assert.deepEqual(await reader.sync(), { conversations: 2, posted: 5, issues: [] });
    assert.deepEqual(waits, [2000]);
    assert.equal(profileReads, 1);
    assert.ok(delivered.every(record => record.payload.senderName === 'Demo Sender'));
    assert.deepEqual(delivered[0], delivered[1]);
    assert.equal(delivered.find(record => record.payload.text === 'Thread reply').payload.threadTs, '2.000001');
    assert.equal(delivered.find(record => record.payload.text === 'Direct message').payload.channelId, 'D123');
    reader.close();
    reader = undefined;
    reader = makeReader();
    assert.equal((await reader.sync()).posted, 0);
    edited = true;
    assert.equal((await reader.sync()).posted, 1);
    assert.equal(delivered.at(-1).payload.id, 'T123:C123:2.000001');
    assert.equal(delivered.at(-1).payload.text, 'Updated root');
    assert.notEqual(delivered.at(-1).key, delivered.find(record => record.payload.text === 'Root').key);
  } finally {
    reader?.close();
    await rm(config.STATE_PATH, { force: true });
    await rmdir(folder);
  }
});

test('reports unreadable threads and names, and retries a message after a failed delivery', async () => {
  let reject = true;
  const reader = createForwarder({ ...env, SLACK_CHANNEL_IDS: 'C123,C404' }, { fetcher: async url => {
    if (url.origin === 'https://receiver.example') return new Response(null, { status: reject ? 400 : 204 });
    switch (url.pathname) {
      case '/api/auth.test': return ok({ team_id: 'T123' });
      case '/api/users.info': return Response.json({ ok: false, error: 'missing_scope' });
      case '/api/conversations.list': return ok({ channels: [{ id: 'C123' }, { id: 'C999' }] });
      case '/api/conversations.history':
        assert.equal(url.searchParams.get('channel'), 'C123');
        return ok({ messages: [message('1.000001', 'Parent', { reply_count: 1 })] });
      case '/api/conversations.replies': return Response.json({ ok: false, error: 'not_allowed_token_type' });
      default: assert.fail(`Unexpected endpoint: ${url.pathname}`);
    }
  } });
  try {
    await assert.rejects(reader.sync(), /Destination API returned HTTP 400/);
    reject = false;
    const result = await reader.sync();
    assert.equal(result.posted, 1);
    assert.match(result.issues[0], /users:read/);
    assert.match(result.issues[1], /C123 threads.*not_allowed_token_type/);
    assert.match(result.issues[2], /C404.*not visible/);
  } finally { reader.close(); }
});
