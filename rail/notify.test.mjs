import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeSender } from './notify.mjs';

// A fake `ssh` first on PATH: saves its stdin and args, exits with FAKE_SSH_EXIT.
const dir = mkdtempSync(join(tmpdir(), 'rail-ssh-'));
writeFileSync(join(dir, 'ssh'), `#!/bin/sh\nprintf '%s\\n' "$@" > "${dir}/args"\ncat > "${dir}/stdin"\nexit "\${FAKE_SSH_EXIT:-0}"\n`);
chmodSync(join(dir, 'ssh'), 0o755);
process.env.PATH = `${dir}:${process.env.PATH}`;

test('ssh exit 0 is a delivery; the body is {to, text} on stdin', async () => {
  process.env.FAKE_SSH_EXIT = '0';
  const send = makeSender({ to: '447000000000', caddy: 'root@caddy.test' });
  assert.equal(await send('hello'), true);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'stdin'), 'utf8')), { to: '447000000000', text: 'hello' });
  const args = readFileSync(join(dir, 'args'), 'utf8');
  assert.match(args, /BatchMode=yes/);
  assert.match(args, /root@caddy\.test/);
});

test('ssh non-zero exit is a failure, so the alert is retried', async () => {
  process.env.FAKE_SSH_EXIT = '255';
  const send = makeSender({ to: '447000000000' });
  assert.equal(await send('hello'), false);
});

test('dry or no number never calls ssh and reports success', async () => {
  process.env.FAKE_SSH_EXIT = '1';
  assert.equal(await makeSender({ to: '447000000000', dry: true })('x'), true);
  assert.equal(await makeSender({})('x'), true);
});
