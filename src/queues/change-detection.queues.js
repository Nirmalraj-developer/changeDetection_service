const { Queue } = require('bullmq');
const { redisConnection } = require('../config/redis.config');
const logger = require('../utils/logger');

const defaultJobOptions = {
  removeOnComplete: { age: 60, count: 500 },
  removeOnFail: { age: 7 * 24 * 3600, count: 5000 },
  attempts: 5,
  backoff: {
    type: 'exponential',
    delay: 2000,
  },
};

const dbQueue = new Queue('db_queue', {
  connection: redisConnection,
  defaultJobOptions,
});

logger.info('BullMQ queue initialized: db_queue');

async function closeQueues() {
  logger.info('Closing Change Detection Service BullMQ queues...');
  await dbQueue.close();
  logger.info('Change Detection Service queues closed.');
}

module.exports = {
  dbQueue,
  closeQueues,
};

