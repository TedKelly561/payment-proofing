# n8n version: payment proofing

`m4-payment-proofing.json` is an n8n workflow you can import (Workflows → Import from file).

**Every 15 minutes**

Schedule trigger → **Settings** (`shadowMode`, `alertTo`, `gmailLabel`, `doneLabel`, `windowDays`) → read the **Pay Run**, **Payees** and **Proofing Log** sheets → **Get bank emails** (Gmail, the bank label, not yet labelled done) → **Prove transfers**, a Code node that reads each email and runs the checks → four branches:

1. **Append to proofing log.** Every email gets a row: `proven`, `person`, `skipped` (or `would-prove`, `would-hold`, `would-skip` in shadow mode).
2. **Live and proven?** One item per job → **Mark job paid**: the Pay Run row gets Status `Paid`, the transfer ref, the confirmation # and a timestamp. Only proven transfers ever reach this node.
3. **Live and needs a person?** A row in **Needs a Person** (problem, why, suggested next step, jobs it might cover) and an email to `alertTo` with the failed checks and the original email.
4. **Live?** The email gets the done label, so the Gmail search skips it next time.

## The checks

The Code node uses the same functions as `../apps-script/payment-proofing.gs` (tested in Node against the demo's ten emails):

- **Payee matches**: the tech's name or a name in the Payees sheet's Known Names column, and the masked account (last 4) is the saved one.
- **Amount exact to the cent**: money is whole cents. With job numbers in the memo, the amount must equal their pay. Without, it finds the one set of the tech's jobs whose pay adds up exactly. None, or more than one: a person decides.
- **Date inside the pay window**: run date to run date + `windowDays`.
- **Reference matches**: the Pay Run's Expected Ref for that tech.
- **No job paid twice**: no job paid in an earlier run or earlier in this one, and no second transfer with the same payee, amount and ref.
- **Every job is that tech's**, and in this pay run.

## Never twice

The Gmail message ID and the bank confirmation # are checked against the Proofing Log. A confirmation the bank re-sends is logged `skipped`. Shadow-mode rows don't block the live run, so you can switch shadow mode off and the same emails are checked again for real.

## Before you turn it on

1. Replace `REPLACE_WITH_YOUR_SHEET_ID` in the Google Sheets nodes and connect your own Google Sheets and Gmail credentials. The credential IDs in the file are placeholders.
2. In Gmail, create the `Bank/Proofed` label and put its label ID in **Add done label** (`REPLACE_WITH_DONE_LABEL_ID`).
3. `settings.errorWorkflow` is a placeholder. Point it at a small "fail to a person" workflow (Error Trigger → email), so a crash still reaches someone. Every Gmail and Sheets node retries 3 times, 5 seconds apart.
4. Leave `shadowMode` on for a pay run or two. Compare the Proofing Log with your spreadsheet, then switch it off.

The sheet columns are the same as in the Apps Script version. See the header comment in `../apps-script/payment-proofing.gs`.
