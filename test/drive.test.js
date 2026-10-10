'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { google } = require('googleapis');
const { createDriveService, transient } = require('../src/services/googleDrive.service');
const { inspect } = require('../src/utils/file.utils');
const logger = { info() {}, warn() {}, error() {} };
const apiFailure = code => Object.assign(new Error('transport with secret'), { response: { status: code } });
async function fixture(t, size = 10) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'drive-backup-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'backup.dump');
  await fs.writeFile(file, Buffer.alloc(size, 42));
  const local = await inspect(file);
  let stored = null;
  let creates = 0;
  let generates = 0;
  const metadata = { id: 'reserved-id', name: 'backup.dump', parents: ['folder'], size: String(size), md5Checksum: local.md5 };
  const drive = { files: {
    get: async ({ fileId }) => {
      if (fileId === 'folder') return { data: { mimeType: 'application/vnd.google-apps.folder', ownedByMe: true, capabilities: { canAddChildren: true }, permissions: [{ role: 'owner', type: 'user' }] } };
      if (!stored) throw apiFailure(404);
      return { data: stored };
    },
    generateIds: async () => { generates++; return { data: { ids: ['reserved-id'] } }; },
    create: async (params, options) => {
      creates++;
      assert.equal(params.uploadType, 'resumable');
      assert.equal(params.requestBody.id, 'reserved-id');
      assert.equal(options.url, 'https://www.googleapis.com/upload/drive/v3/files');
      return { headers: new Headers({ location: 'https://www.googleapis.com/upload/session' }) };
    }
  } };
  const auth = { request: async options => {
    let received = 0;
    for await (const chunk of options.data) received += chunk.length;
    assert.equal(received, size);
    stored = metadata;
    return { status: 200, data: metadata };
  } };
  const config = { drive, auth, folderId: 'folder', timeout: 1000, retries: 2 };
  return { file, config, metadata, setStored: value => { stored = value; }, counts: () => ({ creates, generates }) };
}
test('streamed upload verifies metadata and retry reuses the reserved file ID', async t => {
  const fixtureData = await fixture(t);
  const service = createDriveService(fixtureData.config, logger, async () => {});
  assert.equal((await service.upload(fixtureData.file)).id, 'reserved-id');
  assert.equal((await service.upload(fixtureData.file)).id, 'reserved-id');
  assert.deepEqual(fixtureData.counts(), { creates: 1, generates: 1 });
});
test('ambiguous final chunk response is recovered with an empty status query', async t => {
  const data = await fixture(t);
  let calls = 0;
  data.config.auth.request = async options => {
    if (++calls === 1) {
      for await (const chunk of options.data) assert.ok(chunk.length);
      data.setStored(data.metadata);
      throw Object.assign(new Error('lost response'), { code: 'ECONNRESET' });
    }
    assert.equal(options.headers['Content-Range'], 'bytes */10');
    assert.equal(options.headers['Content-Length'], '0');
    return { status: 200, data: data.metadata };
  };
  assert.equal((await createDriveService(data.config, logger, async () => {}).upload(data.file)).id, 'reserved-id');
  assert.equal(calls, 2);
});
test('large upload resumes from server offset and keeps chunk sizes bounded', async t => {
  const data = await fixture(t, 9 * 1024 * 1024);
  const ranges = [];
  data.config.auth.request = async options => {
    ranges.push(options.headers['Content-Range']);
    let bytes = 0;
    for await (const chunk of options.data) bytes += chunk.length;
    assert.ok(bytes <= 8 * 1024 * 1024);
    if (ranges.length === 1) return { status: 308, headers: new Headers({ range: 'bytes=0-8388607' }) };
    data.setStored(data.metadata);
    return { status: 200 };
  };
  await createDriveService(data.config, logger).upload(data.file);
  assert.deepEqual(ranges, ['bytes 0-8388607/9437184', 'bytes 8388608-9437183/9437184']);
});
test('metadata mismatch fails without claiming completion', async t => {
  const data = await fixture(t);
  data.metadata.size = '999';
  await assert.rejects(createDriveService(data.config, logger).upload(data.file), /verification failed/);
  const state = JSON.parse(await fs.readFile(`${data.file}.upload.json`, 'utf8'));
  assert.equal(state.completed, false);
});
test('permission failure is not retried and does not disclose transport details', async t => {
  const data = await fixture(t);
  let calls = 0;
  data.config.drive.files.get = async () => { calls++; throw apiFailure(403); };
  await assert.rejects(createDriveService(data.config, logger).upload(data.file), error => {
    assert.match(error.message, /denied/);
    assert.doesNotMatch(error.message, /secret/);
    return true;
  });
  assert.equal(calls, 1);
});
test('retryable errors stop at the configured bound', async t => {
  const data = await fixture(t);
  let calls = 0;
  data.config.drive.files.get = async () => { calls++; throw apiFailure(503); };
  await assert.rejects(createDriveService(data.config, logger, async () => {}).upload(data.file), /503/);
  assert.equal(calls, 3);
  assert.equal(transient(apiFailure(401)), false);
  assert.equal(transient(apiFailure(403)), false);
  assert.equal(transient(apiFailure(429)), true);
});
test('shared or unverifiable destination is rejected before upload creation', async t => {
  const data = await fixture(t);
  for (const permissions of [undefined, [{ role: 'owner' }, { role: 'reader', type: 'anyone' }]]) {
    data.config.drive.files.get = async () => ({ data: { mimeType: 'application/vnd.google-apps.folder',
      ownedByMe: true, capabilities: { canAddChildren: true }, permissions } });
    await assert.rejects(createDriveService(data.config, logger).upload(data.file), /private folder/);
  }
  assert.deepEqual(data.counts(), { creates: 0, generates: 0 });
});
test('official Google client preserves resumable create URL, body and query', async () => {
  let captured;
  const auth = { request: async options => { captured = options; return { headers: new Headers({ location: 'https://www.googleapis.com/upload/session' }) }; } };
  const drive = google.drive({ version: 'v3', auth });
  await drive.files.create({ uploadType: 'resumable', requestBody: { id: 'reserved-id', name: 'backup.dump' } }, {
    url: 'https://www.googleapis.com/upload/drive/v3/files', headers: { 'X-Upload-Content-Length': '10' }
  });
  assert.equal(String(captured.url), 'https://www.googleapis.com/upload/drive/v3/files');
  assert.equal(captured.params.uploadType, 'resumable');
  assert.equal(captured.data.id, 'reserved-id');
});
