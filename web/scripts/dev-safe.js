const fs = require('fs');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');

const projectRoot = path.resolve(__dirname, '..');
const lockPath = path.join(projectRoot, '.next', 'dev', 'lock');
const port = Number(process.env.PORT || 3000);

function isPortOpen(host, p) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(800);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', () => resolve(false));
    socket.connect(p, host);
  });
}

async function main() {
  const alreadyRunning = await isPortOpen('127.0.0.1', port);
  if (alreadyRunning) {
    console.log(`[web] Detected existing dev server on http://localhost:${port}. Reusing it.`);
    process.exit(0);
  }

  if (fs.existsSync(lockPath)) {
    try {
      fs.unlinkSync(lockPath);
      console.log('[web] Removed stale .next dev lock.');
    } catch (err) {
      console.warn('[web] Could not remove stale lock:', err && err.message ? err.message : err);
    }
  }

  const nextBin = require.resolve('next/dist/bin/next');
  const child = spawn(
    process.execPath,
    [nextBin, 'dev'],
    { cwd: projectRoot, stdio: 'inherit', env: process.env },
  );

  child.on('exit', (code) => process.exit(code == null ? 1 : code));
}

main().catch((err) => {
  console.error('[web] Failed to start dev server:', err);
  process.exit(1);
});
