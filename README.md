# finance-ledger

A small self-hosted ledger that reads your bank alert emails (and optionally SMS), turns them into a local `transactions.json`, and shows them in a web dashboard: balances per account, who you paid, categories, and money people owe you.

- Runs on any Linux box with Node 20+. No database, no cloud service, no build step.
- Your data stays on your machine, in plain JSON files outside this repo.
- Gmail access is **read-only**, using your own Google OAuth client.
- Built for Pakistani banks: **NayaPay** and **UBL** (email), **JazzCash** (SMS). Parsers live in `src/parsers/` and are easy to extend.

## Install

```bash
git clone <this repo> finance-ledger
cd finance-ledger
./scripts/install.sh            # add --service for a systemd user service
```

Then:

```bash
ledger doctor        # shows what's left to set up
```

Want to look around first? Try it with fake data in throwaway folders:

```bash
LEDGER_DATA_DIR=/tmp/ld LEDGER_CONFIG_DIR=/tmp/lc ledger demo
LEDGER_DATA_DIR=/tmp/ld LEDGER_CONFIG_DIR=/tmp/lc ledger serve   # http://localhost:7780
```

## Set up

1. **Gmail**: follow [docs/GMAIL_SETUP.md](docs/GMAIL_SETUP.md) (about five minutes), then run `ledger auth`. On a headless server use `ledger auth --manual`.
2. **Get alerts into that mailbox.** Turn on email alerts in the NayaPay and UBL apps. If they go to a different address, set up auto-forwarding to the Gmail account you authorised.
3. **Tell it who you are.** Edit `~/.local/share/finance-ledger/contacts.json` and put your name as the bank prints it under `self`. That's how a transfer between your own accounts is recognised instead of counting as spending. Add other people (`"Mom": ["SAM SMITH"]`) to get labels.
4. **Starting balances (optional).** Put them in `config.json` (`startingBalances` + `balanceAsOf`), or just type the real balance into the dashboard later.
5. **Run it.** `ledger run`, or `systemctl --user start finance-ledger` if you installed the service. Open <http://localhost:7780>.

## Commands

| Command | What it does |
|---|---|
| `ledger init` | Create config/data folders and starter files |
| `ledger auth [--manual]` | Sign in to Gmail |
| `ledger run` | Dashboard + background poller |
| `ledger serve` | Dashboard only |
| `ledger poll` | One poll now |
| `ledger backfill 2026-01-01` | Re-scan mail from a date |
| `ledger doctor` | Check setup |
| `ledger paths` | Show where config and data live |

## Where things live

| | Default | Override |
|---|---|---|
| Config + Google credentials | `~/.config/finance-ledger/` | `LEDGER_CONFIG_DIR` |
| Ledger data | `~/.local/share/finance-ledger/` | `LEDGER_DATA_DIR` |

Back up the data folder; it is the whole ledger. Nothing personal is stored in the repo, so `git pull` to update is always safe.

Settings (`config.json`): `pollIntervalMinutes`, `lookbackDays`, `dashboardPort`, `dashboardBind`, `gmailQuery` (which mail to read, Gmail search syntax), `startingBalances`, `balanceAsOf`, `smsSecret`. See `examples/config.example.json`.

## Security

- The dashboard has **no login**. It binds to `127.0.0.1` by default and rejects foreign `Host` headers and non-JSON writes. To reach it from your phone, put it behind something you already trust (Tailscale, a LAN you control, an SSH tunnel) and set `dashboardBind` deliberately. **Never put it on the public internet.**
- Google credentials and the token are stored with owner-only permissions in the config dir. The token can only read mail.
- Don't commit your `config.json`, `contacts.json` or `transactions.json`. They are in `.gitignore`, and they live outside the repo anyway.

## SMS ingest (JazzCash)

Bank SMS can be pushed from an Android phone with an automation app (MacroDroid, Tasker). Set a long random `smsSecret` in `config.json`, then have the app POST each bank SMS:

```
POST http://<host>:7780/api/sms
Content-Type: application/json
x-ledger-secret: <your smsSecret>

{"from": "JazzCash", "message": "<sms text>"}
```

With an empty `smsSecret` the endpoint is disabled. Anything that isn't a recognised bank SMS is ignored, and repeats are deduplicated by transaction ID. The phone must be able to reach the server, so this is another reason to run it on a private network.

## Adding a bank

Parsers are pure functions: `parseEmail()` in `src/parsers/email.js` and `parseBankSms()` in `src/parsers/sms.js`. Each returns a transaction object (`bank`, `direction`, `amount`, `fee`, `sender`, `receiver`, `transactionId`, `date`, ...) or `null`. Add a rule, add a test in `test/parsers.test.mjs` using a **made-up** sample (never paste a real alert into the repo), and `npm test`.

## Tests

```bash
npm test
```

## License

MIT, see [LICENSE](LICENSE).
