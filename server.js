const app = require('./app');
const { disconnectPrisma } = require('./src/database');
const PORT = process.env.PORT || 3000;

const server = app.listen(PORT, () => {
  console.log(`المُميز platform running on http://localhost:${PORT}`);
});

function gracefulShutdown(signal) {
  console.log(`\n[${signal}] Received — starting graceful shutdown...`);
  server.close(async () => {
    console.log('[Server] HTTP server closed');
    try {
      await disconnectPrisma();
      console.log('[Prisma] Database connections closed');
    } catch (e) {
      console.error('[Prisma] Error disconnecting:', e.message);
    }
    console.log('[Shutdown] Goodbye.');
    process.exit(0);
  });
  const FORCE_KILL_MS = 15000;
  setTimeout(() => {
    console.error(`[Shutdown] Forced exit after ${FORCE_KILL_MS}ms timeout`);
    process.exit(1);
  }, FORCE_KILL_MS);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason instanceof Error ? reason.message : reason);
  if (reason instanceof Error && reason.stack) {
    console.error(reason.stack);
  }
});

process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err.message);
  console.error(err.stack);
  process.exit(1);
});
