'use strict';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
async function ensureDirectory(directory) { await fsp.mkdir(directory, { recursive: true, mode: 0o700 }); }
function filename(database) {
  const name = database.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
  return `${name}_${new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_')}_${randomUUID()}.dump`;
}
async function inspect(file) {
  const stat = await fsp.lstat(file);
  if (!stat.isFile() || stat.size === 0 || !Number.isSafeInteger(stat.size)) throw new Error('Backup must be a nonempty regular file');
  const hash = createHash('md5');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return { size: stat.size, md5: hash.digest('hex') };
}
async function saveState(file, state) {
  const temp = `${file}.tmp`;
  await fsp.writeFile(temp, JSON.stringify(state, null, 2), { mode: 0o600 });
  await fsp.rename(temp, file);
}
async function readState(file) {
  try { return JSON.parse(await fsp.readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
module.exports = { ensureDirectory, filename, inspect, saveState, readState };
