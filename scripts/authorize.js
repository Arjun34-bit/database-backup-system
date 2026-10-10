'use strict';
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes, createHash, timingSafeEqual } = require('node:crypto');
const { root } = require('../src/config/env');
const { createAuth, scope } = require('../src/config/drive.config');
async function main() {
  const state = randomBytes(32).toString('hex');
  const verifier = randomBytes(32).toString('base64url');
  let auth;
  let handled = false;
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    const received = Buffer.from(url.searchParams.get('state') || '');
    if (url.pathname !== '/oauth2callback' || received.length !== state.length || !timingSafeEqual(received, Buffer.from(state)) || handled) {
      response.writeHead(400).end('Invalid callback'); return;
    }
    handled = true;
    try {
      const code = url.searchParams.get('code');
      if (!code || url.searchParams.has('error')) throw new Error('Authorization declined');
      const { tokens } = await auth.getToken({ code, codeVerifier: verifier });
      if (!tokens.refresh_token) throw new Error('No refresh token returned');
      const file = path.join(root, '.env');
      let content = await fs.readFile(file, 'utf8');
      const line = `GOOGLE_REFRESH_TOKEN=${JSON.stringify(tokens.refresh_token)}`;
      content = /^GOOGLE_REFRESH_TOKEN=.*$/m.test(content) ? content.replace(/^GOOGLE_REFRESH_TOKEN=.*$/m, () => line) : `${content}\n${line}\n`;
      await fs.writeFile(file, content, { mode: 0o600 });
      response.end('Authorization complete. You may close this tab.');
      console.log('Refresh token saved to .env. No token was printed.');
    } catch {
      response.writeHead(500).end('Authorization failed. Check your terminal.');
      console.error('Authorization failed. Check Desktop OAuth client settings, test user access, consent and .env write permissions.');
      process.exitCode = 1;
    } finally { clearTimeout(timer); server.close(); }
  });
  server.on('error', () => { console.error('Could not start the local OAuth callback listener'); process.exitCode = 1; clearTimeout(timer); });
  const timer = setTimeout(() => { console.error('Authorization timed out'); process.exitCode = 1; server.close(); server.closeAllConnections(); }, 300000);
  server.listen(0, '127.0.0.1', () => {
    try {
      const redirectUri = `http://127.0.0.1:${server.address().port}/oauth2callback`;
      auth = createAuth({ refresh: false, redirectUri });
      const url = auth.generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: [scope], state,
        code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' });
      console.log(`Open this authorization URL in your browser within five minutes:\n${url}`);
    } catch { console.error('Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env first'); clearTimeout(timer); server.close(); process.exitCode = 1; }
  });
}
main().catch(() => { console.error('OAuth setup failed'); process.exitCode = 1; });
