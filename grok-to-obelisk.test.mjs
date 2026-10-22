import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { botSnapshot, chatSnapshot, sync } from './grok-to-obelisk.mjs';

const FAKE_OPENCLI = fileURLToPath(new URL('./fixtures/fake-opencli.mjs', import.meta.url));

const chat = { id: 'c1', title: 'Trip', createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-02T00:00:00Z' };
const bot = {
    id: 'b1',
    name: 'Trip Planner',
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-01T00:00:00Z',
    lastActivityAt: '2026-10-03T00:00:00Z',
};
const at = (second) => `2026-10-01T00:00:0${second}.000Z`;

describe('chatSnapshot', () => {
    test('keeps text turns in creation order, flattening an edit branch', () => {
        // Tree order: the edited prompt q2 is a sibling of q1 but was written later.
        const rows = [
            { id: 'q2', role: 'user', text: 'edited', createdAt: at(3), model: null },
            { id: 'a2', role: 'assistant', text: 'answer 2', createdAt: at(4), model: 'grok-4' },
            { id: 'q1', role: 'user', text: 'first', createdAt: at(1), model: null },
            { id: 'a1', role: 'assistant', text: 'answer 1', createdAt: at(2), model: 'grok-4' },
            { id: 'a3', role: 'assistant', text: '  ', createdAt: at(5), model: 'grok-4' },
            { id: 's1', role: 'system', text: 'other', createdAt: at(6), model: null },
        ];
        assert.deepEqual(chatSnapshot(chat, rows), {
            formatVersion: 1,
            id: 'chat-c1',
            title: 'Trip',
            createdAt: '2026-10-01T00:00:00.000Z',
            updatedAt: '2026-10-02T00:00:00.000Z',
            messages: [
                { id: 'q1', role: 'user', timestamp: at(1), text: 'first' },
                { id: 'a1', role: 'assistant', timestamp: at(2), text: 'answer 1', model: 'grok-4' },
                { id: 'q2', role: 'user', timestamp: at(3), text: 'edited' },
                { id: 'a2', role: 'assistant', timestamp: at(4), text: 'answer 2', model: 'grok-4' },
            ],
        });
    });

    test('rejects a turn without a timestamp and a duplicate id', () => {
        assert.throws(() => chatSnapshot(chat, [{ id: 'q1', role: 'user', text: 'x', createdAt: null }]), /not a timestamp/);
        const twice = { id: 'q1', role: 'user', text: 'x', createdAt: at(1) };
        assert.throws(() => chatSnapshot(chat, [twice, twice]), /duplicate message id q1/);
    });
});

describe('botSnapshot', () => {
    test('keeps user messages and text replies in transcript order', () => {
        const rows = [
            { id: 't0', kind: 'message', type: null, role: 'user', text: 'hi', createdAt: at(1) },
            { id: 't1', kind: 'send-message', type: 'text', role: 'assistant', text: 'hello', createdAt: at(2) },
            { id: 't2', kind: 'send-message', type: 'widget', role: 'assistant', text: 'Pick one', createdAt: at(3) },
            { id: 't3', kind: 'send-message', type: 'auto-review-approval', role: 'assistant', text: 'Approve?', createdAt: at(4) },
            { id: 't4', kind: 'event', type: 'name-changed', role: 'system', text: null, createdAt: at(5) },
            { id: 't5', kind: 'user-attachment', type: null, role: 'user', text: null, createdAt: at(6) },
            { id: 't6', kind: 'message', type: null, role: 'assistant', text: 'note', createdAt: at(7) },
        ];
        assert.deepEqual(botSnapshot(bot, rows), {
            formatVersion: 1,
            id: 'bot-b1',
            title: 'Trip Planner',
            createdAt: '2026-10-01T00:00:00.000Z',
            updatedAt: '2026-10-03T00:00:00.000Z',
            messages: [
                { id: 't0', role: 'user', timestamp: at(1), text: 'hi' },
                { id: 't1', role: 'assistant', timestamp: at(2), text: 'hello' },
                { id: 't6', role: 'assistant', timestamp: at(7), text: 'note' },
            ],
        });
    });
});

describe('sync', () => {
    let dir;
    let out;
    let log;

    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'grok-to-obelisk-'));
        out = join(dir, 'imports', 'grok');
        log = [];
        process.env.FAKE_OPENCLI_LOG = join(dir, 'calls.log');
        process.env.FAKE_OPENCLI_FIXTURES = join(dir, 'fixtures.json');
    });

    afterEach(async () => {
        await rm(dir, { recursive: true, force: true });
    });

    const ok = (data) => ({ ok: true, data });
    const fixtures = (map) => writeFile(process.env.FAKE_OPENCLI_FIXTURES, JSON.stringify(map));
    const run = (options = {}) => sync({ out, bin: FAKE_OPENCLI, log: (line) => log.push(line), ...options });
    const calls = async () => (await readFile(process.env.FAKE_OPENCLI_LOG, 'utf8')).trim().split('\n');
    const snapshot = async (name) => JSON.parse(await readFile(join(out, 'conversations', name), 'utf8'));
    const chatTurn = { id: 'q1', role: 'user', text: 'hi', createdAt: at(1), model: null };
    const botEntry = { id: 't0', kind: 'message', type: null, role: 'user', text: 'hi', createdAt: at(1) };

    test('writes source.json and one snapshot per conversation, then rereads only what moved', async () => {
        await fixtures({
            'grok conversations': ok([chat]),
            'grok transcript c1': ok([chatTurn]),
            'grok bots': ok([bot]),
            'grok bot-transcript b1': ok([botEntry]),
        });
        assert.equal(await run(), 0);
        assert.deepEqual(JSON.parse(await readFile(join(out, 'source.json'), 'utf8')), { formatVersion: 1, displayName: 'Grok' });
        assert.deepEqual((await readdir(join(out, 'conversations'))).sort(), ['bot-b1.json', 'chat-c1.json']);
        assert.equal((await snapshot('chat-c1.json')).messages[0].text, 'hi');

        await run();
        assert.deepEqual(await calls(), [
            'grok conversations', 'grok transcript c1', 'grok bots', 'grok bot-transcript b1',
            'grok conversations', 'grok bots',
        ]);
        assert.ok(log.includes('chat c1: not modified'));

        await run({ full: true });
        assert.ok(log.includes('chat c1: unchanged'));
        assert.equal((await calls()).length, 10);
    });

    test('keeps the snapshot of a conversation that disappeared remotely', async () => {
        await fixtures({ 'grok conversations': ok([chat]), 'grok transcript c1': ok([chatTurn]), 'grok bots': ok([]) });
        await run();
        await fixtures({ 'grok conversations': ok([]), 'grok bots': ok([]) });
        assert.equal(await run(), 0);
        assert.equal((await snapshot('chat-c1.json')).id, 'chat-c1');
    });

    test('rewrites a snapshot whose id does not match its file name', async () => {
        await fixtures({ 'grok conversations': ok([chat]), 'grok transcript c1': ok([chatTurn]), 'grok bots': ok([]) });
        await run();
        const file = join(out, 'conversations', 'chat-c1.json');
        await writeFile(file, JSON.stringify({ ...(await snapshot('chat-c1.json')), id: 'chat:c1' }));
        await run();
        assert.equal((await snapshot('chat-c1.json')).id, 'chat-c1');
    });

    test('counts each failure and still writes the other conversations', async () => {
        const other = { ...chat, id: 'c2' };
        await fixtures({
            'grok conversations': ok([chat, other, { ...chat, id: '../x' }]),
            'grok transcript c1': { ok: false, error: { code: 'TIMEOUT', message: 'timed out', hint: 'retry' } },
            'grok transcript c2': ok([chatTurn]),
            'grok bots': { ok: false, error: { code: 'AUTH_REQUIRED', message: 'sign in' } },
        });
        assert.equal(await run(), 3);
        assert.deepEqual(await readdir(join(out, 'conversations')), ['chat-c2.json']);
        assert.ok(log.includes('chat c1: failed: opencli grok transcript: TIMEOUT: timed out (retry)'));
        assert.ok(log.includes('chat ../x: failed: unexpected id'));
        assert.ok(log.includes('bots: listing failed: opencli grok bots: AUTH_REQUIRED: sign in'));
    });

    test('treats an empty listing as no conversations and skips a conversation with no chat content', async () => {
        await fixtures({
            'grok conversations': { ok: false, error: { code: 'EMPTY_RESULT', message: 'no data' } },
            'grok bots': ok([bot]),
            'grok bot-transcript b1': ok([{ ...botEntry, kind: 'event', type: 'name-changed', text: null }]),
        });
        assert.equal(await run(), 0);
        assert.deepEqual(log, ['chats: 0 listed', 'bots: 1 listed', 'bot b1: no chat content']);
        assert.deepEqual(await readdir(join(out, 'conversations')), []);
    });
});
