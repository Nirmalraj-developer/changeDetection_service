const env = require('./env.config');
const logger = require('../utils/logger');

const redisConnection = {
  host: env.redis.host,
  port: env.redis.port,
  password: env.redis.password,
  db: env.redis.db,
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
  retryStrategy: (times) => {
    if (times > 20) {
      logger.error('Redis connection failed after 20 retries. Giving up.');
      return null;
    }
    return Math.min(times * 500, 5000);
  },
};

module.exports = { redisConnection };

