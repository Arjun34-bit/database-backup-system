'use strict';
const fs = require('node:fs');
const path = require('node:path');
const winston = require('winston');
const { root } = require('../config/env');
function redact(value) {
  let text = String(value);
  for (const name of ['DB_PASSWORD', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN', 'GOOGLE_CLIENT_ID']) {
    const secret = process.env[name];
    if (secret) {
      text = text.split(secret).join('[REDACTED]');
      text = text.split(encodeURIComponent(secret)).join('[REDACTED]');
    }
  }
  return text.replace(/postgres(?:ql)?:\/\/\S+/gi, '[REDACTED CONNECTION]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/((?:access_token|refresh_token|client_secret|password)\s*[=:]\s*)[^\s,;]+/gi, '$1[REDACTED]');
}
function createLogger() {
  const directory = path.join(root, 'logs');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const level = process.env.LOG_LEVEL || 'info';
  if (!Object.hasOwn(winston.config.npm.levels, level)) throw new Error('Configuration: invalid LOG_LEVEL');
  return winston.createLogger({ level,
    format: winston.format.combine(winston.format.timestamp(), winston.format.printf(info =>
      redact(JSON.stringify({ timestamp: info.timestamp, level: info.level, message: info.message })))),
    transports: [new winston.transports.Console(),
      new winston.transports.File({ filename: path.join(directory, 'backup.log'), maxsize: 10485760, maxFiles: 5, options: { mode: 0o600 } }),
      new winston.transports.File({ filename: path.join(directory, 'error.log'), level: 'error', maxsize: 10485760, maxFiles: 5, options: { mode: 0o600 } })]
  });
}
// Never serialize Google error objects: they can contain request headers and tokens.
function safeError(error) { return redact(error?.message || 'Unknown failure'); }
module.exports = { createLogger, redact, safeError };
