'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { setTimeout: sleep } = require('node:timers/promises');
const { inspect, readState, saveState } = require('../utils/file.utils');
const fields = 'id,name,size,md5Checksum,parents,trashed,createdTime';
function status(error) { return Number(error.response?.status || error.code) || 0; }
function transient(error) {
  const code = status(error);
  const reasons = error.response?.data?.error?.errors?.map(item => item.reason) || [];
  return [408, 429, 500, 502, 503, 504].includes(code) ||
    (code === 403 && reasons.some(reason => ['rateLimitExceeded', 'userRateLimitExceeded'].includes(reason))) ||
    ['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND', 'ECONNREFUSED', 'EPIPE'].includes(error.code);
}
function apiError(error) {
  const code = status(error);
  const oauth = error.response?.data?.error;
  if (code === 401 || oauth === 'invalid_grant') return new Error('Google authorization failed: refresh token expired or revoked; run npm run authorize');
  if (code === 403) return new Error('Google Drive denied the request: check folder permissions, storage quota and API quota');
  if (code === 404) return new Error('Google Drive file/folder or upload session not found; check app access and retry');
  return new Error(`Google Drive request failed (${code || 'network error'}); the local backup is preserved`);
}
function createDriveService(config, logger, pause = sleep) {
  const { auth, drive, folderId, timeout, retries } = config;
  const options = { timeout, retry: false };
  async function retry(operation) {
    for (let attempt = 0; ; attempt++) {
      try { return await operation(); }
      catch (error) {
        if (!transient(error) || attempt >= retries) throw error;
        const delay = Math.min(30000, 1000 * 2 ** attempt) + Math.floor(Math.random() * 500);
        logger.warn(`Transient Drive failure; retry ${attempt + 1}/${retries} in ${delay} ms`);
        await pause(delay);
      }
    }
  }
  async function lookup(id) {
    try { return (await retry(() => drive.files.get({ fileId: id, fields }, options))).data; }
    catch (error) { if (status(error) === 404) return null; throw error; }
  }
  function verify(metadata, file, local) {
    if (!metadata?.id || metadata.trashed || metadata.name !== path.basename(file) ||
        !metadata.parents?.includes(folderId) || String(metadata.size) !== String(local.size) ||
        (metadata.md5Checksum && metadata.md5Checksum !== local.md5)) {
      throw new Error('Drive upload verification failed: name, parent, size or checksum mismatch; local backup preserved');
    }
    return metadata;
  }
  async function checkFolder() {
    const result = await retry(() => drive.files.get({ fileId: folderId,
      fields: 'id,mimeType,trashed,ownedByMe,capabilities(canAddChildren),permissions(type,role)' }, options));
    const folder = result.data;
    if (folder.trashed || folder.mimeType !== 'application/vnd.google-apps.folder' || !folder.capabilities?.canAddChildren) {
      throw new Error('Destination is not a writable Google Drive folder');
    }
    if (!folder.ownedByMe || !Array.isArray(folder.permissions) || !folder.permissions.length ||
        folder.permissions.some(permission => permission.role !== 'owner')) {
      throw new Error('Destination folder is shared. Use a private folder owned by this account');
    }
  }
  async function upload(file) {
    const local = await inspect(file);
    const stateFile = `${file}.upload.json`;
    try {
      await checkFolder();
      let state = await readState(stateFile);
      if (state && (state.folderId !== folderId || state.size !== local.size || state.md5 !== local.md5 || !/^[\w-]+$/.test(state.id))) {
        throw new Error('Upload record does not match this file or destination; refusing to overwrite a previous backup');
      }
      if (!state) {
        const result = await retry(() => drive.files.generateIds({ count: 1, space: 'drive', type: 'files' }, options));
        state = { id: result.data.ids[0], folderId, ...local, completed: false };
        await saveState(stateFile, state);
      }
      const existing = await lookup(state.id);
      if (existing) {
        verify(existing, file, local);
        await saveState(stateFile, { ...state, completed: true });
        return existing;
      }
      if (state.completed) throw new Error('Previously verified Drive backup is now missing; refusing to silently recreate it');
      // Initiate via the official client, then stream chunks through its OAuth transport.
      // A pre-generated ID makes ambiguous create retries safe (Drive returns 409).
      let session;
      try {
        const response = await retry(() => drive.files.create({
          requestBody: { id: state.id, name: path.basename(file), parents: [folderId], mimeType: 'application/octet-stream' },
          fields, uploadType: 'resumable'
        }, { ...options, url: 'https://www.googleapis.com/upload/drive/v3/files',
          headers: { 'X-Upload-Content-Type': 'application/octet-stream', 'X-Upload-Content-Length': String(local.size) } }));
        session = response.headers.get ? response.headers.get('location') : response.headers.location;
      } catch (error) {
        if (status(error) !== 409) throw error;
        const metadata = verify(await lookup(state.id), file, local);
        await saveState(stateFile, { ...state, completed: true });
        return metadata;
      }
      if (!session || new URL(session).origin !== 'https://www.googleapis.com') throw new Error('Invalid Drive resumable session response');
      let offset = 0;
      let failures = 0;
      let queryStatus = false;
      while (offset < local.size) {
        let stream;
        try {
          const end = Math.min(offset + 8 * 1024 * 1024, local.size) - 1;
          if (!queryStatus) stream = fs.createReadStream(file, { start: offset, end });
          const response = await auth.request({ url: session, method: 'PUT', ...options,
            headers: { 'Content-Type': 'application/octet-stream',
              'Content-Length': queryStatus ? '0' : String(end - offset + 1),
              'Content-Range': queryStatus ? `bytes */${local.size}` : `bytes ${offset}-${end}/${local.size}` },
            data: stream || '', validateStatus: code => (code >= 200 && code < 300) || code === 308 });
          if (response.status === 200 || response.status === 201) { offset = local.size; break; }
          if (response.status !== 308) throw new Error('Unexpected resumable upload response');
          const range = response.headers.get ? response.headers.get('range') : response.headers.range;
          const match = range?.match(/^bytes=0-(\d+)$/);
          const next = match ? Number(match[1]) + 1 : 0;
          if (!Number.isSafeInteger(next) || next < offset || next > local.size || (!queryStatus && next <= offset)) {
            throw new Error('Invalid resumable upload offset');
          }
          offset = next;
          queryStatus = false;
        } catch (error) {
          if (!transient(error) || failures >= retries) throw error;
          await pause(Math.min(30000, 1000 * 2 ** failures++) + Math.floor(Math.random() * 500));
          // Query the server before resending: the last chunk may have arrived.
          queryStatus = true;
          logger.warn('Upload interrupted; checking the acknowledged byte offset before resuming');
        } finally { stream?.destroy(); }
      }
      const metadata = verify(await lookup(state.id), file, local);
      await saveState(stateFile, { ...state, completed: true });
      return metadata;
    } catch (error) {
      if (error.response || status(error) || transient(error)) throw apiError(error);
      // OAuth errors can carry raw transport details: expose only known local messages.
      if (/^(Upload record|Previously verified|Drive upload verification|Destination|Invalid Drive|Invalid resumable|Unexpected resumable)/.test(error.message)) throw error;
      if (error.code && /^E[A-Z]+$/.test(error.code)) throw new Error(`Local upload file operation failed (${error.code})`);
      throw new Error('Drive upload failed; check authorization and connectivity. Local backup preserved');
    }
  }
  return { upload };
}
module.exports = { createDriveService, transient, apiError };
