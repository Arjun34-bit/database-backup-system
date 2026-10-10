'use strict';
const { required, integer } = require('./env');
module.exports = function databaseConfig() {
  const database = required('DB_NAME');
  // libpq treats names containing '=' or URI prefixes as connection strings.
  if (database.includes('=') || /^postgres(?:ql)?:/i.test(database)) {
    throw new Error('Configuration: DB_NAME must be a plain database name');
  }
  return {
    host: required('DB_HOST'), port: integer('DB_PORT', 5432, 1, 65535),
    database, user: required('DB_USER'), password: required('DB_PASSWORD'),
    dumpPath: required('PG_DUMP_PATH'), restorePath: required('PG_RESTORE_PATH'),
    timeout: integer('PG_TIMEOUT_MS', 7200000, 1000, 86400000)
  };
};
