import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';

// Must be set before the modules load: they read these at import time.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-test-'));
process.env.LEDGER_DATA_DIR = path.join(tmp, 'data');
process.env.LEDGER_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.LEDGER_DATA_DIR, { recursive: true });
fs.mkdirSync(process.env.LEDGER_CONFIG_DIR, { recursive: true });
fs.writeFileSync(path.join(process.env.LEDGER_DATA_DIR, 'contacts.json'), JSON.stringify({
  self: ['JANE Q DOE'], Mom: ['SAM SMITH'], Dad: ['SMITH'],
}));
fs.writeFileSync(path.join(process.env.LEDGER_CONFIG_DIR, 'config.json'), JSON.stringify({
  startingBalances: { NayaPay: 1000 }, balanceAsOf: '2026-01-01T00:00:00Z', smsSecret: 's3cret',
}));

const L = await import('../src/ledger.js');
const { startServer } = await import('../src/server.js');

test('labels match whole words in any order, and prefer the first-named', () => {
  const idx = L.buildLabelIndex();
  assert.equal(L.matchLabel('DOE JANE Q', idx), 'self');
  assert.equal(L.matchLabel('Sam Smith', idx), 'Mom'); // not Dad
  assert.equal(L.matchLabel('SAMUEL', idx), null);
});

test('a move between your own accounts is an internal transfer', () => {
  const t = L.enrich({ direction: 'credit', sender: null, receiver: null }, L.buildLabelIndex());
  assert.equal(t.type, 'credit'); // unnamed receiver => self, but sender unknown
  const t2 = L.enrich({ direction: 'credit', sender: 'JANE DOE Q', receiver: null }, L.buildLabelIndex());
  assert.equal(t2.type, 'internal_transfer');
});

test('SMS ingest logs once and dedupes by TID', () => {
  const sms = { from: 'JazzCash', message: 'Rs 100.00 paid to SHOP on 16-07-2026 at 10:00:00. Fee: Rs 0.00, TID:42 via JazzCash Debit Card' };
  assert.equal(L.ingestBankSms(sms).logged, true);
  const again = L.ingestBankSms(sms);
  assert.equal(again.logged, false);
  assert.equal(again.reason, 'duplicate');
});

test('balances: start + credits - debits - fees', () => {
  const file = path.join(process.env.LEDGER_DATA_DIR, 'transactions.json');
  fs.writeFileSync(file, JSON.stringify([
    { bank: 'NayaPay', direction: 'credit', amount: 500, date: '2026-02-01T00:00:00Z' },
    { bank: 'NayaPay', direction: 'debit', amount: 200, fee: 10, date: '2026-02-02T00:00:00Z' },
    { bank: 'NayaPay', direction: 'debit', amount: 999, date: '2025-12-31T00:00:00Z' }, // before the start date
  ]));
  assert.equal(L.calculateBalances().balances.NayaPay, 1290);
});

test('server: loopback only, JSON-only writes, SMS needs the secret', async () => {
  const cfgPath = path.join(process.env.LEDGER_CONFIG_DIR, 'config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  cfg.dashboardPort = 17780;
  fs.writeFileSync(cfgPath, JSON.stringify(cfg));
  const server = startServer();
  await new Promise(r => server.once('listening', r));
  const base = 'http://127.0.0.1:17780';
  try {
    assert.equal((await fetch(base + '/health')).status, 200);

    // DNS-rebinding style Host header
    const badStatus = await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port: 17780, path: '/health', headers: { Host: 'evil.example' } },
        res => { res.resume(); resolve(res.statusCode); }).on('error', reject);
    });
    assert.equal(badStatus, 403);

    // simple cross-site POST (text/plain) must be refused
    const csrf = await fetch(base + '/api/alias', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{"name":"x","alias":"y"}' });
    assert.equal(csrf.status, 415);

    const json = { 'content-type': 'application/json' };
    const noSecret = await fetch(base + '/api/sms', { method: 'POST', headers: json, body: '{"message":"hi"}' });
    assert.equal(noSecret.status, 401);
    const ok = await fetch(base + '/api/sms', { method: 'POST', headers: { ...json, 'x-ledger-secret': 's3cret' }, body: '{"message":"not a bank sms"}' });
    assert.equal(ok.status, 200);
  } finally {
    server.close();
  }
});
