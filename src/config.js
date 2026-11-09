/**
 * config.js — where things live, and the user's settings.
 *
 *   config dir  ~/.config/finance-ledger/   config.json, gmail-credentials.json, gmail-token.json
 *   data dir    ~/.local/share/finance-ledger/   transactions.json, contacts.json, ...
 *
 * Override with LEDGER_CONFIG_DIR / LEDGER_DATA_DIR (or the XDG_* variables).
 * Nothing in the repo is ever read as user data, so a `git pull` can't touch it.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { readJsonSafe } from './atomicJson.js';

const home = os.homedir();

export const CONFIG_DIR =
  process.env.LEDGER_CONFIG_DIR ||
  path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'finance-ledger');

export const DATA_DIR =
  process.env.LEDGER_DATA_DIR ||
  path.join(process.env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'finance-ledger');

export const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');
export const GMAIL_CREDS_PATH = path.join(CONFIG_DIR, 'gmail-credentials.json');
export const GMAIL_TOKEN_PATH = path.join(CONFIG_DIR, 'gmail-token.json');

export const DEFAULTS = {
  pollIntervalMinutes: 5,
  lookbackDays: 7,
  dashboardPort: 7780,
  // Loopback by default: the dashboard has no login. Only widen this on a
  // network you trust (LAN / Tailscale), never on the public internet.
  dashboardBind: '127.0.0.1',
  // Limits which mail the poller even looks at (Gmail search syntax).
  gmailQuery: '(nayapay OR "UBL netbanking" OR ebanking@ubl)',
  // { "NayaPay": 1000, "UBL": 500 } — balances at `balanceAsOf`. Optional:
  // you can also set a balance from the dashboard.
  startingBalances: {},
  balanceAsOf: null,
  // Shared secret for POST /api/sms. Empty = SMS ingest is disabled.
  smsSecret: '',
};

/** Re-read on every call so edits take effect without a restart. */
export function readConfig() {
  return { ...DEFAULTS, ...(readJsonSafe(CONFIG_PATH, {}) || {}) };
}

export function ensureDirs() {
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
}
