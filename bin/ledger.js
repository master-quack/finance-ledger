#!/usr/bin/env node
/**
 * ledger — command line entry point.
 *
 *   ledger init               create config + data dirs and starter files
 *   ledger auth [--manual]    sign in to Gmail (read-only)
 *   ledger run                dashboard + background poller (what the service runs)
 *   ledger serve              dashboard only
 *   ledger poll               one poll now, then exit
 *   ledger backfill YYYY-MM-DD  re-scan mail from a date
 *   ledger demo               fill the data dir with fake transactions (refuses if you have real data)
 *   ledger doctor             check that everything is set up
 *   ledger paths              print where config and data live
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  CONFIG_DIR, DATA_DIR, CONFIG_PATH, GMAIL_CREDS_PATH, GMAIL_TOKEN_PATH, ensureDirs, readConfig,
} from '../src/config.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const [cmd, ...args] = process.argv.slice(2);

function copyIfMissing(from, to, mode) {
  if (fs.existsSync(to)) return false;
  fs.copyFileSync(from, to);
  if (mode) fs.chmodSync(to, mode);
  return true;
}

async function main() {
  switch (cmd) {
    case 'init': {
      ensureDirs();
      const made = [
        copyIfMissing(path.join(ROOT, 'examples/config.example.json'), CONFIG_PATH, 0o600) && CONFIG_PATH,
        copyIfMissing(path.join(ROOT, 'examples/contacts.example.json'), path.join(DATA_DIR, 'contacts.json')) && path.join(DATA_DIR, 'contacts.json'),
      ].filter(Boolean);
      console.log(made.length ? 'Created:\n  ' + made.join('\n  ') : 'Nothing to create - already initialised.');
      console.log(`\nNext:\n  1. Follow docs/GMAIL_SETUP.md and save the OAuth JSON to\n     ${GMAIL_CREDS_PATH}\n  2. ledger auth\n  3. Edit ${path.join(DATA_DIR, 'contacts.json')} (your name as your bank prints it)\n  4. ledger run`);
      break;
    }
    case 'auth': {
      const { authorize } = await import('../src/gmailAuth.js');
      await authorize({ manual: args.includes('--manual') });
      break;
    }
    case 'run': {
      const { startServer } = await import('../src/server.js');
      const { startPoller } = await import('../src/ledger.js');
      startServer();
      startPoller();
      break;
    }
    case 'serve': {
      const { startServer } = await import('../src/server.js');
      startServer();
      break;
    }
    case 'poll': {
      const { pollEmails } = await import('../src/ledger.js');
      console.log(await pollEmails());
      break;
    }
    case 'backfill': {
      const since = new Date(args[0] || '');
      if (!args[0] || Number.isNaN(since.getTime())) {
        console.error('Usage: ledger backfill YYYY-MM-DD');
        process.exit(1);
      }
      const { pollEmails } = await import('../src/ledger.js');
      console.log(await pollEmails({ since }));
      break;
    }
    case 'demo': {
      ensureDirs();
      const txnPath = path.join(DATA_DIR, 'transactions.json');
      if (fs.existsSync(txnPath) && JSON.parse(fs.readFileSync(txnPath, 'utf8') || '[]').length) {
        console.error(`Refusing: ${txnPath} already has transactions. Use a scratch dir:\n  LEDGER_DATA_DIR=/tmp/ledger-demo LEDGER_CONFIG_DIR=/tmp/ledger-demo-cfg ledger demo`);
        process.exit(1);
      }
      fs.copyFileSync(path.join(ROOT, 'examples/demo-transactions.json'), txnPath);
      copyIfMissing(path.join(ROOT, 'examples/contacts.example.json'), path.join(DATA_DIR, 'contacts.json'));
      if (!fs.existsSync(CONFIG_PATH)) {
        fs.writeFileSync(CONFIG_PATH, JSON.stringify({
          startingBalances: { NayaPay: 20000, UBL: 50000 }, balanceAsOf: '2026-01-01T00:00:00Z',
        }, null, 2));
      }
      console.log(`Demo data written to ${DATA_DIR}\nRun: ledger serve   then open http://localhost:${readConfig().dashboardPort}`);
      break;
    }
    case 'doctor': {
      const ok = (c, msg) => console.log(`${c ? 'ok  ' : 'FAIL'} ${msg}`);
      const major = Number(process.versions.node.split('.')[0]);
      ok(major >= 20, `Node ${process.versions.node} (need 20+)`);
      ok(fs.existsSync(CONFIG_PATH), `config  ${CONFIG_PATH}`);
      ok(fs.existsSync(path.join(DATA_DIR, 'contacts.json')), `contacts ${path.join(DATA_DIR, 'contacts.json')}`);
      ok(fs.existsSync(GMAIL_CREDS_PATH), `Gmail OAuth client ${GMAIL_CREDS_PATH}`);
      ok(fs.existsSync(GMAIL_TOKEN_PATH), `Gmail token  ${GMAIL_TOKEN_PATH}  (run: ledger auth)`);
      break;
    }
    case 'paths':
      console.log(`config: ${CONFIG_DIR}\ndata:   ${DATA_DIR}`);
      break;
    default:
      console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0].replace(/^#!.*\n\/\*\*\n?/, '').replace(/^ \* ?/gm, ''));
      process.exit(cmd ? 1 : 0);
  }
}

main().catch(err => { console.error(err.message); process.exit(1); });
