import pino from 'pino';

const isProduction = process.env.NODE_ENV === 'production';

export function createLogger(name = 'App') {
  const options = {
    name,
    level: process.env.LOG_LEVEL || 'info'
  };

  if (!isProduction) {
    options.transport = {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:yyyy-mm-dd HH:MM:ss',
        ignore: 'pid,hostname'
      }
    };
  }

  return pino(options);
}
