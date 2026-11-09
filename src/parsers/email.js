/**
 * email.js — parses UBL + NayaPay transaction alert emails.
 *
 * Handles both direct emails and Outlook-forwarded copies (FW: subjects,
 * forwarded headers in body). Classification is content-based, not
 * sender-based, so forwarding doesn't break anything.
 */

// ─── helpers ────────────────────────────────────────────────────────────────

export function htmlToText(html) {
  if (!html) return '';
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6]|td)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#8226;|&bull;/gi, '•')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

/**
 * Strips emoji, variation selectors and ZWJ from a captured name, then tidies
 * whitespace and trailing punctuation. NayaPay decorates subject lines with
 * different emoji per transaction type (🎉 incoming, 💸 outgoing, …), so
 * matching a fixed list is fragile — remove the whole pictographic range.
 */
export function cleanName(name) {
  return (name || '')
    .replace(/[\p{Extended_Pictographic}\u200D\uFE0F\u{1F3FB}-\u{1F3FF}]/gu, '')
    .replace(/\s+/g, ' ')
    .replace(/[\s,.\-–—]+$/, '')
    .trim();
}

export function normalizeName(name) {
  return (name || '')
    .toUpperCase()
    .replace(/[^A-Z ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseAmount(str) {
  const n = parseFloat(String(str).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

const MONTHS = {
  JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5,
  JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11,
};

/** "22-May-2026" + "03:11:48 PM"  →  ISO string (PKT assumed) */
function parseUblDateTime(dateStr, timeStr) {
  try {
    const [d, mon, y] = dateStr.split('-');
    let [hms, ampm] = (timeStr || '12:00:00 PM').trim().split(/\s+/);
    let [h, m, s] = hms.split(':').map(Number);
    if (/PM/i.test(ampm) && h !== 12) h += 12;
    if (/AM/i.test(ampm) && h === 12) h = 0;
    const dt = new Date(Date.UTC(+y, MONTHS[mon.slice(0, 3).toUpperCase()], +d, h, m || 0, s || 0));
    dt.setUTCHours(dt.getUTCHours() - 5); // PKT → UTC
    return dt.toISOString();
  } catch {
    return null;
  }
}

/** "22 May 2026, 03:11 PM"  →  ISO string (PKT assumed) */
function parseNayaPayDateTime(str) {
  try {
    const m = str.match(/(\d{1,2})\s+(\w{3,})\s+(\d{4}),?\s+(\d{1,2}):(\d{2})\s*(AM|PM)/i);
    if (!m) return null;
    let [, d, mon, y, h, min, ampm] = m;
    h = +h;
    if (/PM/i.test(ampm) && h !== 12) h += 12;
    if (/AM/i.test(ampm) && h === 12) h = 0;
    const dt = new Date(Date.UTC(+y, MONTHS[mon.slice(0, 3).toUpperCase()], +d, h, +min));
    dt.setUTCHours(dt.getUTCHours() - 5); // PKT → UTC
    return dt.toISOString();
  } catch {
    return null;
  }
}

// ─── UBL ────────────────────────────────────────────────────────────────────

export function parseUbl(text, receivedAtIso) {
  const txn = {
    source: 'ubl',
    bank: 'UBL',
    currency: 'PKR',
    direction: 'unknown',
    amount: null,
    fee: null,
    sender: null,
    receiver: null,
    channel: null,
    transactionId: null,
    transactionType: null,
    accountMask: null,
    date: null,
  };

  // "You paid PKR. 10,000.00 to JANE Q DOE via Raast."
  let m = text.match(/You\s+paid\s+PKR\.?\s*([\d,]+(?:\.\d{1,2})?)\s+to\s+(.+?)\s+via\s+([A-Za-z0-9 ]+?)\s*[.\n]/i);
  if (m) {
    txn.direction = 'debit';
    txn.amount = parseAmount(m[1]);
    txn.receiver = cleanName(m[2]);
    txn.channel = m[3].trim();
  }

  // Credit variant (e.g. "You received PKR. X from NAME via Raast.")
  if (!m) {
    m = text.match(/You\s+(?:received|got)\s+PKR\.?\s*([\d,]+(?:\.\d{1,2})?)\s+from\s+(.+?)(?:\s+via\s+([A-Za-z0-9 ]+?))?\s*[.\n]/i);
    if (m) {
      txn.direction = 'credit';
      txn.amount = parseAmount(m[1]);
      txn.sender = cleanName(m[2]);
      txn.channel = (m[3] || '').trim() || null;
    }
  }

  const title = text.match(/Account\s+Title:\s*(.+)/i);
  if (title) {
    const accountHolder = title[1].trim();
    if (txn.direction === 'debit' && !txn.sender) txn.sender = accountHolder;
    if (txn.direction === 'credit' && !txn.receiver) txn.receiver = accountHolder;
  }

  const mask = text.match(/(\d{2}\*+\d{2})/);
  if (mask) txn.accountMask = mask[1];

  const date = text.match(/Date:\s*([\d]{1,2}-[A-Za-z]{3,}-\d{4})/);
  const time = text.match(/Time:\s*([\d:]+\s*[AP]M)/i);
  if (date) txn.date = parseUblDateTime(date[1], time ? time[1] : null);

  const tid = text.match(/Transaction\s+ID:\s*([A-Za-z0-9]+)/i);
  if (tid) txn.transactionId = tid[1];

  const ttype = text.match(/Transaction\s+Type:\s*(.+)/i);
  if (ttype) txn.transactionType = ttype[1].trim();

  if (!txn.date) txn.date = receivedAtIso || new Date().toISOString();
  if (txn.amount == null || !txn.transactionId) return null;
  return txn;
}

// ─── NayaPay ────────────────────────────────────────────────────────────────

function nayaPayField(text, label) {
  const m = text.match(new RegExp(String.raw`${label}\s*:?\s*([^\n]+)`, 'i'));
  const v = m ? cleanName(m[1]) : '';
  return v && v !== '-' ? v : null;
}

/**
 * The payee NayaPay prints above the kind + date lines of a receipt, e.g.
 *   "Ufone\n\nMobile Top-Up\n\n02 Jul 2026, 11:18 PM"  →  "Ufone"
 */
function nayaPayHeadline(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(l => l && !/^\[.*\]$/.test(l));
  const i = lines.findIndex(l => /^\d{1,2}\s+\w{3,}\s+\d{4},?\s+\d{1,2}:\d{2}\s*[AP]M$/i.test(l));
  return i >= 2 ? cleanName(lines[i - 2]) : null;
}

const NP_AMT = String.raw`Rs\.?\s*([\d,]+(?:\.\d{1,2})?)`;

/**
 * One rule per NayaPay subject line. The subject says what happened; the body
 * fills in amounts, fees and IDs (handled once, after the rule runs).
 * Order matters only where two patterns could overlap.
 */
const NAYAPAY_RULES = [
  { // "You got Rs. 10,000 from Jane Doe 🎉"
    re: new RegExp(String.raw`^You\s+got\s+${NP_AMT}\s+from\s+(.+)`, 'i'),
    build: m => ({ direction: 'credit', amount: parseAmount(m[1]), sender: cleanName(m[2]) }),
  },
  { // "Sam Smith paid Rs. 732 for your Foodpanda … Bill Split👫"
    re: new RegExp(String.raw`^(.+?)\s+paid\s+${NP_AMT}\s+for\s+your\s+(.+?)\s+Bill\s+Split`, 'i'),
    build: m => ({ direction: 'credit', amount: parseAmount(m[2]), sender: cleanName(m[1]), transactionType: 'Bill Split' }),
  },
  { // "You paid your StormFiber bill for the month ✅"
    re: /^You\s+paid\s+your\s+(.+?)\s+bill\b/i,
    build: (m, text) => ({
      direction: 'debit',
      receiver: nayaPayField(text, 'Destination\\s+Acc\\.?\\s+Title') || cleanName(m[1]),
      transactionType: 'Bill Payment',
    }),
  },
  { // "You sent Rs. 500 to John Roe 💸" / "You paid Rs. 18,000 to Example Airline ✈️"
    re: new RegExp(String.raw`^You\s+(?:paid|sent)\s+${NP_AMT}\s+to\s+(.+)`, 'i'),
    build: m => ({ direction: 'debit', amount: parseAmount(m[1]), receiver: cleanName(m[2]) }),
  },
  { // "You spent Rs. 1,500 at Example Cafe Karachi … PK 💳"
    re: new RegExp(String.raw`^You\s+spent\s+${NP_AMT}\s+at\s+(.+)`, 'i'),
    build: (m, text) => ({
      direction: 'debit',
      amount: parseAmount(m[1]),
      receiver: nayaPayField(text, 'Merchant\\s+Details') || cleanName(m[2]),
      channel: 'Card',
      transactionType: 'Card Payment',
    }),
  },
  { // "You subscribed to a mobile bundle of Rs. 350 📱" / "You topped up your mobile balance with Rs. 150 📱"
    re: new RegExp(String.raw`^You\s+(?:subscribed\s+to\s+a\s+mobile\s+bundle\s+of|topped\s+up\s+your\s+mobile\s+balance\s+with)\s+${NP_AMT}`, 'i'),
    build: (m, text) => ({
      direction: 'debit',
      amount: parseAmount(m[1]),
      receiver: nayaPayHeadline(text) || 'Mobile Top-Up',
      transactionType: 'Mobile Top-Up',
    }),
  },
  { // "You recharged your M-Tag with Rs. 500 🚘"
    re: new RegExp(String.raw`^You\s+recharged\s+your\s+M-Tag\s+with\s+${NP_AMT}`, 'i'),
    build: (m, text) => ({
      direction: 'debit',
      amount: parseAmount(m[1]),
      receiver: nayaPayField(text, 'Destination\\s+Acc\\.?\\s+Title') || 'M-Tag',
      transactionType: 'M-Tag Recharge',
    }),
  },
  { // "Cash withdrawal of Rs. 1,035 🏧"   (subject shows the total; body has the split)
    re: new RegExp(String.raw`^Cash\s+withdrawal\s+of\s+${NP_AMT}`, 'i'),
    build: (m, text) => ({
      direction: 'debit',
      receiver: `ATM ${nayaPayField(text, 'Bank\\s+Name') || ''}`.trim(),
      channel: 'ATM',
      transactionType: 'Cash Withdrawal',
    }),
  },
  { // "Transaction at CANVA* … US reversed"
    re: /^Transaction\s+at\s+(.+?)\s+reversed$/i,
    build: m => ({ direction: 'credit', sender: cleanName(m[1]), channel: 'Card', transactionType: 'Reversal' }),
  },
  { // "Refund for your transaction at APPLE.COM/BILL"
    re: /^Refund\s+for\s+your\s+transaction\s+at\s+(.+)/i,
    build: m => ({ direction: 'credit', sender: cleanName(m[1]), channel: 'Card', transactionType: 'Refund' }),
  },
  { // "Mobile Top-Up reversed"
    re: /^Mobile\s+Top-Up\s+reversed/i,
    build: (m, text) => ({ direction: 'credit', sender: nayaPayHeadline(text) || 'Mobile Top-Up', transactionType: 'Reversal' }),
  },
  { // "Inward Foreign Remittance" — sender lives in "Source Bank: NAME/Bank"
    re: /^Inward\s+Foreign\s+Remittance/i,
    build: (m, text) => {
      const src = nayaPayField(text, 'Source\\s+Bank') || '';
      const [name, bank] = src.split('/');
      return {
        direction: 'credit',
        sender: cleanName(name) || null,
        transactionType: `Foreign Remittance${bank ? ` via ${bank.trim()}` : ''}`,
      };
    },
  },
];

export function parseNayaPay(text, subject, receivedAtIso) {
  const txn = {
    source: 'nayapay',
    bank: 'NayaPay',
    currency: 'PKR',
    direction: 'unknown',
    amount: null,
    fee: null,
    sender: null,
    receiver: null,
    channel: null,
    transactionId: null,
    transactionType: null,
    accountMask: null,
    date: null,
  };

  const subj = cleanName((subject || '').replace(/^(FW|FWD|RE):\s*/i, ''));

  // Alerts that move no money: a declined ATM attempt, a card being saved at a
  // merchant, a bill that has arrived but not been paid.
  if (/\bfailed\b|Card\s+Authorization|new\s+bill\s+from/i.test(subj)) return null;

  const rule = NAYAPAY_RULES.find(r => r.re.test(subj));
  if (rule) {
    const m = subj.match(rule.re);
    Object.assign(txn, rule.build(m, text));
  } else {
    // Fallback for subjects we haven't seen: the old body-text phrasing.
    let m = text.match(new RegExp(String.raw`You\s+got\s+${NP_AMT}\s+from\s+([A-Za-z .'-]+)`, 'i'));
    if (m) Object.assign(txn, { direction: 'credit', amount: parseAmount(m[1]), sender: cleanName(m[2]) });
    m = !m && text.match(new RegExp(String.raw`You\s+(?:paid|sent)\s+${NP_AMT}\s+to\s+([A-Za-z .'-]+)`, 'i'));
    if (m) Object.assign(txn, { direction: 'debit', amount: parseAmount(m[1]), receiver: cleanName(m[2]) });
  }

  // The body's principal is the real amount; the subject line sometimes shows
  // the total instead (ATM: "Cash withdrawal of Rs. 1,035" = 1,000 + 35 fee).
  // Whatever separates principal from total is the fee — that covers the
  // service fee and the international card charges (FX, SST) alike, so
  // balances subtract exactly what left the wallet.
  const principal = text.match(new RegExp(String.raw`(?:Principal\s+Amount|Transaction\s+Amount|Amount\s+(?:Withdrawn|Sent|Received|Paid)|Total\s+amount\s+refunded)\s*${NP_AMT}`, 'i'));
  const total = text.match(new RegExp(String.raw`Total\s+Amount\s*${NP_AMT}`, 'i'));
  if (principal) txn.amount = parseAmount(principal[1]);
  else if (total && txn.amount == null) txn.amount = parseAmount(total[1]);

  const fee = text.match(new RegExp(String.raw`Service\s+Fee[^R]*${NP_AMT}`, 'i'));
  txn.fee = fee ? parseAmount(fee[1]) : 0;
  if (principal && total) {
    const diff = Math.round((parseAmount(total[1]) - txn.amount) * 100) / 100;
    if (diff > 0) txn.fee = diff;
  }
  // A reversal / refund returns the whole charge, fees included, and costs nothing.
  if (/reversed|Refund/i.test(subj)) {
    if (total) txn.amount = parseAmount(total[1]);
    txn.fee = 0;
  }

  // Refunds and reversals carry both the original ("Reference Transaction ID")
  // and their own. A card reversal's own ID is the charge's 6-digit ID again,
  // so prefix it — otherwise dedup-by-ID throws the refund away.
  // Transaction ID can wrap across lines: "UBL0000000000000000001 23"
  const revTid = text.match(/(?:Reversal|Refund)\s+Transaction\s+ID\s*:?\s*([A-Z0-9]+)/i);
  const tid = text.match(/(?<!Reference\s+)Transaction\s+ID\s*:?\s*([A-Z0-9]+(?:\s+\d+)?)/i);
  if (revTid) txn.transactionId = `REV-${revTid[1]}`;
  else if (tid) txn.transactionId = tid[1].replace(/\s+/g, '');

  const srcTitle = text.match(/Source\s+Acc\.?\s+Title\s*:?\s*([A-Za-z .'-]+)/i);
  if (srcTitle && !txn.sender) txn.sender = cleanName(srcTitle[1]);

  const dstTitle = text.match(/Destination\s+Acc\.?\s+Title\s*:?\s*([A-Za-z .'-]+)/i);
  if (dstTitle && !txn.receiver) txn.receiver = cleanName(dstTitle[1]);

  const srcBank = text.match(/Source\s+Bank\s*:?\s*([A-Za-z ]+)/i);
  if (srcBank && !txn.transactionType) txn.transactionType = `From ${srcBank[1].trim()}`;

  const channel = text.match(/Channel\s*:?\s*([A-Za-z0-9 ]+)/i);
  if (channel) txn.channel = channel[1].trim();

  const date = text.match(/(\d{1,2}\s+\w{3,}\s+\d{4},?\s+\d{1,2}:\d{2}\s*[AP]M)/i);
  if (date) txn.date = parseNayaPayDateTime(date[1]);

  if (!txn.date) txn.date = receivedAtIso || new Date().toISOString();
  if (txn.amount == null || !txn.transactionId) return null;
  return txn;
}

// ─── classify + parse entry point ───────────────────────────────────────────

/**
 * @param {{from: string, subject: string, html: string, text: string, receivedAtIso: string}} email
 * @returns parsed txn object or null if not a recognizable bank alert
 */
export function parseEmail(email) {
  const text = email.text || htmlToText(email.html);
  const blob = `${email.from}\n${email.subject}\n${text}`;

  const isNayaPay = /nayapay/i.test(blob) && /Transaction\s+ID/i.test(text);
  const isUbl = /UBL\s*netbanking|admin\.ebanking@ubl/i.test(blob) || /You\s+paid\s+PKR/i.test(text);

  if (isNayaPay) return parseNayaPay(text, email.subject, email.receivedAtIso);
  if (isUbl) return parseUbl(text, email.receivedAtIso);
  return null;
}
