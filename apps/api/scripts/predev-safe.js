const { execSync } = require('child_process');

try {
  execSync('npx prisma generate', {
    stdio: 'pipe',
    env: process.env,
  });
  console.log('[predev] Prisma client generated.');
  process.exit(0);
} catch (err) {
  const output = `${(err && err.stdout ? err.stdout.toString() : '')}\n${
    err && err.stderr ? err.stderr.toString() : ''
  }`;
  if (output.includes('EPERM') && output.includes('query_engine-windows.dll.node')) {
    console.warn(
      '[predev] Prisma engine is currently locked by another running API process. Continuing with existing generated client.',
    );
    process.exit(0);
  }
  if (output.trim()) {
    console.error(output.trim());
  }
  process.exit(1);
}
