/**
 * ──────────────────────────────────────────────────────────────────
 * Service 3: Change Detection & DB Diff Microservice
 * ──────────────────────────────────────────────────────────────────
 * Consumes standardized data from `db_queue`, performs dual-level
 * in-memory change detection (profile & content), groups records into
 * 50-row micro-batches, eliminates deadlocks with deterministic sorting,
 * and executes atomic dual-table upserts to PostgreSQL.
 */

const env = require('./config/env.config');
const logger = require('./utils/logger');
const { closePool } = require('./config/db.config');
const { closeQueues, dbQueue } = require('./queues/change-detection.queues');
const { startDBWorker, stopDBWorker } = require('./workers/change-detection.worker');

logger.info('═══════════════════════════════════════════════════════');
logger.info('Change Detection & DB Diff Service (Stage 3) — Starting Up');
logger.info('═══════════════════════════════════════════════════════');
logger.info({
  dbConcurrency: env.dbWorker.concurrency,
  dbBatchSize: env.dbWorker.batchSize,
  flushIntervalMs: env.dbWorker.flushIntervalMs,
  enableDbWrites: env.dbWorker.enableDbWrites,
  nodeEnv: env.nodeEnv,
}, 'Configuration loaded');

startDBWorker();

const statsInterval = setInterval(async () => {
  try {
    const [dbWaiting, dbActive, dbCompleted, dbFailed] = await Promise.all([
      dbQueue.getWaitingCount(),
      dbQueue.getActiveCount(),
      dbQueue.getCompletedCount(),
      dbQueue.getFailedCount(),
    ]);

    logger.info({
      db_queue: {
        waiting: dbWaiting,
        active: dbActive,
        completed: dbCompleted,
        failed: dbFailed,
      },
    }, 'Change Detection Service Stats');
  } catch (err) {
    logger.error({ err: err.message }, 'Failed to fetch queue stats');
  }
}, 30000);

let isShuttingDown = false;
async function gracefulShutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  logger.info(`Received ${signal} — Gracefully shutting down Change Detection Service...`);
  clearInterval(statsInterval);

  await stopDBWorker();
  await closeQueues();
  await closePool();

  logger.info('Change Detection Service shut down cleanly.');
  process.exit(0);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

