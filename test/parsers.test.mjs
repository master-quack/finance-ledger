import test from 'node:test';
import assert from 'node:assert/strict';
import { parseEmail } from '../src/parsers/email.js';
import { parseBankSms } from '../src/parsers/sms.js';

test('NayaPay: money received', () => {
  const t = parseEmail({
    from: 'NayaPay <no-reply@nayapay.com>',
    subject: 'You got Rs. 10,000 from Jane Doe 🎉',
    text: 'NayaPay\n22 May 2026, 03:11 PM\nAmount Rs. 10,000\nTransaction ID: abc123def456',
    receivedAtIso: '2026-05-22T10:12:00Z',
  });
  assert.equal(t.bank, 'NayaPay');
  assert.equal(t.direction, 'credit');
  assert.equal(t.amount, 10000);
  assert.equal(t.sender, 'Jane Doe');
  assert.equal(t.transactionId, 'abc123def456');
  assert.equal(t.date, '2026-05-22T10:11:00.000Z'); // 3:11 PM PKT
});

test('NayaPay: ATM withdrawal splits fee from principal', () => {
  const t = parseEmail({
    from: 'nayapay', subject: 'Cash withdrawal of Rs. 1,035 🏧',
    text: 'NayaPay\nBank Name: Example Bank\nPrincipal Amount Rs. 1,000\nService Fee Rs. 35\nTotal Amount Rs. 1,035\nTransaction ID: ATM0001',
  });
  assert.equal(t.amount, 1000);
  assert.equal(t.fee, 35);
  assert.equal(t.direction, 'debit');
});

test('NayaPay: alerts that move no money are ignored', () => {
  assert.equal(parseEmail({
    from: 'nayapay', subject: 'Your ATM withdrawal failed', text: 'NayaPay Transaction ID: X1',
  }), null);
});

test('UBL: debit via Raast', () => {
  const t = parseEmail({
    from: 'admin.ebanking@ubl.com.pk', subject: 'UBL netbanking alert',
    text: 'You paid PKR. 2,500.00 to JOHN ROE via Raast.\nDate: 22-May-2026\nTime: 03:11:48 PM\nTransaction ID: UBL0000000001\nAccount Title: JANE Q DOE',
    receivedAtIso: '2026-05-22T10:12:00Z',
  });
  assert.equal(t.bank, 'UBL');
  assert.equal(t.direction, 'debit');
  assert.equal(t.amount, 2500);
  assert.equal(t.receiver, 'JOHN ROE');
  assert.equal(t.sender, 'JANE Q DOE');
  assert.equal(t.date, '2026-05-22T10:11:48.000Z');
});

test('unrelated mail is not a transaction', () => {
  assert.equal(parseEmail({ from: 'news@example.com', subject: 'Hello', text: 'Newsletter' }), null);
});

test('JazzCash SMS: card payment, TID is the dedup key', () => {
  const t = parseBankSms({
    from: 'JazzCash',
    message: 'Rs 1,545.00 paid to  EXAMPLE CAFE   KARACHI    PAK    on 16-07-2026 at 23:56:03. Fee: Rs 0.00, TID:700000000002 via JazzCash Debit Card',
  });
  assert.equal(t.bank, 'JazzCash');
  assert.equal(t.amount, 1545);
  assert.equal(t.transactionId, 'JC-700000000002');
  assert.equal(t.direction, 'debit');
});

test('SMS without a TID is rejected', () => {
  assert.equal(parseBankSms({ from: 'jazzcash', message: 'Rs 500 received from X on 16-07-2026 at 23:56:03.' }), null);
});

test('UBL SMS is skipped (UBL arrives by email)', () => {
  assert.equal(parseBankSms({ from: 'UBL', message: 'UBL: Rs 100 paid to X on 16-07-2026 at 23:56:03. TID:1' }), null);
});
