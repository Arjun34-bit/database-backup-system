'use strict';
const { google } = require('googleapis');
const { createAuth } = require('../src/config/drive.config');
async function main() {
  const drive = google.drive({ version: 'v3', auth: createAuth() });
  const { data } = await drive.files.create({ requestBody: {
    name: 'PostgreSQL Backups', mimeType: 'application/vnd.google-apps.folder'
  }, fields: 'id,name' }, { timeout: 120000, retry: false });
  console.log(`Created private folder: ${data.name}\nSet GOOGLE_DRIVE_FOLDER_ID=${data.id} in .env\nhttps://drive.google.com/drive/folders/${data.id}`);
}
main().catch(() => { console.error('Folder creation failed. Check OAuth setup, API enablement and Drive quota. If the response was lost, inspect Drive before creating another folder.'); process.exitCode = 1; });
