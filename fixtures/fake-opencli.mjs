#!/usr/bin/env node
// Stands in for `opencli` in tests: answers `grok <command> [id] -f json` from
// the fixture file in FAKE_OPENCLI_FIXTURES and logs each call to FAKE_OPENCLI_LOG.
import { appendFileSync, readFileSync } from 'node:fs';

const key = process.argv.slice(2, -2).join(' ');
appendFileSync(process.env.FAKE_OPENCLI_LOG, `${key}\n`);
const reply = JSON.parse(readFileSync(process.env.FAKE_OPENCLI_FIXTURES, 'utf8'))[key]
    ?? { ok: false, error: { code: 'NOT_FOUND', message: `no fixture for ${key}` } };
process.stdout.write(JSON.stringify(reply));
process.exitCode = reply.ok ? 0 : 1;
