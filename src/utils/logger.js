const pino = require('pino');
const env = require('../config/env.config');

const isDev = env.nodeEnv !== 'production';

const logger = pino({
  level: env.logLevel || 'info',
  ...(isDev && {
    transport: {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'yyyy-mm-dd HH:MM:ss',
        ignore: 'pid,hostname',
      },
    },
  }),
});

module.exports = logger;

