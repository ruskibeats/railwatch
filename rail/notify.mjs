// WhatsApp notify through caddy, the same route as /usr/local/sbin/snow-freshness.
//
// The WhatsApp token never leaves caddy: we SSH there, source the swap app's
// .env on the remote side, and POST {"to","text"} to /api/whatsapp/notify.
// `dry` (CLI --dry, or a missing `to`) prints instead of sending.

import { spawn } from 'node:child_process';

const DEFAULTS = {
  caddy: 'root@192.168.18.25',
  remoteEnvFile: '/opt/desktop-swap-app-v2/desktop-swap-app-v2/.env',
  tokenEnv: 'SNOW_DRAINER_TOKEN',
  endpoint: 'http://127.0.0.1:3003/api/whatsapp/notify',
};

export function makeSender({ to, caddy, remoteEnvFile, tokenEnv, endpoint, dry = false } = {}) {
  // Only set keys override a default; `{ caddy: undefined }` must not wipe it.
  const cfg = { ...DEFAULTS };
  for (const [k, v] of Object.entries({ caddy, remoteEnvFile, tokenEnv, endpoint })) if (v != null) cfg[k] = v;

  return async function send(text) {
    if (dry || !to) {
      console.log(`DRY would send to ${to ? 'configured number' : '<no number>'}:\n${text}`);
      return true;
    }
    const remote =
      `set -a; . ${cfg.remoteEnvFile}; ` +
      `curl -fsS -m 30 -X POST -H "Authorization: Bearer $${cfg.tokenEnv}" ` +
      `-H 'Content-Type: application/json' --data-binary @- ${cfg.endpoint}`;
    const body = JSON.stringify({ to, text });

    return await new Promise((resolve) => {
      const child = spawn(
        'ssh',
        ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=10', '-o', 'ServerAliveCountMax=3', cfg.caddy, remote],
        { stdio: ['pipe', 'ignore', 'pipe'] },
      );
      let stderr = '';
      child.stderr.on('data', (d) => {
        stderr += d;
      });
      child.on('error', () => resolve(false));
      child.on('close', (code) => {
        if (code !== 0) console.error(`notify failed (ssh exit ${code}): ${stderr.slice(-300)}`);
        resolve(code === 0);
      });
      // ssh can exit before reading stdin; EPIPE must not crash the run.
      child.stdin.on('error', () => {});
      child.stdin.end(body);
    });
  };
}
