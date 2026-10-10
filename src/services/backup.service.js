'use strict';
const path = require('node:path');
const { safeError } = require('../utils/logger');
let running = false;
function createBackupService({ postgres, drive, config, database, logger }) {
  async function run({ retryFile } = {}) {
    if (running) { logger.warn('Backup skipped: another job is running in this process'); return { ok: false, skipped: true }; }
    running = true;
    const started = Date.now();
    let file;
    try {
      logger.info(`Backup started at ${new Date().toISOString()}; database=${database}`);
      if (retryFile) {
        file = path.resolve(retryFile);
        if (path.extname(file) !== '.dump') throw new Error('Upload retry requires a completed .dump file');
        await postgres.validate(file);
        logger.info(`Existing archive validated for upload retry: ${path.basename(file)}`);
      } else file = await postgres.dump(config.directory);
      const metadata = await drive.upload(file);
      logger.info(`Backup completed: filename=${metadata.name}; bytes=${metadata.size}; Drive ID=${metadata.id}; durationMs=${Date.now() - started}`);
      return { ok: true, file, metadata };
    } catch (error) {
      const message = safeError(error);
      logger.error(`Backup failed after ${Date.now() - started} ms: ${message}${file ? `; localFile=${file}` : ''}`);
      return { ok: false, file, error: message };
    } finally { running = false; }
  }
  return { run, isRunning: () => running };
}
module.exports = { createBackupService };
