'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createPostgresService, childEnvironment, run } = require('../src/services/postgres.service');
const { createBackupService } = require('../src/services/backup.service');
const { redact } = require('../src/utils/logger');
const logger = { info() {}, warn() {}, error() {} };
const config = { host: '127.0.0.1', port: 5432, database: 'test', user: 'test', password: 'private', dumpPath: 'pg_dump', restorePath: 'pg_restore', timeout: 1000 };
async function directory(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pg-backup-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}
test('dump promotes only a nonempty validated archive', async t => {
  const dir = await directory(t);
  const calls = [];
  const postgres = createPostgresService(config, logger, async (binary, args) => {
    calls.push({ binary, args });
    if (binary === 'pg_dump') await fs.writeFile(args[3], 'PGDMP archive');
  });
  const file = await postgres.dump(dir);
  assert.match(file, /\.dump$/);
  assert.equal(calls[1].binary, 'pg_restore');
  assert.equal(calls[1].args[0], '--list');
  assert.equal((await fs.readdir(dir)).length, 1);
  assert.equal(await fs.readFile(file, 'utf8'), 'PGDMP archive');
});
for (const failure of ['dump', 'empty', 'validation']) {
  test(`${failure} failure removes only the incomplete temporary file`, async t => {
    const dir = await directory(t);
    await fs.writeFile(path.join(dir, 'existing.dump'), 'preserve');
    const postgres = createPostgresService(config, logger, async (binary, args) => {
      if (binary === 'pg_dump') {
        if (failure === 'dump') throw new Error('disk full');
        if (failure !== 'empty') await fs.writeFile(args[3], 'archive');
      } else if (failure === 'validation') throw new Error('bad archive');
    });
    await assert.rejects(postgres.dump(dir));
    assert.deepEqual(await fs.readdir(dir), ['existing.dump']);
  });
}
test('failed dump never uploads and releases the lock', async () => {
  let uploads = 0;
  const service = createBackupService({ postgres: { dump: async () => { throw new Error('failed'); } },
    drive: { upload: async () => { uploads++; } }, config: {}, database: 'test', logger });
  assert.equal((await service.run()).ok, false);
  assert.equal(service.isRunning(), false);
  assert.equal(uploads, 0);
});
test('overlap is skipped; failed upload can retry without dumping', async () => {
  let resolveDump;
  let dumps = 0;
  let uploads = 0;
  let validations = 0;
  const file = path.resolve('existing.dump');
  const service = createBackupService({ postgres: {
    dump: () => { dumps++; return new Promise(resolve => { resolveDump = resolve; }); },
    validate: async () => { validations++; }
  }, drive: { upload: async () => { if (++uploads === 1) throw new Error('offline'); return { id: 'id', name: 'existing.dump', size: '8' }; } },
  config: {}, database: 'test', logger });
  const first = service.run();
  assert.equal((await service.run()).skipped, true);
  resolveDump(file);
  assert.equal((await first).file, file);
  assert.equal((await service.run({ retryFile: file })).ok, true);
  assert.equal(dumps, 1);
  assert.equal(validations, 1);
});
test('controlled environment excludes Google secrets and inherited PG overrides', () => {
  process.env.PGOPTIONS = 'unsafe';
  process.env.GOOGLE_REFRESH_TOKEN = 'sensitive-token';
  const env = childEnvironment(config);
  assert.equal(env.PGOPTIONS, undefined);
  assert.equal(env.GOOGLE_REFRESH_TOKEN, undefined);
  assert.equal(env.PGPASSWORD, 'private');
  assert.equal(redact('sensitive-token postgres://user:pass@host/db Bearer abc'), '[REDACTED] [REDACTED CONNECTION] Bearer [REDACTED]');
  delete process.env.PGOPTIONS;
  delete process.env.GOOGLE_REFRESH_TOKEN;
});
test('spawn handles nonzero status, missing binaries and timeout', async () => {
  await assert.rejects(run(process.execPath, ['-e', 'process.stderr.write("failure detail");process.exit(2)'], config), /exit 2.*failure detail/);
  await assert.rejects(run('nonexistent-backup-test-binary', [], config), /Unable to start/);
  await assert.rejects(run(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { ...config, timeout: 100 }), /timed out/);
});
