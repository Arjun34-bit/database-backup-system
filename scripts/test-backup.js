'use strict';
const { createApp } = require('../src/app');
const { safeError } = require('../src/utils/logger');
async function main() {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--retry-upload')) throw new Error('Usage: npm run backup -- [--retry-upload "path/to/file.dump"]');
  const { service, logger } = createApp();
  try {
    const result = await service.run({ retryFile: args[1] });
    if (!result.ok) process.exitCode = 1;
  } finally { logger.end(); }
}
main().catch(error => { console.error(safeError(error)); process.exitCode = 1; });
