const { Pool } = require('pg');
const env = require('./env.config');
const logger = require('../utils/logger');

const dbPool = new Pool({
  host: env.pg.host,
  port: env.pg.port,
  user: env.pg.user,
  password: env.pg.password,
  database: env.pg.database,
  max: env.pg.poolMax,
  idleTimeoutMillis: env.pg.idleTimeoutMs,
  connectionTimeoutMillis: env.pg.connectionTimeoutMs,
  allowExitOnIdle: false,
});

dbPool.on('error', (err) => {
  logger.error({ err: err.message }, 'PostgreSQL pool background error');
});

async function pingDb() {
  const start = Date.now();
  try {
    await dbPool.query('SELECT 1');
    return Date.now() - start;
  } catch (err) {
    logger.warn({ err: err.message }, 'Database ping failed');
    return -1;
  }
}

async function closePool() {
  if (dbPool.ended) return;
  logger.info('Draining PostgreSQL connection pool...');
  try {
    await dbPool.end();
    logger.info('PostgreSQL pool closed.');
  } catch (err) {
    if (!err.message?.includes('Called end on pool more than once')) {
      logger.error({ err: err.message }, 'Error closing PostgreSQL pool');
    }
  }
}

module.exports = { dbPool, pingDb, closePool };

