const fs = require('fs');
const path = require('path');

/**
 * Lightweight log rotation for the long-running instance.
 *
 * Tees console.log/info/warn/error into a size-capped file so logs can't fill the
 * disk over days/weeks — without touching the 200+ existing console.* call sites.
 * stdout behaviour is preserved (so the launcher's capture still works).
 *
 * Uses synchronous appendFileSync (no held fd) so rotation via renameSync is
 * race-free. Config: LOG_FILE (default data/app.log), LOG_MAX_BYTES (default 5MB);
 * one rotated backup is kept (<file>.1).
 */
const LOG_FILE = process.env.LOG_FILE || path.join(__dirname, '..', 'data', 'app.log');
const MAX_BYTES = parseInt(process.env.LOG_MAX_BYTES) || 5 * 1024 * 1024;
let bytes = 0;
let ready = false;

function init() {
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    try { bytes = fs.statSync(LOG_FILE).size; } catch (e) { bytes = 0; }
    ready = true;
  } catch (e) {
    ready = false;
  }
}

function write(level, args) {
  if (!ready) return;
  try {
    const parts = args.map(a => {
      if (typeof a === 'string') return a;
      try { return JSON.stringify(a); } catch (e) { return String(a); }
    });
    const line = `[${new Date().toISOString()}] [${level}] ${parts.join(' ')}\n`;
    fs.appendFileSync(LOG_FILE, line);
    bytes += Buffer.byteLength(line);
    if (bytes >= MAX_BYTES) {
      fs.renameSync(LOG_FILE, LOG_FILE + '.1'); // overwrite previous backup
      bytes = 0;
    }
  } catch (e) { /* never let logging throw */ }
}

function install() {
  if (console.__rotating) return; // idempotent
  init();
  for (const level of ['log', 'info', 'warn', 'error']) {
    const orig = console[level].bind(console);
    console[level] = (...args) => { orig(...args); write(level.toUpperCase(), args); };
  }
  console.__rotating = true;
  console.log(`[LOGGER] Rotating log → ${LOG_FILE} (max ${Math.round(MAX_BYTES / 1048576)}MB, 1 backup)`);
}

module.exports = { install };
