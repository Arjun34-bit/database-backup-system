'use strict';
const { createApp } = require('./app');
const { registerBackupJob } = require('./jobs/backup.job');
const { safeError } = require('./utils/logger');
try {
  const { service, config, logger } = createApp();
  const task = registerBackupJob(service, config, logger);
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    task.stop();
    logger.info('Scheduler stopped; allowing any active backup to finish');
    const timer = setInterval(() => {
      if (!service.isRunning()) { clearInterval(timer); task.destroy(); logger.end(); }
    }, 250);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
} catch (error) {
  console.error(safeError(error));
  process.exitCode = 1;
}
