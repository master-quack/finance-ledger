/**
 * server.js — the dashboard + JSON API.
 *
 *   GET  /                  dashboard
 *   GET  /health            liveness
 *   GET  /api/transactions  /api/balances  /api/contacts  /api/aliases
 *        /api/debts  /api/categories  /api/health
 *   POST /api/alias    { name, alias }
 *   POST /api/debt     { txnId, person, amount, note, settled }
 *   POST /api/category { name, category }
 *   POST /api/balance  { bank, amount }
 *   POST /api/sms      { from, message }   needs header x-ledger-secret
 *
 * There is no login. It binds to 127.0.0.1 unless you change dashboardBind, and
 * it refuses requests whose Host header isn't a loopback name (DNS rebinding)
 * while bound to loopback. Writes must be application/json, which a browser
 * can't send cross-origin without a preflight we never answer (CSRF).
 */
import http from 'http';
import fs from 'fs';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import { readConfig } from './config.js';
import {
  readTransactions, calculateBalances, getContacts, readAliases, setAlias,
  readDebts, upsertDebt, readCategories, setCategory, setBalanceAnchor,
  getHealth, ingestBankSms,
} from './ledger.js';

const HTML_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '../public/index.html');

const isLoopback = bind => ['127.0.0.1', 'localhost', '::1'].includes(bind);

function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', c => { raw += c; if (raw.length > 1e6) { req.destroy(); reject(new Error('body too large')); } });
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function secretMatches(given, expected) {
  const a = Buffer.from(String(given || ''));
  const b = Buffer.from(String(expected || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function startServer() {
  const config = readConfig();
  const port = config.dashboardPort;
  const bind = config.dashboardBind;

  if (!isLoopback(bind)) {
    console.warn(`[ledger] WARNING: dashboard bound to ${bind} with no login. Only do this on a network you trust.`);
  }

  const server = http.createServer(async (req, res) => {
    try {
      if (isLoopback(bind)) {
        const host = String(req.headers.host || '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
        if (!['localhost', '127.0.0.1', '::1'].includes(host)) return sendJson(res, 403, { error: 'bad host' });
      }
      const url = req.url.split('?')[0];

      if (req.method === 'GET') {
        if (url === '/health') return sendJson(res, 200, { ok: true, service: 'finance-ledger' });
        if (url === '/api/transactions') return sendJson(res, 200, { transactions: readTransactions() });
        if (url === '/api/balances') return sendJson(res, 200, calculateBalances());
        if (url === '/api/contacts') return sendJson(res, 200, { contacts: getContacts() });
        if (url === '/api/aliases') return sendJson(res, 200, { aliases: readAliases() });
        if (url === '/api/debts') return sendJson(res, 200, { debts: readDebts() });
        if (url === '/api/categories') return sendJson(res, 200, { categories: readCategories() });
        if (url === '/api/health') return sendJson(res, 200, getHealth());
        if (url === '/' || url === '/index.html') {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          return res.end(fs.readFileSync(HTML_PATH, 'utf8'));
        }
        return sendJson(res, 404, { error: 'not found' });
      }

      if (req.method === 'POST') {
        if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) {
          return sendJson(res, 415, { error: 'content-type must be application/json' });
        }

        if (url === '/api/sms') {
          const secret = readConfig().smsSecret;
          if (!secret) return sendJson(res, 404, { error: 'SMS ingest is disabled (set smsSecret in config.json)' });
          if (!secretMatches(req.headers['x-ledger-secret'], secret)) return sendJson(res, 401, { error: 'bad secret' });
          const body = await readBody(req);
          if (!body.message) return sendJson(res, 400, { error: 'message required' });
          return sendJson(res, 200, ingestBankSms({ from: body.from, message: body.message }));
        }

        const body = await readBody(req);
        if (url === '/api/alias') {
          if (!body.name) return sendJson(res, 400, { error: 'name required' });
          return sendJson(res, 200, setAlias(body.name, body.alias));
        }
        if (url === '/api/debt') {
          if (!body.txnId) return sendJson(res, 400, { error: 'txnId required' });
          return sendJson(res, 200, upsertDebt(body));
        }
        if (url === '/api/category') {
          if (!body.name) return sendJson(res, 400, { error: 'name required' });
          return sendJson(res, 200, setCategory(body.name, body.category));
        }
        if (url === '/api/balance') {
          const { bank, amount } = body;
          if (!(bank in calculateBalances().balances)) return sendJson(res, 400, { error: 'unknown account' });
          if (typeof amount !== 'number' || !Number.isFinite(amount)) return sendJson(res, 400, { error: 'amount must be a number' });
          return sendJson(res, 200, setBalanceAnchor(bank, Math.round(amount * 100) / 100));
        }
        return sendJson(res, 404, { error: 'unknown route' });
      }

      sendJson(res, 405, { error: 'method not allowed' });
    } catch (err) {
      console.error('[ledger] handler error:', err.message);
      sendJson(res, 500, { error: err.message });
    }
  });

  server.on('error', err => console.error('[ledger] server error:', err.message));
  server.listen(port, bind, () => console.log(`[ledger] dashboard on http://${bind}:${port}`));
  return server;
}
