'use strict';
const path = require('node:path');
const cron = require('node-cron');
const { root } = require('./env');
module.exports = function backupConfig() {
  const schedule = process.env.BACKUP_CRON || '0 2 * * *';
  const timezone = process.env.BACKUP_TIMEZONE || 'Asia/Kolkata';
  if (!cron.validate(schedule)) throw new Error('Configuration: invalid BACKUP_CRON');
  try { new Intl.DateTimeFormat('en', { timeZone: timezone }); }
  catch { throw new Error('Configuration: invalid BACKUP_TIMEZONE'); }
  return { directory: path.resolve(root, process.env.BACKUP_DIR || 'backups'), schedule, timezone };
};
