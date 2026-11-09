# Gmail setup

The ledger reads your bank alerts from a Gmail mailbox using **your own** Google OAuth client, so there is no shared app and no third party holding your mail. Takes about five minutes, once. The scope requested is `gmail.readonly`.

Tip: use a dedicated Gmail address that your bank alerts are forwarded to, rather than your main inbox. The poller only searches for bank mail (`gmailQuery` in `config.json`), but a dedicated mailbox is simpler to reason about.

## 1. Create the OAuth client

1. Go to <https://console.cloud.google.com/> and create a project (any name).
2. **APIs & Services → Library** → search **Gmail API** → **Enable**.
3. **APIs & Services → OAuth consent screen** (or *Google Auth Platform*):
   - User type **External**, fill in an app name and your email.
   - Add yourself (the mailbox's address) as a **Test user**.
   - Leave the app in *Testing*. (In Testing mode Google expires the refresh token after 7 days; if you want it to last, click **Publish app**. For a personal single-user app this does not require verification, you'll just see an "unverified app" warning when you sign in.)
4. **APIs & Services → Credentials → Create credentials → OAuth client ID** → application type **Desktop app**.
5. **Download JSON** and save it as:

   ```
   ~/.config/finance-ledger/gmail-credentials.json
   ```

   ```bash
   chmod 600 ~/.config/finance-ledger/gmail-credentials.json
   ```

## 2. Sign in

```bash
ledger auth
```

Open the URL it prints, sign in with the mailbox account, approve read-only access. The page will then reach `localhost:8888`, which the command is listening on.

**Headless server / remote machine?** Run `ledger auth --manual`, open the URL on any computer, approve, and your browser will end up on a `localhost:8888/?code=...` page that fails to load. That's expected: copy the whole address from the address bar and paste it back into the terminal.

## 3. Check

```bash
ledger doctor
ledger poll
```

## Troubleshooting

- **`invalid_grant` / it stopped working after a week**: the app is still in *Testing* mode, so the token expired. Publish the app (step 1.3) and run `ledger auth` again.
- **"Access blocked: app has not completed verification"**: add the mailbox as a Test user, or publish the app.
- **Nothing is picked up**: check your bank alerts really arrive in that mailbox, then compare them with `gmailQuery` in `config.json`. Mail the parser can't read is listed under *Emails skipped* in the dashboard's health panel.
- **Gmail rate limits**: large backfills are throttled automatically; just let them finish.
