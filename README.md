# Slack Message Forwarder

A standalone Node.js 22.13+ process that reads available Slack history and thread replies, then POSTs message records to an HTTPS API. It polls every five minutes by default. On each pass it checks history again to discover new replies to old threads and edits to old messages. For large workspaces, use a longer interval because full scans consume Slack API quota. [Slack history](https://docs.slack.dev/reference/methods/conversations.history/) · [Slack threads](https://docs.slack.dev/reference/methods/conversations.replies/) · [Slack rate limits](https://docs.slack.dev/apis/web-api/rate-limits/)

The reader covers public and private channels the Slack bot can read, plus direct and group messages involving the bot. Slack permissions and workspace retention determine how much history is available. If Slack denies access to a channel or thread, the process reports that gap. It delivers text and message identifiers. File contents, deleted messages, and deletions at the receiver are outside this sync.

## How we built it

The first prototype exposed Slack reads through MCP. We also tried a separate Slack command that could queue AccessManager agent jobs. The final requirement was to read Slack messages and give them to an existing API, so this package runs as a standalone forwarder.

- `forwarder.mjs` authenticates to Slack, lists visible conversations, paginates through history and thread replies, and resolves sender profiles using `users.info`. It caches each sender lookup for the current scan.
- It sends each message to the destination API as JSON. SQLite records the last successfully delivered version per message and destination. Retries use the same `Idempotency-Key` header.
- `local-receiver.mjs` provides a loopback API for testing. It accepts POST requests, upserts records into a separate SQLite database, and displays recent records over GET.
- We tested against a real Slack test channel and the local receiver. The test exposed two setup requirements for the workspace: add the bot to the channel and reinstall the app after granting `users:read`. `node --test` exercises pagination, threads, profile lookups, retries, edits, and deduplication with synthetic data.

## Test locally

Run `node --test` from this directory. The tests use synthetic Slack responses and a synthetic receiving API.

If you do not have a hosted destination, run `node local-receiver.mjs` in a separate PowerShell window. In the forwarder’s private settings file set `DESTINATION_URL=http://127.0.0.1:4319/slack/messages` and `ALLOW_LOCAL_HTTP=1`. Leave `DESTINATION_TOKEN` unset. Add your Slack bot token and a test channel ID, then run `forwarder.mjs --once` as shown below. Open the local URL in your browser to see up to 100 received records. The local receiver listens only on your machine and stores messages in `local-receiver.sqlite`.

## Set up Slack and the API

1. In [Slack App Management](https://api.slack.com/apps), create a dedicated app from [slack-app-manifest.json](slack-app-manifest.json), then install it. If you use an existing app, add the manifest’s read scopes and reinstall. Under **OAuth & Permissions**, copy its **Bot User OAuth Token** (`xoxb-`). Use a fresh credential. This reader polls Slack’s Web API. [Slack token documentation](https://docs.slack.dev/authentication/tokens/)
2. Invite the reader app to the channels you want to sync. Start with a test channel and copy its conversation ID.
3. Create a private settings file outside source control, such as `C:\Users\you\AppData\Local\slack-forwarder.env`. Replace the example values below. `DESTINATION_TOKEN` is optional Bearer authentication for your API. Use `SLACK_CHANNEL_IDS` to limit the first run to a test channel. Settings files and the SQLite state file should stay local to the service.

```dotenv
SLACK_BOT_TOKEN=xoxb-your-fresh-token
DESTINATION_URL=https://your-api.example/slack/messages
DESTINATION_TOKEN=your-api-token
SLACK_CHANNEL_IDS=C0123456789
POLL_SECONDS=300
```

Run once in PowerShell from the directory containing `forwarder.mjs`:

```powershell
$settingsFile = Join-Path $env:LOCALAPPDATA 'slack-forwarder.env'
node "--env-file=$settingsFile" .\forwarder.mjs --once
```

Post a test message in the test channel and run the command again. Confirm the receiving API has the new message. When ready to scan all conversations visible to the bot, remove `SLACK_CHANNEL_IDS`. Remove `--once` to run continuously. Run one instance and keep its `slack-forwarder.sqlite` file across restarts. To specify a different durable location, set `STATE_PATH` to an absolute file path.

## Receiving API contract

`senderName` is the Slack display name, with the real name or username as fallbacks. It can be `null` when Slack does not expose a name. Keep `workspaceId` and `userId` as the stable identity for matching people in AccessManager. Names can change or be shared by multiple people. To enable names on an existing installation, add `users:read` under **OAuth & Permissions → Bot Token Scopes**, reinstall, and run the forwarder again. It resends previously delivered records with the same message ID so receivers can update them. [Slack user profiles](https://docs.slack.dev/reference/methods/users.info/)

The forwarder POSTs one JSON message per request. Return a 2xx status after accepting it. An `Idempotency-Key` header stays the same for a retry of a given message version. Upsert records by `id` so edits replace the existing message. The forwarder records a successful delivery locally and retries transient failures. If the receiver accepts a message and the process stops before recording success, the same request can arrive again.

## Integrate with AccessManager

1. Add a POST endpoint to the API that feeds AccessManager, for example `/api/slack/messages`. Authenticate the request with a dedicated bearer token, validate the payload, and persist or durably queue it before returning 2xx.
2. Upsert by `id`. Match the Slack sender to an AccessManager account using an explicit mapping keyed by `workspaceId` and `userId`. Use `senderName` for display, and handle an unknown mapping or a `null` sender separately from a known identity.
3. Configure the forwarder with the endpoint as `DESTINATION_URL` and its credential as `DESTINATION_TOKEN`. Run with `--once` and `SLACK_CHANNEL_IDS` set to a test channel. Check that a new message arrives, that the sender maps correctly, and that a second run with no changes sends zero versions.
4. Run the forwarder as one long-running process with a persistent `STATE_PATH`. Keep credentials and SQLite files outside source control. Add channels only after confirming that the Slack app can read them and that the receiver can handle the initial backfill.

The receiving API owns any downstream AccessManager workflow. The forwarder supplies message data and sender identity.

### Example payload

```json
{
  "schemaVersion": 1,
  "id": "T123:C123:1795264800.000100",
  "workspaceId": "T123",
  "channelId": "C123",
  "channelName": "project-updates",
  "ts": "1795264800.000100",
  "threadTs": null,
  "text": "Sample Slack message",
  "userId": "U123",
  "senderName": "Demo Sender",
  "botId": null,
  "subtype": null,
  "editedTs": null
}
```
