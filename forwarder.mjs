import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

const timestamp = /^\d+\.\d+$/;
const conversationId = /^[CDG][A-Z0-9]+$/;
const digest = value => createHash('sha256').update(value).digest('hex');

class ForwarderError extends Error {}
class SlackError extends ForwarderError {
  constructor(method, code) {
    super(`Slack ${method} returned ${code}.`);
    this.code = code;
  }
}

function settings(env) {
  if (!env.SLACK_BOT_TOKEN?.startsWith('xoxb-')) throw new ForwarderError('Set SLACK_BOT_TOKEN to the Slack reader app’s Bot User OAuth Token.');
  let endpoint;
  try { endpoint = new URL(env.DESTINATION_URL); }
  catch { throw new ForwarderError('Set DESTINATION_URL to the receiving HTTPS endpoint.'); }
  const localTest = env.ALLOW_LOCAL_HTTP === '1' && endpoint.protocol === 'http:' && endpoint.hostname === '127.0.0.1';
  if ((!localTest && endpoint.protocol !== 'https:') || endpoint.username || endpoint.password || endpoint.hash) {
    throw new ForwarderError('Use an HTTPS DESTINATION_URL or set ALLOW_LOCAL_HTTP=1 for a local 127.0.0.1 test. Omit credentials and fragments.');
  }
  const channels = new Set((env.SLACK_CHANNEL_IDS ?? '').split(',').map(value => value.trim()).filter(Boolean));
  if ([...channels].some(id => !conversationId.test(id))) throw new ForwarderError('SLACK_CHANNEL_IDS must contain comma-separated Slack conversation IDs.');
  const interval = Number(env.POLL_SECONDS ?? 300);
  if (!Number.isSafeInteger(interval) || interval < 60 || interval > 86400) throw new ForwarderError('POLL_SECONDS must be an integer from 60 to 86400.');
  return {
    endpoint, channels, interval, token: env.SLACK_BOT_TOKEN,
    destinationToken: env.DESTINATION_TOKEN, statePath: env.STATE_PATH || './slack-forwarder.sqlite',
  };
}

async function request(url, options, service, fetcher, pause) {
  for (let attempt = 0; attempt < 4; attempt++) {
    let response;
    try {
      response = await fetcher(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(15_000) });
    } catch {
      if (attempt === 3) throw new ForwarderError(`Could not reach ${service}. Check the URL, TLS, and network connection.`);
    }
    if (response?.ok) return response;
    const status = response?.status;
    const header = response?.headers.get('retry-after');
    await response?.body?.cancel();
    if (status && (attempt === 3 || (status !== 408 && status !== 429 && status < 500))) {
      throw new ForwarderError(`${service} returned HTTP ${status}.`);
    }
    const retryMs = header && /^\d+$/.test(header) ? Number(header) * 1000 : Date.parse(header ?? '') - Date.now();
    await pause(Number.isFinite(retryMs) && retryMs > 0 ? Math.min(retryMs, 86_400_000) : 1000 * 2 ** attempt);
  }
}

function openState(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS delivered (
      destination TEXT NOT NULL, message_id TEXT NOT NULL, version TEXT NOT NULL,
      PRIMARY KEY (destination, message_id)
    )`);
  const get = db.prepare('SELECT version FROM delivered WHERE destination = ? AND message_id = ?');
  const put = db.prepare(`INSERT INTO delivered VALUES (?, ?, ?)
    ON CONFLICT (destination, message_id) DO UPDATE SET version = excluded.version`);
  return { get, put, close: () => db.close() };
}

export function createForwarder(env = process.env, { fetcher = fetch, pause = sleep } = {}) {
  const config = settings(env);
  const state = openState(config.statePath);
  const destination = digest(config.endpoint.href);
  let workspace;

  async function slack(method, parameters = {}) {
    const url = new URL(`https://slack.com/api/${method}`);
    for (const [key, value] of Object.entries(parameters)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    const response = await request(url, { headers: { Authorization: `Bearer ${config.token}` } }, 'Slack', fetcher, pause);
    const data = await response.json().catch(() => { throw new ForwarderError('Slack returned invalid JSON.'); });
    if (data?.ok !== true) {
      const code = typeof data?.error === 'string' && /^[a-z0-9_]{1,80}$/.test(data.error) ? data.error : 'unknown_error';
      throw new SlackError(method, code);
    }
    return data;
  }

  async function* pages(method, field, params, direction) {
    const cursors = new Set();
    const boundaries = new Set();
    let cursor;
    let boundary;
    for (;;) {
      const data = await slack(method, { ...params, limit: 100, [direction ?? 'latest']: boundary, cursor });
      if (!Array.isArray(data[field])) throw new ForwarderError(`Slack ${method} omitted its ${field} array.`);
      yield data[field];
      const next = data.response_metadata?.next_cursor?.trim();
      if (next) {
        if (cursors.has(next)) throw new ForwarderError(`Slack ${method} repeated a pagination cursor.`);
        cursors.add(next);
        cursor = next;
      } else if (data.has_more === true) {
        const nextBoundary = data[field].at(-1)?.ts;
        if (!direction || !timestamp.test(nextBoundary ?? '') || boundaries.has(nextBoundary)) {
          throw new ForwarderError(`Slack ${method} indicated more results without a usable next page.`);
        }
        boundaries.add(nextBoundary);
        boundary = nextBoundary;
        cursor = undefined;
        cursors.clear();
      } else {
        return;
      }
    }
  }

  async function deliver(channel, raw, senderName, parentTs = null) {
    if (raw?.type !== 'message' || !timestamp.test(raw.ts ?? '') || raw.subtype === 'tombstone') return false;
    const id = `${workspace}:${channel.id}:${raw.ts}`;
    const threadTs = raw.thread_ts ?? parentTs;
    const message = {
      ts: raw.ts, threadTs: threadTs === raw.ts ? null : threadTs,
      text: typeof raw.text === 'string' ? raw.text : '', userId: raw.user ?? null,
      senderName: await senderName(raw),
      botId: raw.bot_id ?? null, subtype: raw.subtype ?? null, editedTs: raw.edited?.ts ?? null,
    };
    const version = digest(JSON.stringify(message));
    if (state.get.get(destination, id)?.version === version) return false;
    const headers = { 'Content-Type': 'application/json', 'Idempotency-Key': digest(`${id}:${version}`) };
    if (config.destinationToken) headers.Authorization = `Bearer ${config.destinationToken}`;
    const body = JSON.stringify({ schemaVersion: 1, id, workspaceId: workspace,
      channelId: channel.id, channelName: channel.name ?? null, ...message });
    const response = await request(config.endpoint, { method: 'POST', headers, body }, 'Destination API', fetcher, pause);
    await response.body?.cancel();
    state.put.run(destination, id, version);
    return true;
  }

  async function sync() {
    if (!workspace) {
      const { team_id } = await slack('auth.test');
      if (!/^T[A-Z0-9]+$/.test(team_id ?? '')) throw new ForwarderError('Slack did not return a workspace ID.');
      workspace = team_id;
    }
    let posted = 0;
    const visited = new Set();
    const issues = [];
    const names = new Map();
    let canReadProfiles = true;
    async function senderName(raw) {
      const fallback = raw.username?.trim() || raw.bot_profile?.name?.trim() || null;
      if (!canReadProfiles || !/^[UW][A-Z0-9]+$/.test(raw.user ?? '')) return fallback;
      if (!names.has(raw.user)) {
        try {
          const { user } = await slack('users.info', { user: raw.user });
          const name = [user?.profile?.display_name, user?.profile?.real_name, user?.real_name, user?.name]
            .find(value => typeof value === 'string' && value.trim());
          names.set(raw.user, name?.trim() ?? null);
        } catch (error) {
          if (!(error instanceof SlackError)) throw error;
          if (error.code === 'missing_scope') {
            canReadProfiles = false;
            issues.push('Sender names unavailable. Add users:read to the Slack app and reinstall it.');
          } else if (!['user_not_found', 'user_not_visible'].includes(error.code)) throw error;
          names.set(raw.user, null);
        }
      }
      return names.get(raw.user) ?? fallback;
    }
    const inaccessible = new Set(['no_permission', 'not_in_channel', 'channel_not_found', 'access_denied',
      'missing_scope', 'not_allowed_token_type', 'method_not_supported_for_channel_type']);
    for await (const channels of pages('conversations.list', 'channels', { types: 'public_channel,private_channel,im,mpim' })) {
      for (const channel of channels) {
        if (!conversationId.test(channel.id ?? '') || channel.is_member === false || visited.has(channel.id)
          || (config.channels.size && !config.channels.has(channel.id))) continue;
        visited.add(channel.id);
        let threadsReadable = true;
        const broadcastReplies = new Set();
        try {
          for await (const messages of pages('conversations.history', 'messages', { channel: channel.id }, 'latest')) {
            for (const raw of messages) {
              if (!raw) continue;
              if (await deliver(channel, raw, senderName)) posted++;
              if (raw.thread_ts && raw.thread_ts !== raw.ts) {
                broadcastReplies.add(raw.ts);
                continue;
              }
              if (!threadsReadable || raw.reply_count <= 0 || !Number.isInteger(raw.reply_count) || !timestamp.test(raw.ts ?? '')) continue;
              try {
                const args = { channel: channel.id, ts: raw.ts };
                for await (const replies of pages('conversations.replies', 'messages', args, 'oldest')) {
                  for (const reply of replies) {
                    if (reply && reply.ts !== raw.ts && !broadcastReplies.has(reply.ts) && await deliver(channel, reply, senderName, raw.ts)) posted++;
                  }
                }
              } catch (error) {
                if (!(error instanceof SlackError) || !(inaccessible.has(error.code) || error.code === 'thread_not_found')) throw error;
                const missingThread = error.code === 'thread_not_found';
                issues.push(`${channel.id}${missingThread ? ` thread ${raw.ts}` : ' threads'}: ${error.message}`);
                if (!missingThread) threadsReadable = false;
              }
            }
          }
        } catch (error) {
          if (!(error instanceof SlackError) || !inaccessible.has(error.code)) throw error;
          issues.push(`${channel.id}: ${error.message}`);
        }
      }
    }
    for (const id of config.channels) {
      if (!visited.has(id)) issues.push(`${id}: not visible to the bot or bot membership is required.`);
    }
    return { conversations: visited.size, posted, issues };
  }

  return { sync, interval: config.interval, close: state.close };
}

async function main() {
  const args = process.argv.slice(2);
  const once = args.length === 1 && args[0] === '--once';
  if (args.length && !once) throw new ForwarderError('Usage: node forwarder.mjs [--once]');
  const reader = createForwarder();
  try {
    for (;;) {
      try {
        const { conversations, posted, issues } = await reader.sync();
        console.log(`Scanned ${conversations} conversation(s), sent ${posted} message version(s), ${issues.length} access issue(s).`);
        for (const issue of issues) console.error(issue);
        if (once) { process.exitCode = issues.length ? 1 : 0; return; }
      } catch (error) {
        console.error(error instanceof ForwarderError ? error.message : 'Unexpected sync error. Check local state and configuration.');
        if (once) { process.exitCode = 1; return; }
      }
      await sleep(reader.interval * 1000);
    }
  } finally {
    reader.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error instanceof ForwarderError ? error.message : 'Could not start the Slack reader. Check the local state path.');
    process.exitCode = 1;
  });
}
