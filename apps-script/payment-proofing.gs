/**
 * Summit Home Services: payment proofing for contractor pay (Google Apps Script)
 * ------------------------------------------------------------------------------
 * What it does, every 15 minutes:
 *   1. Finds bank transfer confirmation emails under a Gmail label (GmailApp.search).
 *   2. Reads each one: amount, payee, masked account, reference, date, memo, confirmation #.
 *   3. Proves it against the "Pay Run" sheet with the same checks as the demo:
 *        payee (known-names table + saved account), amount exact to the cent,
 *        date inside the pay window, reference, no job paid twice, every job is that tech's.
 *   4. Proven: marks those rows Paid with the transfer ref, confirmation # and a timestamp.
 *      Anything else: a row in "Needs a Person" and an email to a person. Nothing is
 *      marked paid on a guess.
 *
 * Safety rules it follows:
 *   - Shadow mode (SHADOW_MODE=true, the default): checks everything, writes "would-prove" /
 *     "would-hold" to the Proofing Log, changes nothing else and emails nobody.
 *   - Money is whole cents (integers). "$1,240.00" → 124000. No floating-point dollars.
 *   - Without a memo listing job numbers, it finds the ONE set of the tech's jobs whose pay adds
 *     up to the amount. None, or more than one: a person decides.
 *   - Same email never processed twice: the Gmail message ID and the bank confirmation # are
 *     both checked against the Proofing Log. A re-sent confirmation is skipped.
 *   - A second transfer with the same payee, amount and ref (new confirmation #) is held as a
 *     possible double payment. So is any job already paid in an earlier run.
 *   - A lock stops two runs overlapping. Any error is caught, logged and emailed to ALERT_TO.
 *
 * Setup (about 15 minutes):
 *   1. In Gmail, make a filter that labels your bank's transfer confirmations "Bank/Transfers".
 *   2. Open the Google Sheet → Extensions → Apps Script. Paste this file.
 *   3. Project Settings → Script properties:
 *        SHADOW_MODE   true                 (switch to false after a pay run or two)
 *        ALERT_TO      office@example.com   (who gets Needs a person and error emails)
 *        GMAIL_LABEL   Bank/Transfers       (optional; this is the default)
 *        DONE_LABEL    Bank/Proofed         (optional; added once an email is handled live)
 *        WINDOW_DAYS   4                    (optional; transfers dated run day .. run day + 4)
 *   4. Run installTrigger() once and approve the permissions.
 *
 * Sheet layouts (row 1 = headers, names must match; extra columns are ignored):
 *   Pay Run:         Job ID | Tech | Completed | Revenue | Pay | Expected Ref | Run Date | Status |
 *                    Paid Ref | Confirmation | Paid At
 *                    One row per job. "Pay" is in dollars (e.g. 112.95). The newest Run Date is the
 *                    current run; Paid rows from earlier runs are the history for "paid twice".
 *   Payees:          Tech | Account Last 4 | Known Names        (Known Names comma-separated)
 *   Needs a Person:  Timestamp | Message ID | Confirmation | Payee | Amount | Ref | Date | Problem |
 *                    Why and next step | Jobs it might cover | Status
 *   Proofing Log:    Timestamp | Message ID | Confirmation | Result | Jobs | Tech | Amount | Ref | Note
 *                    Result is one of: proven, person, skipped, error, would-prove, would-hold, would-skip
 *
 * No secrets live in this file. Account numbers are only ever the masked last 4.
 */

var SHEETS = { run: 'Pay Run', payees: 'Payees', person: 'Needs a Person', log: 'Proofing Log' };
var MON = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
var DAY_MS = 86400000;

// ---------- Entry points ----------

/** Run once: checks the bank label every 15 minutes. */
function installTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'proofTransfers') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('proofTransfers').timeBased().everyMinutes(15).create();
}

/** Time-driven trigger target. */
function proofTransfers() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) return;                 // another run is still going; it will catch up
  var cfg;
  try {
    cfg = config_();
    var book = SpreadsheetApp.getActive();
    var runSheet = book.getSheetByName(SHEETS.run);
    var logSheet = book.getSheetByName(SHEETS.log);
    var ctx = loadContext_(runSheet, book.getSheetByName(SHEETS.payees), logSheet, cfg);
    var threads = GmailApp.search('label:"' + cfg.label + '" -label:"' + cfg.doneLabel + '" newer_than:30d', 0, 50);
    var done = cfg.shadow ? null : (GmailApp.getUserLabelByName(cfg.doneLabel) || GmailApp.createLabel(cfg.doneLabel));
    // Oldest first, so the first of two identical transfers is the one that's proven.
    var msgs = [];
    threads.forEach(function (t) { t.getMessages().forEach(function (m) { msgs.push({ m: m, t: t }); }); });
    msgs.sort(function (a, b) { return a.m.getDate() - b.m.getDate(); });
    msgs.forEach(function (x) {
      var id = x.m.getId();
      if (ctx.seenIds[id]) return;                    // same email never processed twice
      try {
        handleMessage_(x.m, ctx, cfg, runSheet, logSheet, book);
      } catch (err) {
        logRow_(logSheet, [new Date(), id, '', 'error', '', '', '', '', String(err && err.message || err)]);
        alert_(cfg, 'Payment proofing error on one email', 'Message ' + id + ': ' + (err && err.stack || err) + '\n\nNothing was marked paid for this email.');
      }
      ctx.seenIds[id] = true;
      if (done) x.t.addLabel(done);
    });
  } catch (err) {
    alert_(cfg || config_(), 'Payment proofing stopped with an error', String(err && err.stack || err) + '\n\nNothing was marked paid in this run after the error.');
  } finally {
    lock.releaseLock();
  }
}

function handleMessage_(m, ctx, cfg, runSheet, logSheet, book) {
  var id = m.getId();
  var parsed = parseBankEmail_(m.getPlainBody(), m.getDate());
  var now = new Date();
  // A confirmation # already handled: the bank re-sent the same confirmation. Skip it.
  if (parsed.confirmation && ctx.seenConf[parsed.confirmation]) {
    logRow_(logSheet, [now, id, parsed.confirmation, cfg.shadow ? 'would-skip' : 'skipped', '', '', money_(parsed.amountCents), parsed.ref || '',
      'Same confirmation # as an email already handled. Not a second transfer.']);
    return;
  }
  var r = proofTransfer_(parsed, ctx);
  ctx.transfers.push({ techId: r.techId, amountCents: parsed.amountCents, ref: parsed.ref, confirmation: parsed.confirmation, outcome: r.outcome });
  if (parsed.confirmation) ctx.seenConf[parsed.confirmation] = true;

  if (r.outcome === 'proven') {
    r.jobIds.forEach(function (j) { ctx.covered[j] = parsed.confirmation; });
    if (cfg.shadow) {
      logRow_(logSheet, [now, id, parsed.confirmation, 'would-prove', r.jobIds.join(', '), r.techId, money_(parsed.amountCents), parsed.ref, 'WOULD mark ' + r.jobIds.join(', ') + ' paid']);
      return;
    }
    markPaid_(runSheet, ctx, r.jobIds, parsed, now);
    logRow_(logSheet, [now, id, parsed.confirmation, 'proven', r.jobIds.join(', '), r.techId, money_(parsed.amountCents), parsed.ref, 'Marked paid. ' + r.why]);
    return;
  }
  if (cfg.shadow) {
    logRow_(logSheet, [now, id, parsed.confirmation || '', 'would-hold', r.candidates.join(', '), r.techId || '', money_(parsed.amountCents), parsed.ref || '', 'WOULD send to a person: ' + r.title + '. ' + r.why]);
    return;
  }
  var failed = r.checks.filter(function (c) { return c.pass === false; }).map(function (c) { return c.name + ': ' + c.label; }).join('; ');
  book.getSheetByName(SHEETS.person).appendRow([now, id, parsed.confirmation || '', parsed.payee || '', money_(parsed.amountCents), parsed.ref || '',
    parsed.date || '', r.title, r.why, r.candidates.join(', '), 'Open']);
  logRow_(logSheet, [now, id, parsed.confirmation || '', 'person', r.candidates.join(', '), r.techId || '', money_(parsed.amountCents), parsed.ref || '', r.title + '. ' + failed]);
  alert_(cfg, 'Needs a person: ' + r.title + (r.doublePay ? ' (possible double payment)' : ''),
    r.why + '\n\nFailed checks: ' + failed + '\n\nNothing was marked paid. The details are in the "Needs a Person" sheet.\n\n---- The email ----\n' + m.getPlainBody());
}

// ---------- Reading the email (pure; tested in Node) ----------

/** Whole cents from "$1,240.00", "1240.5" or a number. NaN if it isn't money. */
function toCents_(v) {
  if (typeof v === 'number') return Math.round(v * 100);
  var s = String(v == null ? '' : v).replace(/[$,\s]/g, '');
  var m = /^(-)?(\d+)(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) return NaN;
  var c = parseInt(m[2], 10) * 100 + parseInt(((m[3] || '') + '00').slice(0, 2), 10);
  return m[1] ? -c : c;
}
function money_(c) {
  if (c == null || isNaN(c)) return '';
  var neg = c < 0; c = Math.abs(Math.round(c));
  return (neg ? '-' : '') + '$' + Math.floor(c / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',') + '.' + ('0' + (c % 100)).slice(-2);
}
function pad_(n) { return ('0' + n).slice(-2); }
function dayKey_(d) { d = new Date(d); return d.getFullYear() + '-' + pad_(d.getMonth() + 1) + '-' + pad_(d.getDate()); }

/** "Nov 6", "Nov 6, 2026", "11/06/2026" → "2026-11-06". No year: the year the email arrived. */
function parseDate_(s, received) {
  if (!s) return null;
  s = String(s).trim();
  var y = null, mo, d, r;
  if ((r = /^([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?$/.exec(s))) {
    mo = MON.indexOf(r[1].slice(0, 3).toLowerCase()); d = +r[2]; if (r[3]) y = +r[3];
    if (mo < 0) return null;
  } else if ((r = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s))) { mo = +r[1] - 1; d = +r[2]; y = +r[3]; }
  else if ((r = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s))) { y = +r[1]; mo = +r[2] - 1; d = +r[3]; }
  else return null;
  if (y == null) {
    var rec = new Date(received || Date.now());
    y = rec.getFullYear();
    if (new Date(y, mo, d).getTime() > rec.getTime() + DAY_MS) y -= 1;
  }
  var dt = new Date(y, mo, d, 12);
  if (dt.getMonth() !== mo) return null;
  return dayKey_(dt);
}

var RX_ = {
  summary: /You sent\s+\$\s?([\d,]+\.\d{2})\s+to\s+(.+?)\s*[·•|–-]\s*ref(?:erence)?\s*[:#]?\s*([A-Z0-9][A-Z0-9-]{2,})\s*[·•|–-]\s*([A-Za-z]{3,9}\.?\s+\d{1,2}(?:,?\s+\d{4})?)/i,
  amount: /^\s*Amount:\s*\$\s?([\d,]+\.\d{2})\s*$/im,
  payee: /^\s*(?:To|Recipient|Payee):\s*(.+?)\s*(?:[•*]{2,}\s?(\d{4}))?\s*$/i,
  ref: /^\s*(?:Reference|Ref)\s*(?:#|no\.?)?\s*:\s*([A-Z0-9][A-Z0-9-]{2,})\s*$/im,
  date: /^\s*(?:Date|Transfer date|Sent):\s*([A-Za-z]{3,9}\.?\s+\d{1,2},?\s+\d{4}|\d{1,2}\/\d{1,2}\/\d{4})/im,
  memo: /^\s*Memo:\s*(.*)$/im,
  conf: /^\s*Confirmation(?:\s*(?:#|number|no\.?))?\s*:\s*([A-Z0-9][A-Z0-9-]{5,})\s*$/im,
  jobs: /\bSH-\d{4}\b/g
};

/** Reads a bank confirmation. ok=false (with `missing`) if any field can't be found. */
function parseBankEmail_(text, received) {
  var t = String(text || '').replace(/\r/g, '');
  var out = { ok: false, amountCents: null, payee: null, account: null, ref: null, date: null, memo: '', memoJobs: [], confirmation: null, missing: [] };
  var s = RX_.summary.exec(t), x;
  if (s) {
    out.amountCents = toCents_(s[1]); out.payee = s[2].trim(); out.ref = s[3].toUpperCase(); out.date = parseDate_(s[4], received);
  } else {
    if ((x = RX_.amount.exec(t))) out.amountCents = toCents_(x[1]);
    if ((x = RX_.ref.exec(t))) out.ref = x[1].toUpperCase();
    if ((x = RX_.date.exec(t))) out.date = parseDate_(x[1].replace(/,\s*/g, ', '), received);
  }
  var lines = t.split('\n');
  for (var i = 0; i < lines.length; i++) {
    var p = RX_.payee.exec(lines[i]);
    if (p) { if (!out.payee) out.payee = p[1].replace(/\s{2,}.*$/, '').trim(); if (p[2]) out.account = p[2]; break; }
  }
  if ((x = RX_.memo.exec(t))) { out.memo = x[1].trim() === '(none)' ? '' : x[1].trim(); out.memoJobs = out.memo.match(RX_.jobs) || []; }
  if ((x = RX_.conf.exec(t))) out.confirmation = x[1].toUpperCase();
  if (out.amountCents == null || isNaN(out.amountCents)) out.missing.push('amount');
  if (!out.payee) out.missing.push('payee');
  if (!out.ref) out.missing.push('reference');
  if (!out.date) out.missing.push('date');
  if (!out.confirmation) out.missing.push('confirmation #');
  out.ok = out.missing.length === 0;
  return out;
}

// ---------- The checks (pure; tested in Node) ----------

function norm_(s) { return String(s || '').toLowerCase().replace(/[.,'’]/g, ' ').replace(/\s+/g, ' ').trim(); }

/** Every set of items whose cents add up to target exactly (stops after `limit`). */
function subsetSum_(items, target, limit) {
  limit = limit || 5;
  var xs = items.filter(function (i) { return i.cents > 0; }).sort(function (a, b) { return b.cents - a.cents; });
  var suffix = [], acc = 0, out = [];
  for (var i = xs.length - 1; i >= 0; i--) { acc += xs[i].cents; suffix[i] = acc; }
  (function go(k, left, pick) {
    if (out.length >= limit) return;
    if (left === 0 && pick.length) { out.push(pick.slice()); return; }
    if (k >= xs.length || left < 0 || suffix[k] < left) return;
    pick.push(xs[k].id); go(k + 1, left - xs[k].cents, pick); pick.pop();
    go(k + 1, left, pick);
  })(0, target, []);
  return out;
}

/**
 * ctx: { lines: [{jobId, techId, payCents}] (current run), history: {jobId: {techId, payCents, paidAt, ref}},
 *        techs: {techId: {name, ref, account, names[]}}, window: {from, to} (day keys),
 *        covered: {jobId: confirmation}, transfers: [{techId, amountCents, ref, confirmation, outcome}] }
 */
function proofTransfer_(p, ctx) {
  var checks = [];
  function add(k, name, pass, label) { checks.push({ k: k, name: name, pass: pass, label: label }); }
  var res = { outcome: 'person', kind: null, techId: null, jobIds: [], candidates: [], checks: checks, doublePay: false, diffCents: null };
  if (!p.ok) {
    add('read', 'Email read', false, 'missing ' + p.missing.join(', '));
    return finish_(res, p, ctx, 'unreadable');
  }
  var payeeTech = null, refTech = null, aliasOk = false;
  Object.keys(ctx.techs).forEach(function (id) {
    var t = ctx.techs[id];
    if (!payeeTech && t.names.some(function (n) { return norm_(n) === norm_(p.payee); })) payeeTech = id;
    if (t.ref === p.ref) refTech = id;
  });
  var techId = payeeTech || refTech;
  var tech = techId ? ctx.techs[techId] : null;
  res.techId = techId;
  if (payeeTech && p.account && ctx.techs[payeeTech].account && p.account !== String(ctx.techs[payeeTech].account)) add('payee', 'Payee matches', false, 'account ••••' + p.account + ' is not the saved ••••' + ctx.techs[payeeTech].account);
  else if (payeeTech) { aliasOk = true; add('payee', 'Payee matches', true, p.payee + ' = ' + tech.name); }
  else add('payee', 'Payee matches', false, '"' + p.payee + '" is not a known payee');

  var lines = tech ? ctx.lines.filter(function (l) { return l.techId === techId; }) : [];
  if (!tech || !lines.length) {
    add('amount', 'Amount exact to the cent', false, 'no pay-run line to compare with');
    add('ref', 'Reference matches', false, p.ref + ' is not a pay-run reference');
    return finish_(res, p, ctx, 'no_line');
  }
  var byJob = {};
  lines.forEach(function (l) { byJob[l.jobId] = l; });
  function job(id) { return byJob[id] || ctx.history[id] || (ctx.allJobs && ctx.allJobs[id]) || null; }
  var owed = lines.filter(function (l) { return !ctx.covered[l.jobId]; });
  var owedCents = owed.reduce(function (s, l) { return s + l.payCents; }, 0);
  var ids = [], how;
  if (p.memoJobs.length) { ids = p.memoJobs.slice(); how = 'memo'; }
  else {
    var sols = subsetSum_(owed.map(function (l) { return { id: l.jobId, cents: l.payCents }; }), p.amountCents);
    if (!sols.length) sols = subsetSum_(lines.map(function (l) { return { id: l.jobId, cents: l.payCents }; }), p.amountCents);
    if (sols.length === 1) { ids = sols[0]; how = 'sum'; } else how = sols.length ? 'ambiguous' : 'none';
  }
  ids.sort();
  res.jobIds = ids;
  var known = ids.map(job).filter(Boolean);
  var sum = known.reduce(function (s, l) { return s + l.payCents; }, 0);
  if (how === 'ambiguous') { add('amount', 'Amount exact to the cent', false, 'more than one set of jobs adds up to it'); res.kind = 'ambiguous'; }
  else if (how === 'none') { res.diffCents = p.amountCents - owedCents; add('amount', 'Amount exact to the cent', false, money_(Math.abs(res.diffCents)) + (res.diffCents < 0 ? ' short of ' : ' over ') + money_(owedCents)); }
  else if (known.length !== ids.length) add('amount', 'Amount exact to the cent', false, 'memo lists an unknown job');
  else if (sum !== p.amountCents) { res.diffCents = p.amountCents - sum; add('amount', 'Amount exact to the cent', false, money_(Math.abs(res.diffCents)) + (res.diffCents < 0 ? ' short' : ' over')); }
  else add('amount', 'Amount exact to the cent', true, ids.join(' + ') + ' = ' + money_(p.amountCents));

  var inWin = p.date >= ctx.window.from && p.date <= ctx.window.to;
  add('date', 'Date inside the pay window', inWin, p.date + (inWin ? ' is inside ' : ' is outside ') + ctx.window.from + ' to ' + ctx.window.to);
  add('ref', 'Reference matches', p.ref === tech.ref, p.ref === tech.ref ? p.ref : p.ref + ', expected ' + tech.ref);

  var dup = ctx.transfers.filter(function (t) { return t.outcome === 'proven' && t.techId === techId && t.amountCents === p.amountCents && t.ref === p.ref && t.confirmation !== p.confirmation; })[0];
  var earlier = known.filter(function (l) { return ctx.history[l.jobId]; });
  var again = known.filter(function (l) { return ctx.covered[l.jobId]; });
  if (dup) { res.doublePay = true; res.kind = 'duplicate'; add('twice', 'No job paid twice', false, 'same payee, amount and ref as ' + dup.confirmation); }
  else if (earlier.length) { res.doublePay = true; res.kind = 'paid_twice'; add('twice', 'No job paid twice', false, earlier.map(function (l) { return l.jobId + ' paid ' + l.paidAt + ' (' + l.ref + ')'; }).join('; ')); }
  else if (again.length) { res.doublePay = true; res.kind = 'paid_twice'; add('twice', 'No job paid twice', false, again.map(function (l) { return l.jobId; }).join(', ') + ' already proven paid'); }
  else if (ids.length) add('twice', 'No job paid twice', true, 'none paid before');
  else add('twice', 'No job paid twice', null, 'no jobs matched');

  if (ids.length) {
    var wrong = ids.filter(function (id) { var l = job(id); return !l || l.techId !== techId; });
    var outside = known.filter(function (l) { return l.techId === techId && !byJob[l.jobId] && !ctx.history[l.jobId]; });
    if (wrong.length) add('owner', 'Every job is that tech\'s', false, wrong.join(', ') + ' is not ' + tech.name + '\'s');
    else if (outside.length) add('owner', 'Every job is that tech\'s', false, outside.map(function (l) { return l.jobId; }).join(', ') + ' is not in this pay run');
    else add('owner', 'Every job is that tech\'s', true, 'all ' + tech.name + '\'s');
  } else add('owner', 'Every job is that tech\'s', null, 'no jobs matched');

  if (!aliasOk && !res.kind) res.kind = 'payee';
  return finish_(res, p, ctx, null, owed, owedCents, tech);
}

var TITLES_ = { unreadable: 'Couldn\'t read the email', no_line: 'No matching pay-run line', duplicate: 'Possible double payment: sent twice',
  paid_twice: 'Possible double payment: job already paid', payee: 'Wrong payee', amount: 'Amount doesn\'t match', ambiguous: 'More than one set of jobs fits',
  date: 'Outside the date window', ref: 'Reference doesn\'t match', owner: 'Job isn\'t that tech\'s' };

function finish_(res, p, ctx, kind, owed, owedCents, tech) {
  var allPass = res.checks.length >= 6 && res.checks.every(function (c) { return c.pass === true; });
  if (allPass) { res.outcome = 'proven'; res.kind = null; res.title = 'Proven'; res.why = money_(p.amountCents) + ' pays ' + res.jobIds.join(', ') + ' exactly.'; return res; }
  var failed = res.checks.filter(function (c) { return c.pass === false; }).map(function (c) { return c.k; });
  res.kind = kind || res.kind || ['payee', 'amount', 'owner', 'date', 'ref', 'twice'].filter(function (k) { return failed.indexOf(k) >= 0; })[0] || 'amount';
  res.title = TITLES_[res.kind];
  var owedIds = (owed || []).map(function (l) { return l.jobId; });
  res.candidates = (res.kind === 'duplicate' || res.kind === 'paid_twice' || res.kind === 'no_line') ? [] :
    (res.jobIds.length ? res.jobIds.filter(function (id) { return owedIds.indexOf(id) >= 0; }) : owedIds);
  var name = tech ? tech.name : '', d = res.diffCents;
  var whyBy = {
    unreadable: 'Couldn\'t find the ' + p.missing.join(', ') + '. Open the email and enter the details by hand if it is a real transfer.',
    no_line: 'Nobody in the pay run is called "' + p.payee + '" and ' + p.ref + ' isn\'t a pay-run reference. Probably a supplier payment in the bank label. Nothing marked paid.',
    duplicate: 'Possible double payment: ' + name + ' was already paid ' + money_(p.amountCents) + ' with ref ' + p.ref + '. Ask the bank to recall one, or ask ' + name + ' to return it or hold it against the next run.',
    paid_twice: 'Possible double payment: ' + res.jobIds.join(', ') + ' was already paid. Ask ' + name + ' to return ' + money_(p.amountCents) + ' or deduct it from the next run.',
    payee: 'The bank shows payee "' + p.payee + '"' + (p.account ? ' ••••' + p.account : '') + ', but the ref and amount are ' + name + '\'s. Call the bank before marking anything paid; if it went to the wrong person, ask for a recall.',
    amount: d == null ? 'The amount doesn\'t match the jobs in the memo.' : 'Transfer is ' + money_(Math.abs(d)) + (d < 0 ? ' short of ' : ' over ') + name + '\'s pay-run total of ' + money_(owedCents) + '. ' + (d < 0 ? 'Check with the bank or ' + name + ', then send a ' + money_(-d) + ' top-up.' : 'Ask ' + name + ' to return ' + money_(d) + ' or hold it against the next run.'),
    ambiguous: 'More than one set of ' + name + '\'s jobs adds up to ' + money_(p.amountCents) + '. Ask which jobs it was for and add them to the memo.',
    date: 'Dated ' + p.date + ', outside the pay window (' + (ctx.window.from) + ' to ' + ctx.window.to + '). It can\'t be the payment for these jobs. Check the date with the bank.',
    ref: 'Reference ' + p.ref + ' doesn\'t match ' + name + '\'s ' + (tech ? tech.ref : '') + '. Check who it was for.',
    owner: 'A job in the memo isn\'t ' + name + '\'s, or isn\'t in this pay run. Check the memo with the office.'
  };
  res.why = whyBy[res.kind];
  return res;
}

// ---------- Sheets ----------

function config_() {
  var p = PropertiesService.getScriptProperties();
  return {
    shadow: String(p.getProperty('SHADOW_MODE') || 'true').toLowerCase() !== 'false',   // default ON
    alertTo: p.getProperty('ALERT_TO') || Session.getEffectiveUser().getEmail(),
    label: p.getProperty('GMAIL_LABEL') || 'Bank/Transfers',
    doneLabel: p.getProperty('DONE_LABEL') || 'Bank/Proofed',
    windowDays: Number(p.getProperty('WINDOW_DAYS') || 4)
  };
}

function rows_(sheet) {
  var v = sheet.getDataRange().getValues();
  var head = v[0].map(String);
  return { head: head, col: function (n) { return head.indexOf(n); }, data: v.slice(1).map(function (r, i) {
    var o = { _row: i + 2 }; head.forEach(function (h, k) { o[h] = r[k]; }); return o; }) };
}

function loadContext_(runSheet, payeeSheet, logSheet, cfg) {
  var run = rows_(runSheet), payees = rows_(payeeSheet), log = rows_(logSheet);
  var runDays = run.data.map(function (r) { return dayKey_(r['Run Date']); }).filter(Boolean).sort();
  var current = runDays[runDays.length - 1];
  var ctx = { lines: [], history: {}, techs: {}, covered: {}, transfers: [], seenIds: {}, seenConf: {}, rowOf: {}, cols: run, allJobs: {} };
  var start = new Date(current + 'T12:00:00');
  ctx.window = { from: current, to: dayKey_(start.getTime() + cfg.windowDays * DAY_MS) };
  payees.data.forEach(function (r) {
    var names = String(r['Known Names'] || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    if (names.indexOf(String(r.Tech)) < 0) names.unshift(String(r.Tech));
    ctx.techs[r.Tech] = { name: r.Tech, account: String(r['Account Last 4'] || ''), names: names, ref: null };
  });
  run.data.forEach(function (r) {
    var l = { jobId: String(r['Job ID']), techId: String(r.Tech), payCents: toCents_(r.Pay), ref: String(r['Expected Ref'] || '') };
    ctx.rowOf[l.jobId] = r._row;
    ctx.allJobs[l.jobId] = l;
    if (dayKey_(r['Run Date']) === current) {
      ctx.lines.push(l);
      if (ctx.techs[l.techId]) ctx.techs[l.techId].ref = l.ref;
      if (String(r.Status).toLowerCase() === 'paid') ctx.covered[l.jobId] = String(r.Confirmation || 'paid');
    } else if (String(r.Status).toLowerCase() === 'paid') {
      ctx.history[l.jobId] = { jobId: l.jobId, techId: l.techId, payCents: l.payCents, ref: String(r['Paid Ref'] || l.ref), paidAt: r['Paid At'] ? dayKey_(r['Paid At']) : dayKey_(r['Run Date']) };
    }
  });
  // Idempotency: what this mode has already handled. Shadow results don't block a live run.
  var mine = cfg.shadow ? ['would-prove', 'would-hold', 'would-skip'] : ['proven', 'person', 'skipped', 'error'];
  log.data.forEach(function (r) {
    if (mine.indexOf(String(r.Result)) < 0) return;
    if (r['Message ID']) ctx.seenIds[r['Message ID']] = true;
    if (r.Confirmation && r.Result !== 'error') ctx.seenConf[String(r.Confirmation)] = true;
    if (r.Result === 'proven' || r.Result === 'would-prove') {
      ctx.transfers.push({ techId: String(r.Tech), amountCents: toCents_(r.Amount), ref: String(r.Ref), confirmation: String(r.Confirmation), outcome: 'proven' });
      if (cfg.shadow) String(r.Jobs || '').split(/,\s*/).filter(Boolean).forEach(function (j) { ctx.covered[j] = String(r.Confirmation); });
    }
  });
  return ctx;
}

/** Only called for a proven transfer in live mode. */
function markPaid_(sheet, ctx, jobIds, p, now) {
  var c = ctx.cols;
  jobIds.forEach(function (j) {
    var row = ctx.rowOf[j];
    sheet.getRange(row, c.col('Status') + 1).setValue('Paid');
    sheet.getRange(row, c.col('Paid Ref') + 1).setValue(p.ref);
    sheet.getRange(row, c.col('Confirmation') + 1).setValue(p.confirmation);
    sheet.getRange(row, c.col('Paid At') + 1).setValue(now);
  });
}

function logRow_(sheet, row) { sheet.appendRow(row); }

function alert_(cfg, subject, body) {
  try { MailApp.sendEmail({ to: cfg.alertTo, subject: '[Payment proofing] ' + subject, body: body }); }
  catch (e) { console.error('Could not send alert: ' + e); }
}
