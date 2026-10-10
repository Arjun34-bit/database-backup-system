'use strict';
const { google } = require('googleapis');
const { required, integer } = require('./env');
const scope = 'https://www.googleapis.com/auth/drive.file';
function createAuth({ refresh = true, redirectUri } = {}) {
  const auth = new google.auth.OAuth2(required('GOOGLE_CLIENT_ID'), required('GOOGLE_CLIENT_SECRET'), redirectUri);
  if (refresh) auth.setCredentials({ refresh_token: required('GOOGLE_REFRESH_TOKEN') });
  return auth;
}
function driveConfig() {
  const folderId = required('GOOGLE_DRIVE_FOLDER_ID');
  if (!/^[\w-]+$/.test(folderId)) throw new Error('Configuration: GOOGLE_DRIVE_FOLDER_ID must be an ID, not a URL');
  const auth = createAuth();
  return { auth, drive: google.drive({ version: 'v3', auth }), folderId,
    timeout: integer('UPLOAD_TIMEOUT_MS', 120000, 1000, 3600000),
    retries: integer('UPLOAD_MAX_RETRIES', 5, 0, 10) };
}
module.exports = { driveConfig, createAuth, scope };
