#!/usr/bin/env node
/**
 * Dependency-free smoke test — guards against regressions.
 * Phase 1: `node --check` server.js + every modules/*.js.
 * Phase 2: boot the server on a test port and assert /, /api/status, /api/state 200.
 * Exits 0 on success, 1 on any failure.
 */
const { execFileSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');

const ROOT = path.join(__dirname, '..');
const PORT = process.env.SMOKE_PORT || 3399;
let failures = 0;
const fail = (m) => { console.error('  ✗ ' + m); failures++; };
const ok = (m) => console.log('  ✓ ' + m);

// ---- Phase 1: syntax check ----
console.log('[SMOKE] Phase 1: node --check');
const jsFiles = ['server.js', ...fs.readdirSync(path.join(ROOT, 'modules'))
  .filter(f => f.endsWith('.js')).map(f => path.join('modules', f))];
for (const f of jsFiles) {
  try {
    execFileSync('node', ['--check', path.join(ROOT, f)], { stdio: 'pipe' });
  } catch (e) {
    fail(`syntax: ${f} — ${(e.stderr ? e.stderr.toString() : e.message).split('\n')[0]}`);
  }
}
if (failures === 0) ok(`${jsFiles.length} files parse`);

// ---- Phase 2: boot + endpoint checks ----
console.log(`[SMOKE] Phase 2: boot server on :${PORT} + check endpoints`);
const srv = spawn('node', ['server.js'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT) },
  stdio: 'ignore'
});

function get(p) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: p, timeout: 5000 }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', () => resolve(0));
    req.on('timeout', () => { req.destroy(); resolve(0); });
  });
}

async function waitUp(timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await get('/')) return true;
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

(async () => {
  try {
    if (!(await waitUp())) {
      fail('server did not come up within 20s');
    } else {
      for (const p of ['/', '/api/status', '/api/state']) {
        const code = await get(p);
        if (code === 200) ok(`GET ${p} -> 200`); else fail(`GET ${p} -> ${code}`);
      }
    }
  } finally {
    srv.kill('SIGKILL');
  }
  console.log(failures === 0 ? '[SMOKE] PASS' : `[SMOKE] FAIL (${failures} failure(s))`);
  process.exit(failures === 0 ? 0 : 1);
})();
