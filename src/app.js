'use strict';
const databaseConfig = require('./config/database.config');
const backupConfig = require('./config/backup.config');
const { driveConfig } = require('./config/drive.config');
const { createLogger } = require('./utils/logger');
const { createPostgresService } = require('./services/postgres.service');
const { createDriveService } = require('./services/googleDrive.service');
const { createBackupService } = require('./services/backup.service');
function createApp() {
  const database = databaseConfig();
  const config = backupConfig();
  const driveOptions = driveConfig();
  const logger = createLogger();
  const postgres = createPostgresService(database, logger);
  const drive = createDriveService(driveOptions, logger);
  const service = createBackupService({ postgres, drive, config, database: database.database, logger });
  return { service, config, logger };
}
module.exports = { createApp };
