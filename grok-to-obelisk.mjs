#!/usr/bin/env node
// Writes Grok chats and bots as Obelisk import format v1 snapshots (Obelisk
// ADR-0018). Grok is read through OpenCLI's `grok` commands; this script only
// keeps the chat content and writes one JSON snapshot per conversation.
import { execFile } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs, promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const FORMAT_VERSION = 1;
const SAFE_ID = /^[A-Za-z0-9_-]+$/;

const botUpdatedAt = (bot) => bot.lastActivityAt ?? bot.updatedAt;

const SURFACES = [
    { kind: 'chat', list: 'conversations', read: 'transcript', updatedAt: (chat) => chat.updatedAt, build: chatSnapshot },
    { kind: 'bot', list: 'bots', read: 'bot-transcript', updatedAt: botUpdatedAt, build: botSnapshot },
];

/** A chat's user and assistant turns with text, in the order they were written. Edit branches are flattened. */
export function chatSnapshot(chat, rows) {
    const messages = rows
        .filter((row) => (row.role === 'user' || row.role === 'assistant') && hasText(row.text))
        .map((row) => toMessage(row, row.model))
        .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
    return toSnapshot(`chat-${chat.id}`, chat.title, chat.createdAt, chat.updatedAt, messages);
}

/** A bot's user messages and text replies, in transcript order. Widgets, approvals, events and attachments are left out. */
export function botSnapshot(bot, rows) {
    const messages = rows.filter(isBotChatEntry).map((row) => toMessage(row));
    return toSnapshot(`bot-${bot.id}`, bot.name, bot.createdAt, botUpdatedAt(bot), messages);
}

function isBotChatEntry(row) {
    if (!hasText(row.text)) return false;
    if (row.kind === 'message') return row.role === 'user' || row.role === 'assistant';
    return row.kind === 'send-message' && row.type === 'text';
}

function toMessage(row, model) {
    if (typeof row.id !== 'string' || !row.id) throw new Error(`message without an id: ${JSON.stringify(row).slice(0, 120)}`);
    const message = { id: row.id, role: row.role, timestamp: isoTime(row.createdAt, `message ${row.id}`), text: row.text };
    if (typeof model === 'string' && model) message.model = model;
    return message;
}

function toSnapshot(id, title, createdAt, updatedAt, messages) {
    const seen = new Set();
    for (const message of messages) {
        if (seen.has(message.id)) throw new Error(`${id} has a duplicate message id ${message.id}`);
        seen.add(message.id);
    }
    return {
        formatVersion: FORMAT_VERSION,
        id,
        title: hasText(title) ? title : null,
        createdAt: isoTime(createdAt, `${id} createdAt`),
        updatedAt: isoTime(updatedAt, `${id} updatedAt`),
        messages,
    };
}

function hasText(value) {
    return typeof value === 'string' && value.trim() !== '';
}

function isoTime(value, what) {
    const ms = typeof value === 'string' ? Date.parse(value) : Number.NaN;
    if (Number.isNaN(ms)) throw new Error(`${what} is not a timestamp: ${JSON.stringify(value)}`);
    return new Date(ms).toISOString();
}

/**
 * Lists both surfaces and rewrites each conversation whose listing `updatedAt`
 * moved (every one with `full`). Never deletes a snapshot. Returns the number of failures.
 */
export async function sync({ out, bin = 'opencli', full = false, log = console.error }) {
    await mkdir(join(out, 'conversations'), { recursive: true });
    await save(join(out, 'source.json'), { formatVersion: FORMAT_VERSION, displayName: 'Grok' });
    let failures = 0;
    for (const surface of SURFACES) {
        let items;
        try {
            items = await opencli(bin, [surface.list]);
        } catch (err) {
            failures++;
            log(`${surface.kind}s: listing failed: ${err.message}`);
            continue;
        }
        log(`${surface.kind}s: ${items.length} listed`);
        for (const item of items) {
            try {
                log(`${surface.kind} ${item.id}: ${await syncOne({ out, bin, full, surface, item })}`);
            } catch (err) {
                failures++;
                log(`${surface.kind} ${item.id}: failed: ${err.message}`);
            }
        }
    }
    return failures;
}

async function syncOne({ out, bin, full, surface, item }) {
    if (typeof item.id !== 'string' || !SAFE_ID.test(item.id)) throw new Error('unexpected id');
    // The import format names each snapshot file after its conversation id.
    const id = `${surface.kind}-${item.id}`;
    const file = join(out, 'conversations', `${id}.json`);
    const previous = await readJson(file);
    if (!full && previous?.formatVersion === FORMAT_VERSION && previous.id === id
        && Date.parse(previous.updatedAt) === Date.parse(surface.updatedAt(item))) {
        return 'not modified';
    }
    const snapshot = surface.build(item, await opencli(bin, [surface.read, item.id]));
    if (!snapshot.messages.length) return 'no chat content';
    return (await save(file, snapshot)) ? 'written' : 'unchanged';
}

async function opencli(bin, args) {
    let stdout;
    try {
        ({ stdout } = await execFileAsync(bin, ['grok', ...args, '-f', 'json'], {
            maxBuffer: 512 * 1024 * 1024,
            timeout: 15 * 60_000,
        }));
    } catch (err) {
        // A failing command still prints its JSON error envelope on stdout.
        if (!err.stdout) throw err;
        stdout = err.stdout;
    }
    const result = JSON.parse(stdout);
    if (result.ok) return result.data;
    if (result.error?.code === 'EMPTY_RESULT') return [];
    const { code, message, hint } = result.error ?? {};
    throw new Error(`opencli grok ${args[0]}: ${code}: ${message}${hint ? ` (${hint})` : ''}`);
}

/** Writes JSON through a temporary file and a rename, skipping identical content. Returns whether it wrote. */
async function save(file, value) {
    const text = `${JSON.stringify(value, null, 2)}\n`;
    if ((await readText(file)) === text) return false;
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, text);
    await rename(tmp, file);
    return true;
}

async function readText(file) {
    try {
        return await readFile(file, 'utf8');
    } catch (err) {
        if (err.code === 'ENOENT') return null;
        throw err;
    }
}

async function readJson(file) {
    const text = await readText(file);
    if (text === null) return null;
    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
}

const USAGE = `Usage: grok-to-obelisk [--out <dir>] [--full]

Reads Grok chats and bots through OpenCLI and writes them as Obelisk import
snapshots. Only conversations whose updatedAt moved are read again; --full
reads all of them.

  --out <dir>  Import directory (default: ~/.obelisk/imports/grok)
  --full       Read every conversation, even if it looks unchanged

Set OPENCLI_BIN to run a specific opencli executable.`;

async function main(argv) {
    const { values } = parseArgs({
        args: argv,
        options: { out: { type: 'string' }, full: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } },
    });
    if (values.help) {
        console.log(USAGE);
        return 0;
    }
    const failures = await sync({
        out: values.out ?? join(homedir(), '.obelisk', 'imports', 'grok'),
        bin: process.env.OPENCLI_BIN || 'opencli',
        full: values.full ?? false,
    });
    return failures ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
    main(process.argv.slice(2)).then(
        (code) => { process.exitCode = code; },
        (err) => { console.error(err.message); process.exitCode = 1; },
    );
}
