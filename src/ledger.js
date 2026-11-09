/**
 * ledger.js — the whole ledger: storage, contact labelling, the Gmail poller,
 * SMS ingest and balance maths.
 *
 * Files (all in the data dir, see config.js):
 *   transactions.json    every logged transaction, newest first
 *   state.json           poller bookkeeping (seen message ids, last poll, ...)
 *   aliases.json         permanent counterparty renames
 *   categories.json      counterparty -> spending category
 *   debts.json           money owed to you
 *   balance-anchors.json real balances you typed in from your bank app
 *   contacts.json        who is "self", "Dad", ... (see examples/contacts.example.json)
 */
import fs from 'fs';
import path from 'path';
import { writeJsonAtomic } from './atomicJson.js';
import { readConfig, DATA_DIR, ensureDirs } from './config.js';
import { getGmail } from './gmailAuth.js';
import { parseEmail, htmlToText, normalizeName } from './parsers/email.js';
import { parseBankSms } from './parsers/sms.js';

// Tests point this at a scratch dir via LEDGER_DATA_DIR.
const FINANCE_DIR = DATA_DIR;
const TXN_PATH = path.join(FINANCE_DIR, 'transactions.json');
const STATE_PATH = path.join(FINANCE_DIR, 'state.json');
const ALIASES_PATH = path.join(FINANCE_DIR, 'aliases.json');
const DEBTS_PATH = path.join(FINANCE_DIR, 'debts.json');
const CATEGORIES_PATH = path.join(FINANCE_DIR, 'categories.json');
const ANCHORS_PATH = path.join(FINANCE_DIR, 'balance-anchors.json');
const CONTACTS_PATH = path.join(FINANCE_DIR, 'contacts.json');

// ─── storage helpers ────────────────────────────────────────────────────────

function ensureDir() {
  ensureDirs();
}

function readJson(p, fallback) {
  try {
    if (!fs.existsSync(p)) return fallback;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    console.error(`[ledger] read ${path.basename(p)} error:`, e.message);
    return fallback;
  }
}

export function readTransactions() {
  return readJson(TXN_PATH, []);
}

function writeTransactions(list) {
  ensureDir();
  list.sort((a, b) => new Date(b.date) - new Date(a.date));
  writeJsonAtomic(TXN_PATH, list);
}

function readState() {
  return readJson(STATE_PATH, { seenMessageIds: [] });
}

function writeState(state) {
  ensureDir();
  if (state.seenMessageIds.length > 5000) {
    state.seenMessageIds = state.seenMessageIds.slice(-3000);
  }
  writeJsonAtomic(STATE_PATH, state, { pretty: false });
}

// ─── contacts / label index ──────────────────────────────────────────────────

/**
 * contacts.json maps a label to the name variants your bank prints for that
 * person: { "self": ["JANE Q DOE", "DOE JANE"], "Mom": ["SAM SMITH"] }.
 * "self" is what turns a move between your own accounts into an internal
 * transfer instead of an expense + income.
 */
export function getContacts() {
  const data = readJson(CONTACTS_PATH, {});
  return Object.keys(data)
    .filter(label => label !== 'self' && !label.startsWith('_'))
    .map(label => ({ name: label, relationship: '' }));
}

/** Flat lookup of { norm, label } built from contacts.json. */
export function buildLabelIndex() {
  const contacts = readJson(CONTACTS_PATH, {});
  const index = [];
  for (const [label, variants] of Object.entries(contacts)) {
    if (label.startsWith('_') || !Array.isArray(variants)) continue;
    for (const v of variants) {
      const norm = normalizeName(v);
      if (norm) index.push({ norm, label, priority: 2 });
    }
  }
  return index;
}

/**
 * Matches on whole words, not substrings: "ALI" must not match "SALIM", and a
 * variant matches when all its words appear in the name in any order (banks
 * print "DOE JANE Q" as readily as "JANE Q DOE"). Among equal-priority hits the
 * one covering more words wins, then the one named first.
 */
export function matchLabel(name, index) {
  const words = normalizeName(name).split(' ').filter(Boolean);
  if (!words.length) return null;
  let best = null;
  for (const e of index) {
    const eWords = e.norm.split(' ').filter(Boolean);
    if (!eWords.length) continue;
    const variantInName = eWords.every(w => words.includes(w));
    // A bank-truncated name ("JANE Q") inside a longer variant - needs two
    // words so a lone first name doesn't match half the ledger.
    const nameInVariant = words.length >= 2 && words.every(w => eWords.includes(w));
    if (!variantInName && !nameInVariant) continue;
    const hit = {
      ...e,
      size: Math.min(eWords.length, words.length),
      pos: Math.min(...eWords.map(w => words.indexOf(w)).filter(i => i >= 0)),
    };
    const better =
      !best ||
      hit.priority > best.priority ||
      (hit.priority === best.priority && (
        hit.size > best.size ||
        (hit.size === best.size && hit.pos < best.pos)));
    if (better) best = hit;
  }
  return best ? best.label : null;
}

export function enrich(txn, index) {
  let senderLabel = matchLabel(txn.sender, index);
  let receiverLabel = matchLabel(txn.receiver, index);

  // Every bank alert - SMS or email - is about your own account, so
  // whichever side the message leaves unnamed is you. Without this,
  // money arriving from another of your accounts logs as a plain credit
  // instead of an internal transfer.
  if (txn.direction === 'credit' && !txn.receiver) receiverLabel = 'self';
  if (txn.direction === 'debit' && !txn.sender) senderLabel = 'self';

  if (senderLabel === 'self' && receiverLabel === 'self') {
    txn.type = 'internal_transfer';
    txn.label = 'self';
  } else if (txn.direction === 'debit') {
    txn.type = 'debit';
    txn.label = receiverLabel || 'unknown';
  } else if (txn.direction === 'credit') {
    txn.type = 'credit';
    txn.label = senderLabel || 'unknown';
  } else {
    txn.type = 'unknown';
    txn.label = senderLabel || receiverLabel || 'unknown';
  }

  txn.counterparty = txn.direction === 'debit' ? txn.receiver : txn.sender;
  return txn;
}

// ─── aliases (permanent renames) ──────────────────────────────────────────────
// Shape: { "<normalized counterparty>": "Display Name" }

export function readAliases() {
  return readJson(ALIASES_PATH, {});
}

/** Set alias for a raw counterparty name. Empty/blank alias removes it. */
export function setAlias(rawName, alias) {
  const key = normalizeName(rawName);
  if (!key) return { ok: false, error: 'empty name' };
  ensureDir();
  const aliases = readAliases();
  if (alias && alias.trim()) {
    aliases[key] = alias.trim();
  } else {
    delete aliases[key];
  }
  writeJsonAtomic(ALIASES_PATH, aliases);
  return { ok: true, aliases };
}

// ─── categories (payee → spending category, set from the UI) ──────────────────

export function readCategories() {
  return readJson(CATEGORIES_PATH, {});
}

/** Set category for a raw counterparty name. Empty/blank category removes it. */
export function setCategory(rawName, category) {
  const key = normalizeName(rawName);
  if (!key) return { ok: false, error: 'empty name' };
  ensureDir();
  const categories = readCategories();
  if (category && category.trim()) {
    categories[key] = category.trim();
  } else {
    delete categories[key];
  }
  writeJsonAtomic(CATEGORIES_PATH, categories);
  return { ok: true, categories };
}

// ─── balance anchors (the real figure from the bank app, per account) ─────────
// Shape: { NayaPay: { amount, asOf } } — overrides config.startingBalances for that bank.

export function readBalanceAnchors() {
  return readJson(ANCHORS_PATH, {});
}

export function setBalanceAnchor(bank, amount) {
  ensureDir();
  const anchors = readBalanceAnchors();
  anchors[bank] = { amount, asOf: new Date().toISOString() };
  writeJsonAtomic(ANCHORS_PATH, anchors);
  return { ok: true, anchors };
}

// ─── debts (Type 1: tied to an existing transaction) ──────────────────────────
// Shape: [{ txnId, person, amount, note, settled, createdAt, updatedAt }]

export function readDebts() {
  return readJson(DEBTS_PATH, []);
}

function writeDebts(list) {
  ensureDir();
  writeJsonAtomic(DEBTS_PATH, list);
}

/**
 * Create / update / remove a debt for a transaction.
 *  - person empty  → removes the debt flag for that txn
 *  - settled bool  → toggles settled state
 */
export function upsertDebt({ txnId, person, amount, note, settled }) {
  if (!txnId) return { ok: false, error: 'txnId required' };
  const debts = readDebts();
  const idx = debts.findIndex(d => d.txnId === txnId);

  // Unflag
  if (person !== undefined && (!person || !String(person).trim())) {
    if (idx !== -1) debts.splice(idx, 1);
    writeDebts(debts);
    return { ok: true, removed: true, debts };
  }

  const now = new Date().toISOString();
  if (idx === -1) {
    debts.push({
      txnId,
      person: (person || 'Unknown').trim(),
      amount: amount ?? null,
      note: (note || '').trim(),
      settled: !!settled,
      createdAt: now,
      updatedAt: now,
    });
  } else {
    const d = debts[idx];
    if (person !== undefined) d.person = (person || d.person).trim();
    if (amount !== undefined) d.amount = amount;
    if (note !== undefined) d.note = (note || '').trim();
    if (settled !== undefined) d.settled = !!settled;
    d.updatedAt = now;
  }
  writeDebts(debts);
  return { ok: true, debts };
}

// ─── gmail plumbing ─────────────────────────────────────────────────────────

function decodeB64Url(data) {
  return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

function extractBody(payload) {
  let html = '', text = '';
  function walk(part) {
    if (!part) return;
    if (part.mimeType === 'text/html' && part.body?.data) html += decodeB64Url(part.body.data);
    if (part.mimeType === 'text/plain' && part.body?.data) text += decodeB64Url(part.body.data);
    (part.parts || []).forEach(walk);
  }
  walk(payload);
  return { html, text };
}

function getHeader(payload, name) {
  return (payload.headers || []).find(h => h.name.toLowerCase() === name.toLowerCase())?.value || '';
}

// ─── poller ─────────────────────────────────────────────────────────────────

let polling = false;

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Gmail caps query cost per minute; a big backfill hits it. Wait it out. */
async function withRateLimitRetry(fn) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const limited = err.code === 429 || (err.code === 403 && /quota|rate/i.test(err.message));
      if (!limited || attempt >= 5) throw err;
      console.warn('[ledger] Gmail rate limit hit, waiting 65s');
      await sleep(65_000);
    }
  }
}

async function listAllMessages(gmail, q) {
  const out = [];
  let pageToken;
  do {
    const res = await withRateLimitRetry(() =>
      gmail.users.messages.list({ userId: 'me', q, maxResults: 500, pageToken }));
    out.push(...(res.data.messages || []));
    pageToken = res.data.nextPageToken;
  } while (pageToken);
  return out;
}

/**
 * @param {{ since?: Date }} [opts]  backfill from this date instead of the
 *   normal window (used by `ledger backfill`).
 */
export async function pollEmails({ since } = {}) {
  if (polling) return; // don't overlap
  polling = true;
  try {
    const config = readConfig();
    const lookbackDays = config.lookbackDays ?? 7;
    const gmail = getGmail();
    const state = readState();
    const index = buildLabelIndex();
    const seen = new Set(state.seenMessageIds);

    // Look back to whichever is earlier: the configured window, or a day before
    // the last successful poll. A fixed "newer_than:7d" silently loses every
    // email that arrived while the poller was down for longer than that.
    const pollStartedAt = new Date();
    let from = new Date(Date.now() - lookbackDays * 86400000);
    if (state.lastSuccessfulPollAt) {
      const resume = new Date(new Date(state.lastSuccessfulPollAt).getTime() - 86400000);
      if (resume < from) from = resume;
    }
    if (since) from = since;

    const extra = (config.gmailQuery || '').trim();
    const messages = await listAllMessages(gmail, `after:${Math.floor(from.getTime() / 1000)}${extra ? ' ' + extra : ''}`);
    const fresh = messages.filter(m => !seen.has(m.id));

    const txns = readTransactions();
    const knownTxnIds = new Set(txns.map(t => t.transactionId));
    let added = 0;
    const skipped = [];
    const lastAlertByBank = { ...(state.lastAlertByBank || {}) };

    for (const msg of fresh) {
      try {
        const full = await withRateLimitRetry(() =>
          gmail.users.messages.get({ userId: 'me', id: msg.id, format: 'full' }));
        const payload = full.data.payload;
        const { html, text } = extractBody(payload);
        const receivedAtIso = new Date(Number(full.data.internalDate)).toISOString();

        const parsed = parseEmail({
          from: getHeader(payload, 'From'),
          subject: getHeader(payload, 'Subject'),
          html,
          text: text || htmlToText(html),
          receivedAtIso,
        });

        seen.add(msg.id);

        // Unparsed mail is marked seen and never retried, so keep a visible
        // record of it for the dashboard's health panel.
        if (!parsed) {
          skipped.push({ id: msg.id, date: receivedAtIso, from: getHeader(payload, 'From'), subject: getHeader(payload, 'Subject') });
          continue;
        }
        if (knownTxnIds.has(parsed.transactionId)) continue;

        // Deduplicate same-bank emails for the same transfer (NayaPay sends 2 IDs).
        // Must be the same direction: a send and a receive of equal size a
        // minute apart are two real movements (e.g. NayaPay → JazzCash while
        // UBL → NayaPay), and treating them as one silently dropped a debit.
        const isDupe = txns.some(t =>
          t.source === parsed.source &&
          t.amount === parsed.amount &&
          t.direction === parsed.direction &&
          t.type === 'internal_transfer' &&
          Math.abs(new Date(t.date) - new Date(parsed.date)) < 2 * 60 * 1000
        );
        if (isDupe) continue;

        enrich(parsed, index);
        parsed.gmailId = msg.id;
        parsed.loggedAt = new Date().toISOString();
        txns.push(parsed);
        knownTxnIds.add(parsed.transactionId);
        noteAlert(lastAlertByBank, parsed);
        added++;
        console.log(`[ledger] Logged ${parsed.type} of Rs.${parsed.amount} (${parsed.bank}, ${parsed.label})`);
      } catch (err) {
        console.error(`[ledger] Failed to process message ${msg.id}:`, err.message);
      }
    }

    if (added) writeTransactions(txns);
    state.seenMessageIds = [...seen];
    state.lastSuccessfulPollAt = pollStartedAt.toISOString();
    state.lastAlertByBank = lastAlertByBank;
    state.skipped = [...(state.skipped || []), ...skipped]
      .sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, 50);
    delete state.lastPollError;
    writeState(state);
    return { scanned: fresh.length, added };
  } catch (err) {
    console.error('[ledger] Poll error:', err.message);
    try {
      const state = readState();
      state.lastPollError = { at: new Date().toISOString(), message: err.message };
      writeState(state);
    } catch {}
  } finally {
    polling = false;
  }
}

function noteAlert(map, txn) {
  if (!map[txn.bank] || new Date(txn.date) > new Date(map[txn.bank])) map[txn.bank] = txn.date;
  return map;
}

/** Sync status for the dashboard: last poll, last alert per bank, skipped mail. */
export function getHealth() {
  const config = readConfig();
  const state = readState();
  const lastAlertByBank = { ...(state.lastAlertByBank || {}) };
  // Fill from the ledger so banks are covered before the poller has recorded them.
  for (const t of readTransactions()) noteAlert(lastAlertByBank, t);
  for (const b of Object.keys(config.startingBalances || {})) lastAlertByBank[b] ??= null;
  return {
    lastSuccessfulPollAt: state.lastSuccessfulPollAt || null,
    lastPollError: state.lastPollError || null,
    pollIntervalMinutes: config.pollIntervalMinutes ?? 5,
    lastAlertByBank,
    skipped: state.skipped || [],
  };
}

// ─── SMS ingest ─────────────────────────────────────────────────────────────

/**
 * Logs a bank SMS forwarded from your phone (see README: SMS ingest).
 * Deduped by TID, labeled against the same contact index the email poller uses.
 *
 * @param {{ from?: string, message: string }} sms
 * @returns {{ logged: boolean, reason?: string, transaction?: object }}
 */
export function ingestBankSms({ from, message } = {}) {
  const parsed = parseBankSms({ from, message });
  if (!parsed) return { logged: false, reason: 'not a bank SMS' };

  const txns = readTransactions();
  if (txns.some(t => t.transactionId === parsed.transactionId)) {
    return { logged: false, reason: 'duplicate', transactionId: parsed.transactionId };
  }

  enrich(parsed, buildLabelIndex());
  parsed.loggedAt = new Date().toISOString();
  txns.push(parsed);
  writeTransactions(txns);
  const state = readState();
  state.lastAlertByBank = noteAlert({ ...(state.lastAlertByBank || {}) }, parsed);
  writeState(state);

  console.log(`[ledger] SMS logged ${parsed.type} of Rs.${parsed.amount} (${parsed.bank}, ${parsed.label})`);
  return { logged: true, transaction: parsed };
}

export function startPoller() {
  const config = readConfig();
  const minutes = config.pollIntervalMinutes ?? 5;
  setTimeout(pollEmails, 5_000); // first run shortly after boot
  setInterval(pollEmails, minutes * 60 * 1000);
  console.log(`[ledger] Poller started — every ${minutes} min, logging to ${TXN_PATH}`);
}

/**
 * Computes current balance per account from a known starting point.
 * Starting balances + as-of date live in config.json.
 */
export function calculateBalances() {
  const config = readConfig();
  const starting = config.startingBalances || {};
  const configAsOf = config.balanceAsOf ? new Date(config.balanceAsOf) : new Date(0);
  const anchors = readBalanceAnchors();
  const txns = readTransactions();

  // Each account starts from its own anchor (set from the UI) if it has one,
  // otherwise from the config's starting balance.
  const start = {};
  for (const [bank, amount] of Object.entries(starting)) start[bank] = { amount, asOf: configAsOf, anchored: false };
  for (const [bank, a] of Object.entries(anchors)) start[bank] = { amount: a.amount, asOf: new Date(a.asOf), anchored: true };

  const balances = Object.fromEntries(Object.entries(start).map(([b, s]) => [b, s.amount]));

  for (const t of txns) {
    const bank = t.bank;
    const from = start[bank]?.asOf ?? configAsOf;
    const d = new Date(t.date);
    // An anchor is the bank's figure at that moment, so only later movements count.
    if (start[bank]?.anchored ? d <= from : d < from) continue;
    if (!(bank in balances)) balances[bank] = 0;

    // Direction, not type, says which way the money went; a fee on a
    // transfer between your own accounts still leaves the wallet.
    if (t.direction === 'debit') balances[bank] -= t.amount + (t.fee || 0);
    else if (t.direction === 'credit') balances[bank] += t.amount;
  }

  // Round away float drift (5363.79 - … = -301.7599999999934).
  const round2 = n => Math.round(n * 100) / 100;
  for (const k of Object.keys(balances)) balances[k] = round2(balances[k]);
  const total = round2(Object.values(balances).reduce((s, v) => s + v, 0));
  const accounts = Object.fromEntries(Object.keys(balances).map(b => [b, {
    asOf: (start[b]?.asOf ?? configAsOf).toISOString(),
    anchored: !!start[b]?.anchored,
  }]));
  return { balances, total, asOf: configAsOf.toISOString(), accounts };
}
