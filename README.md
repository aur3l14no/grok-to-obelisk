# grok-to-obelisk

Writes your Grok history (chats and bots on grok.com) into Obelisk's import
directory, so Obelisk can search it next to your coding-agent sessions.

Grok is read through [OpenCLI](https://github.com/jackwener/OpenCLI)'s `grok`
commands in your signed-in Chrome. This script keeps only the chat content and
writes Obelisk import format v1 (Obelisk ADR-0018).

## Use

Needs Node 20+ and an `opencli` that has `grok conversations`, `grok transcript`,
`grok bots` and `grok bot-transcript`, signed in to grok.com.

```sh
./grok-to-obelisk.mjs            # writes ~/.obelisk/imports/grok
./grok-to-obelisk.mjs --full     # read every conversation again
OPENCLI_BIN=/path/to/opencli ./grok-to-obelisk.mjs
```

A conversation is read again only when the `updatedAt` in Grok's listing has
moved since the last run, so a run with no new activity only lists. It prints
one line per conversation and exits 1 if anything failed; the rest is still
written. Schedule it yourself, for example with launchd or cron. Obelisk never
starts it.

## What it writes

```
~/.obelisk/imports/grok/
  source.json                         {"formatVersion": 1, "displayName": "Grok"}
  conversations/chat-<conversationId>.json
  conversations/bot-<agentId>.json
```

Each conversation file is a whole snapshot named after its conversation id,
replaced through a temporary file and a rename:

```json
{
  "formatVersion": 1,
  "id": "chat-<conversationId>",
  "title": "…",
  "createdAt": "2026-10-04T11:34:10.736Z",
  "updatedAt": "2026-10-04T11:39:07.227Z",
  "messages": [
    { "id": "<responseId>", "role": "user", "timestamp": "…", "text": "…" },
    { "id": "<responseId>", "role": "assistant", "timestamp": "…", "text": "…", "model": "grok-4" }
  ]
}
```

- **Chats:** user and assistant turns with text, in the order they were
  written. An edited prompt and its answer follow the original ones; reasoning
  and tool calls are left out.
- **Bots:** your messages and the bot's text replies, in transcript order.
  Widget cards, approvals, events and attachments are left out.
- **Deletion:** snapshots are never deleted. A conversation removed on
  grok.com keeps its last snapshot, which is what Obelisk keeps indexed.

## Test

```sh
npm test
```
