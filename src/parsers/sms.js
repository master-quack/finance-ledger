/**
 * sms.js — parses bank transaction SMS into the same shape
 * email.js produces, so email and SMS both feed one transactions.json.
 *
 * Pure functions only — no file writes. Logging lives in ledger.js.
 *
 * Covers JazzCash today. Add Raqami patterns to RAQAMI_RULES once samples exist.
 * UBL SMS is deliberately skipped: UBL already arrives by email and would
 * otherwise double-log the same transaction.
 */

// ─── helpers ────────────────────────────────────────────────────────────────

function parseAmount(str) {
  const n = parseFloat(String(str || '').replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

function tidy(str) {
  return (str || '').replace(/\s+/g, ' ').trim();
}

/**
 * Handles both date shapes JazzCash uses, e.g.
 *   "2026-07-17 at 17:01:32"  (YYYY-MM-DD)
 *   "16-07-2026 at 23:56:03"  (DD-MM-YYYY)
 * Both are Pakistan time (UTC+5).
 */
function parseDate(str) {
  if (!str) return null;
  try {
    let m = str.match(/(\d{4})-(\d{2})-(\d{2})\s+at\s+(\d{2}:\d{2}:\d{2})/);
    if (m) return new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}+05:00`).toISOString();
    m = str.match(/(\d{2})-(\d{2})-(\d{4})\s+at\s+(\d{2}:\d{2}:\d{2})/);
    if (m) return new Date(`${m[3]}-${m[2]}-${m[1]}T${m[4]}+05:00`).toISOString();
  } catch { /* fall through */ }
  return null;
}

function baseTxn(bank, overrides = {}) {
  return {
    source: 'sms',
    bank,
    currency: 'PKR',
    direction: 'unknown',
    amount: null,
    fee: 0,
    sender: null,
    receiver: null,
    channel: null,
    transactionId: null,
    transactionType: null,
    accountMask: null,
    date: null,
    ...overrides,
  };
}

// ─── JazzCash patterns ──────────────────────────────────────────────────────

const JAZZCASH_RULES = [
  {
    // "Dear NAME, an amount of Rs. 350 has been successfully sent to John Roe
    //  of IBAN No: ****1234 on 2026-07-17 at 17:01:32. TID:700000000001 via RAAST"
    name: 'raast_send',
    re: /Dear\s+(.+?),\s+an amount of Rs\.?\s*([\d,]+(?:\.\d{1,2})?)\s+has been successfully sent to\s+(.+?)(?:\s+of\s+IBAN\s*No:?\s*(\S+))?\s+on\s+([\d-]+ at [\d:]+)/i,
    build: (m) => baseTxn('JazzCash', {
      direction: 'debit',
      amount: parseAmount(m[2]),
      sender: tidy(m[1]),
      receiver: tidy(m[3]),
      accountMask: m[4] ? tidy(m[4]) : null,
      date: parseDate(m[5]),
      channel: 'Raast',
      transactionType: 'Raast Send',
    }),
  },
  {
    // "Dear NAME, an amount of Rs. 500 has been credited to your account
    //  from SOMEONE on 2026-07-17 at 17:01:32. TID:..."   (shape unconfirmed)
    name: 'raast_receive',
    re: /an amount of Rs\.?\s*([\d,]+(?:\.\d{1,2})?)\s+has been (?:credited to your account|received)(?:\s+from\s+(.+?))?\s+on\s+([\d-]+ at [\d:]+)/i,
    build: (m) => baseTxn('JazzCash', {
      direction: 'credit',
      amount: parseAmount(m[1]),
      sender: m[2] ? tidy(m[2]) : null,
      date: parseDate(m[3]),
      channel: 'Raast',
      transactionType: 'Funds Received',
    }),
  },
  {
    // "Rs 500 received from NAME on 16-07-2026 at 23:56:03. TID:..."  (shape unconfirmed)
    name: 'received_short',
    re: /Rs\.?\s*([\d,]+(?:\.\d{1,2})?)\s+(?:received|credited)(?:\s+from\s+(.+?))?\s+on\s+([\d-]+ at [\d:]+)/i,
    build: (m) => baseTxn('JazzCash', {
      direction: 'credit',
      amount: parseAmount(m[1]),
      sender: m[2] ? tidy(m[2]) : null,
      date: parseDate(m[3]),
      transactionType: 'Funds Received',
    }),
  },
  {
    // "Rs 1,545.00 paid to  EXAMPLE CAFE   KARACHI    PAK    on 16-07-2026 at 23:56:03.
    //  Fee: Rs 0.00, TID:700000000002 via JazzCash Debit Card"
    name: 'card_payment',
    re: /Rs\.?\s*([\d,]+(?:\.\d{1,2})?)\s+paid to\s+(.+?)\s+on\s+([\d-]+ at [\d:]+)/i,
    build: (m) => baseTxn('JazzCash', {
      direction: 'debit',
      amount: parseAmount(m[1]),
      receiver: tidy(m[2]),
      date: parseDate(m[3]),
      channel: 'Debit Card',
      transactionType: 'Card Payment',
    }),
  },
  {
    // "Rs 1.00 charged for activation of Tap on 01-07-2026 at 05:01:44. TID:700000000003"
    name: 'charge',
    re: /Rs\.?\s*([\d,]+(?:\.\d{1,2})?)\s+charged for\s+(.+?)\s+on\s+([\d-]+ at [\d:]+)/i,
    build: (m) => baseTxn('JazzCash', {
      direction: 'debit',
      amount: parseAmount(m[1]),
      // Use the description as counterparty so the ledger shows something useful
      receiver: tidy(m[2]),
      date: parseDate(m[3]),
      channel: 'JazzCash',
      transactionType: 'Charge',
    }),
  },
];

// Placeholder — populate once real Raqami messages are available.
const RAQAMI_RULES = [];

const JAZZCASH_SENDERS = ['jazz', 'jazzcash', 'jazzpay', 'jcash', '8422'];

// ─── entry point ────────────────────────────────────────────────────────────

/**
 * @param {{ from?: string, message: string, receivedAtIso?: string }} sms
 * @returns parsed transaction object, or null if unrecognized / skipped
 */
export function parseBankSms({ from, message, receivedAtIso } = {}) {
  const body = tidy(message);
  if (!body) return null;

  const sender = (from || '').toLowerCase();
  const blob = `${sender} ${body.toLowerCase()}`;

  // UBL comes in by email already — don't double-log it from SMS.
  if (/\bubl\b|united bank/.test(blob) && !/jazzcash/.test(blob)) return null;

  const isRaqami = /raqami|raqmi/.test(blob);
  const isJazzCash = JAZZCASH_SENDERS.some(s => sender.includes(s)) || /jazzcash/.test(blob);

  let rules = null;
  if (isRaqami) rules = RAQAMI_RULES;
  else if (isJazzCash) rules = JAZZCASH_RULES;
  else rules = JAZZCASH_RULES; // unknown sender: still try, TID requirement filters junk

  for (const rule of rules) {
    const m = body.match(rule.re);
    if (!m) continue;

    const txn = rule.build(m);
    if (isRaqami) txn.bank = 'Raqami';

    // TID is both the dedup key and the "is this really a transaction" gate.
    const tid = body.match(/TID\s*:?\s*([A-Za-z0-9]+)/i);
    if (!tid) return null;
    txn.transactionId = (isRaqami ? 'RQ-' : 'JC-') + tid[1];

    const fee = body.match(/Fee\s*:?\s*Rs\.?\s*([\d,]+(?:\.\d{1,2})?)/i);
    if (fee) txn.fee = parseAmount(fee[1]);

    const via = body.match(/via\s+([A-Za-z0-9 ]+?)\s*\.?\s*$/i);
    if (via) txn.channel = tidy(via[1]);

    if (!txn.date) txn.date = receivedAtIso || new Date().toISOString();
    if (txn.amount == null) return null;

    txn.matchedRule = rule.name;
    return txn;
  }

  return null;
}
