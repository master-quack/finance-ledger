/**
 * gmailAuth.js — read-only Gmail access via your own Google OAuth client.
 *
 * Setup is in docs/GMAIL_SETUP.md. Then run `ledger auth` once.
 * Scope is gmail.readonly: the ledger can read mail, never send or delete.
 */
import { google } from 'googleapis';
import fs from 'fs';
import http from 'http';
import readline from 'readline';
import { URL } from 'url';
import { writeJsonAtomic } from './atomicJson.js';
import { ensureDirs, GMAIL_CREDS_PATH, GMAIL_TOKEN_PATH } from './config.js';

const SCOPES = ['https://www.googleapis.com/auth/gmail.readonly'];
const AUTH_PORT = 8888;
const REDIRECT = `http://localhost:${AUTH_PORT}`;

function loadClient() {
  if (!fs.existsSync(GMAIL_CREDS_PATH)) {
    throw new Error(
      `Missing ${GMAIL_CREDS_PATH}\nCreate an OAuth "Desktop app" client and save its JSON there (see docs/GMAIL_SETUP.md).`);
  }
  const creds = JSON.parse(fs.readFileSync(GMAIL_CREDS_PATH, 'utf8'));
  const { client_secret, client_id } = creds.installed || creds.web;
  return new google.auth.OAuth2(client_id, client_secret, REDIRECT);
}

function saveToken(tokens) {
  ensureDirs();
  writeJsonAtomic(GMAIL_TOKEN_PATH, tokens, { pretty: false });
  fs.chmodSync(GMAIL_TOKEN_PATH, 0o600);
}

/** Authorised client from the saved token. Throws if `ledger auth` hasn't run. */
export function getAuthClient() {
  const client = loadClient();
  if (!fs.existsSync(GMAIL_TOKEN_PATH)) {
    throw new Error('Not signed in to Gmail yet. Run: ledger auth');
  }
  client.setCredentials(JSON.parse(fs.readFileSync(GMAIL_TOKEN_PATH, 'utf8')));
  // Google rotates access tokens; keep any refreshed credentials.
  client.on('tokens', t => {
    try {
      const old = JSON.parse(fs.readFileSync(GMAIL_TOKEN_PATH, 'utf8'));
      saveToken({ ...old, ...t });
    } catch { /* best effort */ }
  });
  return client;
}

export function getGmail() {
  return google.gmail({ version: 'v1', auth: getAuthClient() });
}

/**
 * Interactive sign-in.
 *  default  : listens on localhost:8888 for Google's redirect (works when the
 *             browser is on this machine).
 *  manual   : for headless boxes. Open the URL anywhere, approve, then paste the
 *             address your browser ends up on (it will say "can't connect" -
 *             that's expected) back into the terminal.
 */
export async function authorize({ manual = false } = {}) {
  const client = loadClient();
  const url = client.generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: SCOPES });
  console.log('\nOpen this URL and sign in with the Google account that receives your bank alerts:\n\n' + url + '\n');

  let code;
  if (manual) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise(r => rl.question('Paste the full URL you were redirected to (or just the code): ', r));
    rl.close();
    code = answer.includes('code=') ? new URL(answer.trim()).searchParams.get('code') : answer.trim();
  } else {
    console.log(`Waiting on ${REDIRECT} ...  (on a remote machine? use: ledger auth --manual)`);
    code = await new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        const got = new URL(req.url, REDIRECT).searchParams.get('code');
        res.writeHead(got ? 200 : 400, { 'Content-Type': 'text/plain' });
        res.end(got ? 'Gmail linked. You can close this tab.' : 'No auth code.');
        if (got) { server.close(); resolve(got); }
      });
      server.on('error', reject);
      server.listen(AUTH_PORT, '127.0.0.1');
    });
  }

  const { tokens } = await client.getToken(code);
  saveToken(tokens);
  console.log('Gmail linked. Token saved to', GMAIL_TOKEN_PATH);
}
