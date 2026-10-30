require('dotenv').config();

const requiredVars = ['REDIS_HOST', 'REDIS_PORT', 'PG_HOST', 'PG_PORT', 'PG_USER', 'PG_PASSWORD', 'PG_DATABASE'];

for (const varName of requiredVars) {
  if (!process.env[varName]) {
    console.error(`FATAL: Missing required environment variable in Change Detection Service: ${varName}`);
    process.exit(1);
  }
}

module.exports = {
  pg: {
    host: process.env.PG_HOST,
    port: parseInt(process.env.PG_PORT, 10),
    user: process.env.PG_USER,
    password: process.env.PG_PASSWORD,
    database: process.env.PG_DATABASE,
    poolMax: parseInt(process.env.PG_POOL_MAX || '15', 10),
    idleTimeoutMs: parseInt(process.env.PG_IDLE_TIMEOUT_MS || '30000', 10),
    connectionTimeoutMs: parseInt(process.env.PG_CONNECTION_TIMEOUT_MS || '5000', 10),
  },

  redis: {
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
    password: process.env.REDIS_PASSWORD || undefined,
    db: parseInt(process.env.REDIS_DB || '0', 10),
  },

  dbWorker: {
    concurrency: parseInt(process.env.DB_WORKER_CONCURRENCY || '15', 10),
    batchSize: parseInt(process.env.DB_BATCH_SIZE || '50', 10),
    flushIntervalMs: parseInt(process.env.DB_FLUSH_INTERVAL_MS || '1000', 10),
    enableDbWrites: process.env.ENABLE_DB_WRITES !== 'false',
  },

  logLevel: process.env.LOG_LEVEL || 'info',
  nodeEnv: process.env.NODE_ENV || 'production',
};

