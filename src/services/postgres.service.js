'use strict';
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const { filename, ensureDirectory } = require('../utils/file.utils');
function childEnvironment(config) {
  const env = {};
  // Inherit OS essentials, not OAuth credentials or unrelated libpq overrides.
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(path|systemroot|windir|temp|tmp|comspec|home|userprofile|lang|lc_all)$/i.test(key)) env[key] = value;
  }
  return { ...env, PGHOST: config.host, PGPORT: String(config.port), PGDATABASE: config.database,
    PGUSER: config.user, PGPASSWORD: config.password, PGCONNECT_TIMEOUT: '30', PGAPPNAME: 'postgres-drive-backup' };
}
function run(binary, args, config) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { shell: false, windowsHide: true,
      env: childEnvironment(config), stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, config.timeout);
    child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-16384); });
    child.on('error', error => { clearTimeout(timer); reject(new Error(`Unable to start ${path.basename(binary)} (${error.code || 'spawn error'})`)); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (code !== 0 || timedOut) reject(new Error(`${path.basename(binary)} ${timedOut ? 'timed out' : `failed (exit ${code}, signal ${signal || 'none'})`}: ${stderr.trim()}`));
      else resolve();
    });
  });
}
function createPostgresService(config, logger, execute = run) {
  async function validate(file) {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.size === 0) throw new Error('Dump is missing, empty, or not a regular file');
    await execute(config.restorePath, ['--list', file], config);
    return stat.size;
  }
  async function dump(directory) {
    await ensureDirectory(directory);
    const file = path.join(directory, filename(config.database));
    const temporary = `${file}.partial`;
    // Reserve a unique path and restrict POSIX permissions before pg_dump opens it.
    const handle = await fs.open(temporary, 'wx', 0o600);
    await handle.close();
    try {
      await execute(config.dumpPath, ['--format=custom', '--no-password', '--file', temporary], config);
      const size = await validate(temporary);
      await fs.rename(temporary, file);
      logger.info(`PostgreSQL archive validated: ${path.basename(file)} (${size} bytes)`);
      return file;
    } catch (error) {
      await fs.unlink(temporary).catch(cleanup => { if (cleanup.code !== 'ENOENT') logger.warn('Could not remove incomplete temporary dump'); });
      throw error;
    }
  }
  return { dump, validate };
}
module.exports = { createPostgresService, run, childEnvironment };
