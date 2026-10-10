'use strict';
const cron = require('node-cron');
const { safeError } = require('../utils/logger');
function registerBackupJob(service, config, logger) {
  const task = cron.schedule(config.schedule, async () => {
    try { await service.run(); }
    catch (error) { logger.error(`Scheduled backup failed: ${safeError(error)}`); }
    const next = task.getNextRun?.();
    if (next) logger.info(`Next backup: ${next.toISOString()} (${config.timezone})`);
  }, { timezone: config.timezone, noOverlap: true, name: 'postgres-drive-backup' });
  logger.info(`Backup scheduler started: ${config.schedule}; timezone=${config.timezone}; next=${task.getNextRun?.()?.toISOString() || 'unavailable'}`);
  return task;
}
module.exports = { registerBackupJob };
