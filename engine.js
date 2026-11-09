// Payment Proofing (M4): the matching engine.
// Pure state + functions (window.Proofing). No DOM here, so it can be tested in Node:
//   global.window = global; require('shared/data.js'); const P = require('./engine.js');
//
// The idea: Summit pays its technicians (independent contractors, paid per completed job)
// in a pay run, by bank transfer. Every transfer produces a confirmation email from the
// bank. Before ANY job is marked paid, the email is read and proven against the pay run:
//
//   read the email → payee (with known-names table + saved account) → amount exact to the cent
//   → date inside the pay window → reference → no job paid twice → every job is that tech's
//
// All checks pass: "Proven", the jobs are marked paid with the transfer's confirmation #.
// Anything else goes to "Needs a person" with the email, the jobs it might cover, the
// difference and a suggested next step. It never marks anything paid on a guess.
// All money is handled as whole cents (integers), never floating-point dollars.
// All data is fictional (see shared/data.js).

(function (root) {
  'use strict';
  const DAY = 86400000;
  const S = root.SUMMIT;
  const T0 = new Date(S.today);                                   // today 00:00 local
  const at = (day, h = 0, m = 0) => { const t = new Date(T0); t.setDate(t.getDate() + day); t.setHours(h, m, 0, 0); return +t; };
  const byId = (list, id) => list.find(x => x.id === id);

  // ---------------------------------------------------------------- the pay rule
  // One rule, shown on the page: contractor pay = 45% of the job's revenue, to the cent.
  const PAY_RATE_PCT = 45;
  const RULE_TEXT = 'Contractor pay = 45% of job revenue (before tax), rounded to the cent.';
  const WINDOW_DAYS = 4;                                           // transfers dated run day .. run day + 4
  const BANK = { name: 'Cedar Ridge Bank', from: 'alerts@cedarridge-bank.example', phone: '(555) 010-9000' };
  const OPERATING = '••••4821';                                    // Summit's (fake) operating account

  // Saved payees: the names the bank may show for each tech, and the last 4 of the account
  // on file. All fake. A name not in this table never matches, however close it looks.
  const PAYEES = {
    T1: { account: '4410', names: ['Marcus Reyes', 'M. Reyes', 'Marcus A. Reyes', 'Reyes, Marcus'] },
    T2: { account: '9052', names: ['Dana Whitfield', 'D. Whitfield', 'Whitfield Plumbing LLC'] },
    T3: { account: '7730', names: ['Luis Ortega', 'L. Ortega', 'Ortega Appliance Repair'] },
    T4: { account: '6248', names: ['Priya Nair', 'P. Nair'] },
    T5: { account: '3307', names: ['Jake Morrow', 'J. Morrow', 'Jacob Morrow'] },
  };

  // ---------------------------------------------------------------- money (whole cents)
  // "1,240.00" → 124000. Strings are parsed digit by digit, so there is no float error.
  function toCents(v) {
    if (typeof v === 'number') return Math.round(v * 100);
    const s = String(v == null ? '' : v).replace(/[$,\s]/g, '');
    const m = /^(-)?(\d+)(?:\.(\d{1,2}))?$/.exec(s);
    if (!m) return NaN;
    const c = parseInt(m[2], 10) * 100 + parseInt(((m[3] || '') + '00').slice(0, 2), 10);
    return m[1] ? -c : c;
  }
  function money(c) {
    const neg = c < 0; c = Math.abs(Math.round(c));
    const d = Math.floor(c / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return (neg ? '-' : '') + '$' + d + '.' + String(c % 100).padStart(2, '0');
  }
  // Pay for one job: revenue in cents × 45 / 100, rounded half up to the cent.
  const payFor = revenue => Math.round(toCents(revenue) * PAY_RATE_PCT / 100);
  const dollars = n => '$' + Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 });

  // ---------------------------------------------------------------- dates
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const pad = n => String(n).padStart(2, '0');
  const dayKey = ms => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
  const keyToMs = k => { const [y, m, d] = k.split('-').map(Number); return +new Date(y, m - 1, d, 12); };
  const fmtShort = ms => { const d = new Date(ms); return `${MON[d.getMonth()]} ${d.getDate()}`; };
  const fmtDay = ms => { const d = new Date(ms); return `${DOW[d.getDay()]}, ${MON[d.getMonth()]} ${d.getDate()}`; };
  const fmtTime = ms => { const d = new Date(ms); let h = d.getHours(); const ap = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12; return `${h}:${pad(d.getMinutes())} ${ap}`; };
  const fmtStamp = ms => `${fmtDay(ms)} · ${fmtTime(ms)}`;
  function isoWeek(ms) {
    const d = new Date(ms);
    const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    const wd = t.getUTCDay() || 7;
    t.setUTCDate(t.getUTCDate() + 4 - wd);
    const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
    return Math.ceil(((t - y0) / DAY + 1) / 7);
  }
  // "Nov 6", "Nov 6, 2026", "November 6 2026", "11/06/2026" → "2026-11-06".
  // With no year, the year is taken from when the email arrived (and last year if that
  // would put the date more than a day in the future).
  function parseDate(s, receivedAt) {
    if (!s) return null;
    s = String(s).trim();
    let y, m, d;
    let r = /^([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?$/.exec(s);
    if (r) {
      m = MON.findIndex(x => x.toLowerCase() === r[1].slice(0, 3).toLowerCase());
      d = +r[2]; y = r[3] ? +r[3] : null;
      if (m < 0) return null;
    } else if ((r = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s))) { m = +r[1] - 1; d = +r[2]; y = +r[3]; }
    else if ((r = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s))) { y = +r[1]; m = +r[2] - 1; d = +r[3]; }
    else return null;
    if (d < 1 || d > 31) return null;
    if (y == null) {
      const rec = new Date(receivedAt || Date.now());
      y = rec.getFullYear();
      if (+new Date(y, m, d) > +rec + DAY) y -= 1;
    }
    const dt = new Date(y, m, d, 12);
    if (dt.getMonth() !== m) return null;                          // Feb 31 and friends
    return dayKey(+dt);
  }

  // ---------------------------------------------------------------- the pay run
  // This week's run: jobs completed in the two weeks that ended three days ago, approved
  // and paid two days ago. Earlier runs went out every 14 days before that.
  const RUN_DAY = at(-2, 16, 0);
  const PERIOD_START = at(-16, 0, 0), PERIOD_END = at(-3, 23, 59);
  const PERIOD_DAYS = 14;
  const WINDOW = { from: dayKey(RUN_DAY), to: dayKey(RUN_DAY + WINDOW_DAYS * DAY) };
  const refFor = (techId, runMs) => `PAY-W${isoWeek(runMs)}-${byId(S.techs, techId).initials}`;

  function lineFor(j) {
    const c = byId(S.customers, j.customerId);
    return { jobId: j.id, techId: j.techId, revenue: j.revenue, payCents: payFor(j.revenue), completedAt: +new Date(j.completedAt),
      issue: j.issue, customer: c ? c.name : '', trade: j.trade };
  }
  const isDone = j => (j.status === 'completed' || j.status === 'invoiced') && j.techId && j.completedAt;

  function buildPayRun() {
    const lines = S.jobs.filter(isDone).map(lineFor)
      .filter(l => l.completedAt >= PERIOD_START && l.completedAt <= PERIOD_END)
      .sort((a, b) => a.techId.localeCompare(b.techId) || a.completedAt - b.completedAt);
    const techs = {};
    for (const t of S.techs) {
      const ls = lines.filter(l => l.techId === t.id);
      if (!ls.length) continue;
      techs[t.id] = { techId: t.id, name: t.name, initials: t.initials, color: t.color, ref: refFor(t.id, RUN_DAY),
        account: PAYEES[t.id].account, jobIds: ls.map(l => l.jobId), totalCents: ls.reduce((s, l) => s + l.payCents, 0) };
    }
    return { id: 'W' + isoWeek(RUN_DAY), week: isoWeek(RUN_DAY), runDay: RUN_DAY, periodStart: PERIOD_START, periodEnd: PERIOD_END,
      window: WINDOW, lines, techs, totalCents: lines.reduce((s, l) => s + l.payCents, 0) };
  }
  // Jobs finished before this period were paid in earlier runs (every 14 days).
  function buildHistory() {
    const h = {};
    for (const j of S.jobs.filter(isDone)) {
      const done = +new Date(j.completedAt);
      if (done >= PERIOD_START) continue;
      const k = Math.ceil((PERIOD_START - done) / (PERIOD_DAYS * DAY));
      const runMs = RUN_DAY - k * PERIOD_DAYS * DAY;
      const l = lineFor(j);
      h[j.id] = Object.assign(l, { paidAt: runMs, ref: refFor(j.techId, runMs), run: 'W' + isoWeek(runMs) });
    }
    return h;
  }

  // ---------------------------------------------------------------- the bank inbox
  // Ten confirmation emails for this pay run, oldest first. Clean ones and every problem case.
  function bankEmail(o) {
    const sent = o.sentAt;
    const name = o.payee, amt = money(o.cents);
    const subject = o.subject || `You sent ${amt} to ${name}`;
    const body = o.body || [
      `${BANK.name} · Transfer sent`,
      '',
      `You sent ${amt} to ${name} · ref ${o.ref} · ${fmtShort(sent)}`,
      '',
      `From:          Summit Home Services operating ${OPERATING}`,
      `To:            ${name} ••••${o.acct}`,
      `Memo:          ${o.memo || '(none)'}`,
      `Confirmation:  ${o.conf}`,
      `Sent:          ${fmtShort(sent)}, ${new Date(sent).getFullYear()} at ${fmtTime(sent)}`,
      '',
      `Didn't make this transfer? Call ${BANK.name} at ${BANK.phone}.`,
    ].join('\n');
    return { id: o.id, from: o.from || `${BANK.name} <${BANK.from}>`, subject, body, receivedAt: o.receivedAt || sent + 2 * 60000,
      label: o.label, hint: o.hint, expect: o.expect };
  }
  function buildInbox(run) {
    const T = run.techs;
    const r = (h, m) => RUN_DAY - 16 * 3600000 + h * 3600000 + m * 60000;       // run day, h:m
    const fwdDate = at(-20, 11, 40);                                              // before the period's jobs were done
    const fwdBody = [
      '---------- Forwarded message ---------',
      `From: ${BANK.name} <${BANK.from}>`,
      'Subject: Transfer receipt',
      '',
      'TRANSFER RECEIPT',
      `Recipient:     Priya Nair  ••••${PAYEES.T4.account}`,
      `Amount:        ${money(T.T4.totalCents)}`,
      `Reference #:   ${T.T4.ref}`,
      `Date:          ${fmtShort(fwdDate)}, ${new Date(fwdDate).getFullYear()}`,
      'Confirmation:  CRB-3M8D-0417',
      '',
      '(Forwarded by the office: "found this receipt in my inbox, is this Priya’s pay?")',
    ].join('\n');
    const H = buildHistory();
    const prev = H['SH-1009'];
    return [
      bankEmail({ id: 'E01', payee: 'Luis Ortega', cents: T.T3.totalCents, ref: T.T3.ref, acct: PAYEES.T3.account, conf: 'CRB-5Q2K-1187', sentAt: r(16, 12),
        label: 'One transfer, one job', hint: 'Exact match: one transfer pays Luis\'s one job.', expect: 'proven' }),
      bankEmail({ id: 'E02', payee: 'Marcus Reyes', cents: payFor(610) + payFor(251), ref: T.T1.ref, acct: PAYEES.T1.account, conf: 'CRB-5Q2K-1190', sentAt: r(16, 14),
        label: 'One transfer, two jobs', hint: 'No memo. It finds the two jobs that add up to the amount, to the cent.', expect: 'proven' }),
      bankEmail({ id: 'E03', payee: 'Dana Whitfield', cents: T.T2.totalCents - 4000, ref: T.T2.ref, acct: PAYEES.T2.account, conf: 'CRB-5Q2K-1194', sentAt: r(16, 17),
        label: '$40.00 short', hint: 'The amount is $40.00 less than Dana is owed.', expect: 'amount' }),
      bankEmail({ id: 'E04', payee: 'Luis Ortega', cents: T.T3.totalCents, ref: T.T3.ref, acct: PAYEES.T3.account, conf: 'CRB-5Q2K-1201', sentAt: r(16, 19),
        label: 'Sent twice', hint: 'Same payee, same amount, same ref, a new confirmation #: a second real transfer.', expect: 'duplicate' }),
      bankEmail({ id: 'E05', payee: 'Jake Moore', cents: T.T5.totalCents, ref: T.T5.ref, acct: '5512', conf: 'CRB-5Q2K-1206', sentAt: r(16, 22),
        label: 'Wrong payee', hint: 'Jake\'s amount and ref, but a different name and account.', expect: 'payee' }),
      bankEmail({ id: 'E06', payee: 'Priya Nair', cents: prev.payCents, ref: T.T4.ref, acct: PAYEES.T4.account, memo: prev.jobId, conf: 'CRB-5Q2K-1210', sentAt: r(16, 25),
        label: 'Job already paid', hint: `The memo says ${prev.jobId}, which was paid in run ${prev.run}.`, expect: 'paid_twice' }),
      bankEmail({ id: 'E07', payee: 'Ridgeline Supply Co.', cents: 18640, ref: 'INV-2231', acct: '0619', conf: 'CRB-5Q2K-1215', sentAt: r(16, 31),
        label: 'Not in the pay run', hint: 'A payee and ref that aren\'t in the pay run at all.', expect: 'no_line' }),
      bankEmail({ id: 'E08', payee: 'M. Reyes', cents: payFor(398), ref: T.T1.ref, acct: PAYEES.T1.account, memo: 'SH-1022', conf: 'CRB-6A1F-0032', sentAt: r(24 + 9, 5),
        label: 'Name variant', hint: '"M. Reyes" is in the known-names table for Marcus Reyes.', expect: 'proven' }),
      bankEmail({ id: 'E09', from: 'Office Manager <office@summit-home.example>', subject: 'Fwd: Transfer receipt', body: fwdBody, cents: T.T4.totalCents,
        receivedAt: r(24 + 10, 2), sentAt: fwdDate, label: 'Outside the date window', hint: 'A forwarded receipt dated before the pay period ended.', expect: 'date' }),
      bankEmail({ id: 'E10', payee: 'Marcus Reyes', cents: payFor(610) + payFor(251), ref: T.T1.ref, acct: PAYEES.T1.account, conf: 'CRB-5Q2K-1190', sentAt: r(16, 14),
        receivedAt: r(24 + 11, 30), subject: `Reminder: you sent ${money(payFor(610) + payFor(251))} to Marcus Reyes`,
        label: 'Same email again', hint: 'The bank re-sent E02\'s confirmation. Same confirmation #, so it is skipped, not paid twice.', expect: 'skipped' }),
    ];
  }

  // ---------------------------------------------------------------- reading the email
  const SEP = '[·•|–-]';
  const RX = {
    summary: new RegExp(`You sent\\s+\\$\\s?([\\d,]+\\.\\d{2})\\s+to\\s+(.+?)\\s*${SEP}\\s*ref(?:erence)?\\s*[:#]?\\s*([A-Z0-9][A-Z0-9-]{2,})\\s*${SEP}\\s*([A-Za-z]{3,9}\\.?\\s+\\d{1,2}(?:,?\\s+\\d{4})?)`, 'i'),
    amount: /^\s*Amount:\s*\$\s?([\d,]+\.\d{2})\s*$/im,
    payee: /^\s*(?:To|Recipient|Payee):\s*(.+?)\s*(?:[•*]{2,}\s?(\d{4}))?\s*$/im,
    ref: /^\s*(?:Reference|Ref)\s*(?:#|no\.?)?\s*:\s*([A-Z0-9][A-Z0-9-]{2,})\s*$/im,
    date: /^\s*(?:Date|Transfer date|Sent):\s*([A-Za-z]{3,9}\.?\s+\d{1,2},?\s+\d{4}|\d{1,2}\/\d{1,2}\/\d{4})/im,
    memo: /^\s*Memo:\s*(.*)$/im,
    conf: /^\s*Confirmation(?:\s*(?:#|number|no\.?))?\s*:\s*([A-Z0-9][A-Z0-9-]{5,})\s*$/im,
    jobs: /\bSH-\d{4}\b/g,
  };
  function parseEmail(text, receivedAt) {
    const t = String(text || '').replace(/\r/g, '');
    const out = { ok: false, amountCents: null, payee: null, account: null, ref: null, date: null, memo: '', memoJobs: [], confirmation: null, format: null, missing: [] };
    const s = RX.summary.exec(t);
    if (s) {
      out.format = 'summary line';
      out.amountCents = toCents(s[1]); out.payee = s[2].trim(); out.ref = s[3].toUpperCase(); out.date = parseDate(s[4], receivedAt);
    } else {
      out.format = 'receipt fields';
      const a = RX.amount.exec(t); if (a) out.amountCents = toCents(a[1]);
      const r = RX.ref.exec(t); if (r) out.ref = r[1].toUpperCase();
      const d = RX.date.exec(t); if (d) out.date = parseDate(d[1].replace(/,/g, ', ').replace(/\s+/g, ' ').replace(' ,', ','), receivedAt);
    }
    // The To/Recipient line carries the masked account (and the name, for receipts).
    const lines = t.split('\n');
    for (const ln of lines) {
      const p = RX.payee.exec(ln);
      if (p && !/^\s*From:/i.test(ln)) {
        if (!out.payee) out.payee = p[1].replace(/\s{2,}.*$/, '').trim();
        if (p[2]) out.account = p[2];
        break;
      }
    }
    const m = RX.memo.exec(t);
    if (m) { out.memo = m[1].trim() === '(none)' ? '' : m[1].trim(); out.memoJobs = out.memo.match(RX.jobs) || []; }
    const c = RX.conf.exec(t); if (c) out.confirmation = c[1].toUpperCase();
    if (out.amountCents == null || isNaN(out.amountCents)) out.missing.push('amount');
    if (!out.payee) out.missing.push('payee');
    if (!out.ref) out.missing.push('reference');
    if (!out.date) out.missing.push('date');
    if (!out.confirmation) out.missing.push('confirmation #');
    out.ok = out.missing.length === 0;
    return out;
  }

  // ---------------------------------------------------------------- payee
  const norm = s => String(s || '').toLowerCase().replace(/[.,'’]/g, ' ').replace(/\s+/g, ' ').trim();
  function matchPayee(name, account) {
    const n = norm(name);
    for (const [techId, p] of Object.entries(PAYEES)) {
      const hit = p.names.find(x => norm(x) === n);
      if (hit) {
        const tech = byId(S.techs, techId);
        return { techId, how: hit === tech.name ? 'exact' : 'alias', alias: hit, accountOk: account == null ? null : account === p.account, savedAccount: p.account };
      }
    }
    return null;
  }

  // ---------------------------------------------------------------- subset sum (in cents)
  // Every set of jobs whose pay adds up to the target exactly. Small lists (a tech's jobs in
  // one run), so a depth-first search with pruning is plenty. Stops after `limit` answers.
  function subsetSum(items, target, limit = 5) {
    const xs = items.filter(i => i.cents > 0).slice().sort((a, b) => b.cents - a.cents);
    const out = [];
    const suffix = []; let acc = 0;
    for (let i = xs.length - 1; i >= 0; i--) { acc += xs[i].cents; suffix[i] = acc; }
    (function go(i, left, pick) {
      if (out.length >= limit) return;
      if (left === 0 && pick.length) { out.push(pick.slice()); return; }
      if (i >= xs.length || left < 0 || suffix[i] < left) return;
      pick.push(xs[i].id); go(i + 1, left - xs[i].cents, pick); pick.pop();
      go(i + 1, left, pick);
    })(0, target, []);
    return out;
  }

  // ---------------------------------------------------------------- state
  const newRun = () => ({ processed: {}, covered: {}, transfers: [], results: {} });
  function createState(o) {
    o = o || {};
    const run = buildPayRun();
    return { v: 1, shadow: o.shadow !== false, payRun: run, history: buildHistory(), inbox: buildInbox(run),
      paid: {}, runs: { shadow: newRun(), live: newRun() }, person: [], log: [], seq: 0 };
  }
  const runOf = st => st.runs[st.shadow ? 'shadow' : 'live'];
  const now = () => Date.now();
  const techName = id => (byId(S.techs, id) || {}).name || id;
  const first = name => String(name).split(' ')[0];
  const pron = id => ({ T1: 'his', T2: 'her', T3: 'his', T4: 'her', T5: 'his' }[id] || 'their');
  const jobById = (st, id) => st.payRun.lines.find(l => l.jobId === id) || st.history[id] || (() => { const j = byId(S.jobs, id); return j && isDone(j) ? lineFor(j) : (j ? Object.assign(lineFor(j), { notDone: true }) : null); })();
  const listJobs = ids => ids.length <= 2 ? ids.join(' and ') : ids.slice(0, -1).join(', ') + ' and ' + ids[ids.length - 1];
  const mathOf = (st, ids) => ids.map(id => { const l = jobById(st, id); return `${id} ${money(l.payCents)}`; }).join(' + ');
  const shortWhy = l => `${dollars(l.revenue)} × ${PAY_RATE_PCT}%`;

  // ---------------------------------------------------------------- the checks
  // Returns the full story for one transfer. Changes nothing.
  function evaluate(st, email, parsed) {
    const run = runOf(st), pr = st.payRun;
    parsed = parsed || parseEmail(email.body, email.receivedAt);
    const checks = [];
    const add = (k, name, pass, label, detail) => checks.push({ k, name, pass, label, detail: detail || '' });
    const res = { emailId: email.id, parsed, checks, techId: null, jobIds: [], candidates: [], diffCents: null, doublePay: false, outcome: 'person', kind: null };

    // 0. Read
    if (!parsed.ok) {
      add('read', 'Email read', false, `Couldn't find the ${listJobs(parsed.missing)}`, 'It only acts on emails it can read completely. Nothing is guessed.');
      return finish(st, res, email);
    }
    add('read', 'Email read', true, `${money(parsed.amountCents)} to ${parsed.payee}`, `Read from the ${parsed.format}. Confirmation ${parsed.confirmation}.`);

    // Who is it for? The payee name first; the reference only as context for a person.
    const pm = matchPayee(parsed.payee, parsed.account);
    const refTech = Object.values(pr.techs).find(t => t.ref === parsed.ref);
    const techId = pm ? pm.techId : refTech ? refTech.techId : null;
    const tech = techId && pr.techs[techId];
    res.techId = techId;

    // 1. Payee
    if (pm && pm.accountOk === false) {
      add('payee', 'Payee matches', false, 'Name matches, account doesn\'t',
        `“${parsed.payee}” is ${techName(pm.techId)}, but the account ••••${parsed.account} isn't ${pron(pm.techId)} saved account ••••${pm.savedAccount}.`);
    } else if (pm) {
      add('payee', 'Payee matches', true, pm.how === 'exact' ? techName(pm.techId) : `Known name for ${techName(pm.techId)}`,
        (pm.how === 'exact' ? `“${parsed.payee}” is ${techName(pm.techId)}` : `“${parsed.payee}” is in the known-names table for ${techName(pm.techId)}`) +
        (pm.accountOk ? `, account ••••${parsed.account} matches the saved one.` : '.'));
    } else {
      add('payee', 'Payee matches', false, `“${parsed.payee}” isn't a known payee`,
        refTech ? `The ref and amount look like ${refTech.name}'s, but ${first(refTech.name)} is saved as ${PAYEES[refTech.techId].names.map(n => '“' + n + '”').join(', ')}${parsed.account ? ` with account ••••${PAYEES[refTech.techId].account}, not ••••${parsed.account}` : ''}.`
          : 'Nobody in this pay run or the known-names table has that name.');
    }

    if (!tech) {
      res.kind = 'no_line';
      add('amount', 'Amount exact to the cent', false, 'No pay-run line to compare with', `Nobody in pay run ${pr.id} is owed ${money(parsed.amountCents)}.`);
      add('date', 'Date inside the pay window', null, 'Not checked', 'Only checked for pay-run transfers.');
      add('ref', 'Reference matches', false, `${parsed.ref} isn't a pay-run reference`, `Pay-run references look like ${Object.values(pr.techs)[0].ref}.`);
      add('twice', 'No job paid twice', null, 'No jobs to check', '');
      add('owner', 'Every job is that tech\'s', null, 'No jobs to check', '');
      return finish(st, res, email);
    }

    // Which jobs does it pay? The memo if it lists job numbers, otherwise the one set of
    // this tech's pay-run jobs that adds up to the amount exactly.
    const lines = pr.lines.filter(l => l.techId === techId);
    const owedCents = lines.filter(l => !run.covered[l.jobId]).reduce((s, l) => s + l.payCents, 0);
    let jobIds = [], how = '', sols = [];
    if (parsed.memoJobs.length) {
      jobIds = parsed.memoJobs.slice(); how = 'memo';
    } else {
      const unpaid = lines.filter(l => !run.covered[l.jobId]).map(l => ({ id: l.jobId, cents: l.payCents }));
      sols = subsetSum(unpaid, parsed.amountCents);
      if (sols.length !== 1) {
        const all = subsetSum(lines.map(l => ({ id: l.jobId, cents: l.payCents })), parsed.amountCents);
        if (!sols.length && all.length) sols = all;
      }
      if (sols.length === 1) { jobIds = sols[0].slice().sort(); how = 'sum'; }
      else how = sols.length ? 'ambiguous' : 'none';
    }
    jobIds = jobIds.slice().sort((a, b) => a.localeCompare(b));
    res.jobIds = jobIds;
    const known = jobIds.map(id => jobById(st, id)).filter(Boolean);

    // 2. Amount
    if (how === 'memo') {
      const sum = known.reduce((s, l) => s + l.payCents, 0);
      const diff = parsed.amountCents - sum;
      if (known.length === jobIds.length && diff === 0) add('amount', 'Amount exact to the cent', true, `${money(parsed.amountCents)} = ${listJobs(jobIds)}`, `${known.map(l => `${l.jobId} ${money(l.payCents)} (${shortWhy(l)})`).join(' + ')}${known.length > 1 ? ' = ' + money(parsed.amountCents) : ''}, to the cent. Job number${known.length > 1 ? 's' : ''} taken from the memo.`);
      else { res.diffCents = diff; add('amount', 'Amount exact to the cent', false, known.length === jobIds.length ? `${money(Math.abs(diff))} ${diff < 0 ? 'short' : 'over'}` : 'Memo lists an unknown job', known.length === jobIds.length ? `The memo says ${listJobs(jobIds)}, which pay ${money(sum)}. The transfer is ${money(parsed.amountCents)}.` : `The memo lists ${listJobs(jobIds.filter(id => !jobById(st, id)))}, which isn't a Summit job.`); }
    } else if (how === 'sum') {
      const ls = jobIds.map(id => jobById(st, id));
      add('amount', 'Amount exact to the cent', true, ls.length > 1 ? `${ls.length} jobs add up to ${money(parsed.amountCents)}` : `${money(parsed.amountCents)} = ${jobIds[0]}`,
        (ls.length > 1 ? `${ls.map(l => `${l.jobId} ${money(l.payCents)}`).join(' + ')} = ${money(parsed.amountCents)}, to the cent.` : `${ls[0].jobId} pays ${money(ls[0].payCents)} (${shortWhy(ls[0])}), to the cent.`) + ` No other set of ${first(tech.name)}'s jobs adds up to it.`);
    } else if (how === 'ambiguous') {
      add('amount', 'Amount exact to the cent', false, `${sols.length} different sets of jobs add up to it`, sols.map(s => s.join(' + ')).join(' or ') + `. It won't guess which jobs were paid.`);
    } else {
      const diff = parsed.amountCents - owedCents;
      res.diffCents = diff;
      add('amount', 'Amount exact to the cent', false, diff ? `${money(Math.abs(diff))} ${diff < 0 ? 'short' : 'over'}` : 'Doesn\'t match',
        `No job or combination of ${first(tech.name)}'s ${lines.length} job${lines.length > 1 ? 's' : ''} adds up to ${money(parsed.amountCents)}. ${pron(techId)[0].toUpperCase() + pron(techId).slice(1)} pay-run total is ${money(owedCents)}.`);
    }

    // 3. Date
    const inWin = parsed.date >= pr.window.from && parsed.date <= pr.window.to;
    add('date', 'Date inside the pay window', inWin, inWin ? `${fmtShort(keyToMs(parsed.date))} is inside the window` : `${fmtShort(keyToMs(parsed.date))} is outside the window`,
      `Pay run ${pr.id} transfers are dated ${fmtShort(keyToMs(pr.window.from))} to ${fmtShort(keyToMs(pr.window.to))}.` + (!inWin && parsed.date < dayKey(pr.periodEnd) ? ` This one is dated before the pay period's work was finished (${fmtShort(pr.periodEnd)}).` : ''));

    // 4. Reference
    if (parsed.ref === tech.ref) add('ref', 'Reference matches', true, parsed.ref, `The expected reference for ${tech.name} in run ${pr.id}.`);
    else add('ref', 'Reference matches', false, `${parsed.ref}, expected ${tech.ref}`, refTech ? `${parsed.ref} is ${refTech.name}'s reference, not ${tech.name}'s.` : `${tech.name}'s reference for run ${pr.id} is ${tech.ref}.`);

    // 5. No job paid twice (earlier runs, earlier transfers, and the same transfer sent again)
    const dup = run.transfers.find(t => t.outcome === 'proven' && t.techId === techId && t.amountCents === parsed.amountCents && t.ref === parsed.ref && t.confirmation !== parsed.confirmation);
    const earlier = known.filter(l => st.history[l.jobId]);
    const coveredBy = known.filter(l => run.covered[l.jobId]);
    if (dup) {
      res.doublePay = true; res.dupOf = dup.emailId; res.kind = 'duplicate';
      const d = run.results[dup.emailId];
      add('twice', 'No job paid twice', false, 'Same transfer sent twice',
        `${dup.confirmation} already paid ${first(tech.name)} ${money(dup.amountCents)} with ref ${dup.ref}${d && d.jobIds.length ? ` (${listJobs(d.jobIds)})` : ''}. This is a new confirmation # with the same payee, amount and ref.`);
    } else if (earlier.length) {
      res.doublePay = true; res.kind = 'paid_twice';
      add('twice', 'No job paid twice', false, `${listJobs(earlier.map(l => l.jobId))} already paid`, earlier.map(l => `${l.jobId} was paid on ${fmtShort(l.paidAt)} in run ${l.run} (${l.ref}).`).join(' '));
    } else if (coveredBy.length) {
      res.doublePay = true; res.kind = 'paid_twice';
      add('twice', 'No job paid twice', false, `${listJobs(coveredBy.map(l => l.jobId))} already proven paid`, coveredBy.map(l => `${l.jobId} was proven paid by ${run.results[run.covered[l.jobId]] ? run.results[run.covered[l.jobId]].parsed.confirmation : 'an earlier transfer'}.`).join(' '));
    } else if (!jobIds.length) add('twice', 'No job paid twice', null, 'No jobs matched yet', 'Checked once the jobs are known.');
    else add('twice', 'No job paid twice', true, 'None paid before', `${listJobs(jobIds)} ${jobIds.length > 1 ? 'have' : 'has'} not been paid in this run or an earlier one.`);

    // 6. Every job belongs to that tech, and is in this pay run (or a paid earlier one)
    if (!jobIds.length) add('owner', 'Every job is that tech\'s', null, 'No jobs matched yet', '');
    else {
      const wrong = jobIds.filter(id => { const l = jobById(st, id); return !l || l.techId !== techId; });
      const outside = known.filter(l => l.techId === techId && !pr.lines.includes(l) && !st.history[l.jobId]);
      if (wrong.length) add('owner', 'Every job is that tech\'s', false, `${listJobs(wrong)} ${wrong.length > 1 ? 'aren\'t' : 'isn\'t'} ${first(tech.name)}'s`, wrong.map(id => { const l = jobById(st, id); return l ? `${id} was done by ${techName(l.techId)}.` : `${id} isn't a Summit job.`; }).join(' '));
      else if (outside.length) add('owner', 'Every job is that tech\'s', false, `${listJobs(outside.map(l => l.jobId))} isn't in this pay run`, outside.map(l => l.notDone ? `${l.jobId} isn't finished yet.` : `${l.jobId} was finished ${fmtShort(l.completedAt)}, after this pay period ended. It belongs in the next run.`).join(' '));
      else add('owner', 'Every job is that tech\'s', true, `All ${first(tech.name)}'s`, `${listJobs(jobIds)}: ${jobIds.map(id => jobById(st, id)).map(l => `${l.issue.toLowerCase()} (${fmtShort(l.completedAt)})`).join(', ')}.`);
    }
    return finish(st, res, email);
  }

  const PRIORITY = ['read', 'duplicate', 'paid_twice', 'payee', 'amount', 'owner', 'date', 'ref', 'twice'];
  const KIND_TITLE = {
    unreadable: 'Couldn\'t read the email', no_line: 'No matching pay-run line', duplicate: 'Possible double payment: sent twice',
    paid_twice: 'Possible double payment: job already paid', payee: 'Wrong payee', amount: 'Amount doesn\'t match',
    ambiguous: 'More than one set of jobs fits', date: 'Outside the date window', ref: 'Reference doesn\'t match', owner: 'Job isn\'t that tech\'s',
  };
  function finish(st, res, email) {
    const run = runOf(st), pr = st.payRun, p = res.parsed;
    const failed = res.checks.filter(c => c.pass === false).map(c => c.k);
    if (!res.checks.some(c => c.pass !== true)) {
      res.outcome = 'proven'; res.kind = null;
      res.why = `Proven: ${money(p.amountCents)} pays ${listJobs(res.jobIds)} exactly.`;
      res.title = 'Proven';
      return res;
    }
    res.outcome = 'person';
    if (!res.kind) {
      if (failed.includes('read')) res.kind = 'unreadable';
      else if (failed.includes('amount') && /sets of jobs/.test(res.checks.find(c => c.k === 'amount').label)) res.kind = 'ambiguous';
      else res.kind = PRIORITY.find(k => failed.includes(k)) || 'amount';
    }
    res.title = KIND_TITLE[res.kind] || 'Needs a person';
    const tech = res.techId && pr.techs[res.techId];
    // The jobs a person might mark paid: the matched ones still owed, else everything this tech is owed.
    const owed = res.techId ? pr.lines.filter(l => l.techId === res.techId && !run.covered[l.jobId]).map(l => l.jobId) : [];
    res.candidates = res.jobIds.length ? res.jobIds.filter(id => owed.includes(id)) : owed;
    if (res.kind === 'duplicate' || res.kind === 'paid_twice' || res.kind === 'no_line') res.candidates = [];
    res.why = suggest(st, res, tech, email);
    return res;
  }

  // Plain-English "what happened and what to do next" for a person.
  function suggest(st, res, tech, email) {
    const p = res.parsed, pr = st.payRun, run = runOf(st);
    const fn = tech ? first(tech.name) : '';
    const owedLines = res.techId ? pr.lines.filter(l => l.techId === res.techId && !run.covered[l.jobId]) : [];
    const owed = owedLines.reduce((s, l) => s + l.payCents, 0);
    switch (res.kind) {
      case 'unreadable':
        return `It couldn't find the ${listJobs(p.missing)} in this email, so it won't act on it. Open the email, and if it's a real transfer, type the details in with “Fix”.`;
      case 'no_line':
        return `Nobody in pay run ${pr.id} is called “${p.payee}”, and ${p.ref} isn't a pay-run reference. It's probably a supplier payment that landed in the bank label. File it with supplier bills. Nothing gets marked paid.`;
      case 'duplicate': {
        const d = run.transfers.find(t => t.emailId === res.dupOf);
        const mins = d ? Math.round((email.receivedAt - d.receivedAt) / 60000) : null;
        return `Possible double payment. ${tech.name} was already paid ${money(p.amountCents)} with ref ${p.ref} (${d ? d.confirmation : 'earlier'}). This second transfer has a new confirmation # and went out ${mins != null && mins >= 0 ? mins + ' minutes later' : 'separately'}. Ask ${BANK.name} to recall one, or ask ${fn} to return ${money(p.amountCents)}, or hold it against ${pron(res.techId)} next pay run.`;
      }
      case 'paid_twice': {
        const ls = res.jobIds.map(id => jobById(st, id)).filter(Boolean);
        const h = ls.filter(l => st.history[l.jobId]);
        return `Possible double payment. ${h.length ? h.map(l => `${l.jobId} was already paid on ${fmtShort(l.paidAt)} (${l.ref})`).join('; ') : listJobs(res.jobIds) + ' was already proven paid in this run'}. Ask ${fn} to return ${money(p.amountCents)} or deduct it from ${pron(res.techId)} next pay run. ${fn} is still owed ${money(owed)} for this run${owedLines.length ? ` (${listJobs(owedLines.map(l => l.jobId))})` : ''}.`;
      }
      case 'payee':
        return `The bank shows payee “${p.payee}”${p.account ? ` ••••${p.account}` : ''}, but the ${res.jobIds.length ? `amount (${listJobs(res.jobIds)}) and ref are ${tech.name}'s` : `ref is ${tech.name}'s`}${PAYEES[res.techId] ? `, and ${pron(res.techId)} saved account is ••••${PAYEES[res.techId].account}` : ''}. The money may have gone to the wrong saved payee. Call ${BANK.name} before marking anything paid. If it went to the wrong person, ask the bank to recall it. If “${p.payee}” really is ${fn}, add the name to the known-names table.`;
      case 'amount': {
        const d = res.diffCents;
        if (d == null) return `The amount doesn't match the jobs listed in the memo. Check the memo with the office.`;
        const abs = money(Math.abs(d));
        const single = owedLines.find(l => l.payCents === Math.abs(d));
        if (d < 0) return `Transfer is ${abs} short of ${fn}'s pay-run total of ${money(owed)}. ` +
          (single ? `That's exactly ${single.jobId} (${shortWhy(single)}), so ${single.jobId} was probably left out. ` : `No combination of ${pron(res.techId)} jobs adds up to ${money(p.amountCents)}, and ${abs} isn't any one job's pay, so the amount was probably mistyped or a deduction nobody wrote down. `) +
          `Check with the bank or ${fn}, then send a ${abs} top-up.`;
        return `Transfer is ${abs} over ${fn}'s pay-run total of ${money(owed)}. ` +
          (single ? `That's exactly ${single.jobId}'s pay, so it may have been counted twice. ` : 'It doesn\'t match any job, so the amount was probably mistyped. ') +
          `Ask ${fn} to return ${abs}, or hold it against ${pron(res.techId)} next pay run.`;
      }
      case 'ambiguous':
        return `${money(p.amountCents)} matches more than one set of ${fn}'s jobs, so it can't prove which ones were paid. Ask the office which jobs it was for, then use “Fix” to put the job numbers in the memo.`;
      case 'date':
        return `This transfer is dated ${fmtShort(keyToMs(p.date))}, outside pay run ${pr.id}'s window (${fmtShort(keyToMs(pr.window.from))} to ${fmtShort(keyToMs(pr.window.to))}). It can't be the payment for these jobs. Check the date with ${BANK.name}. If it really is ${fmtShort(keyToMs(p.date))}, it was a different payment and ${fn} is still owed ${money(owed)}${owedLines.length ? ` for ${listJobs(owedLines.map(l => l.jobId))}` : ''}.`;
      case 'ref':
        return `The reference ${p.ref} doesn't match ${tech.name}'s ${tech.ref}. Check that the transfer went to the right person before marking ${listJobs(res.candidates) || 'anything'} paid.`;
      case 'owner':
        return `${res.checks.find(c => c.k === 'owner').detail} Check the memo with the office before marking anything paid.`;
      default:
        return 'Something didn\'t match. A person should look.';
    }
  }

  // ---------------------------------------------------------------- the pipeline
  function log(st, e) { st.log.unshift(Object.assign({ id: 'L' + (++st.seq), at: now(), shadow: st.shadow }, e)); return st.log[0]; }
  const brief = r => r.checks.map(c => ({ name: c.name, pass: c.pass, label: c.label }));

  function process(st, emailId) {
    const run = runOf(st);
    const email = st.inbox.find(e => e.id === emailId);
    if (!email) return null;
    if (run.processed[emailId]) {
      const e = log(st, { kind: 'skipped', emailId, title: `${emailId}: already checked, skipped`, detail: 'The same email is never processed twice.' });
      return { outcome: 'skipped', emailId, reason: 'same_email', logEntry: e };
    }
    const parsed = parseEmail(email.body, email.receivedAt);
    // Never twice: a confirmation # already checked means the bank re-sent the same email.
    const same = parsed.confirmation && run.transfers.find(t => t.confirmation === parsed.confirmation);
    if (same) {
      run.processed[emailId] = { outcome: 'skipped', at: now(), sameAs: same.emailId };
      run.results[emailId] = { emailId, parsed, outcome: 'skipped', sameAs: same.emailId, checks: [], jobIds: [], candidates: [],
        why: `Same confirmation # (${parsed.confirmation}) as ${same.emailId}. The bank sent the same confirmation again; it isn't a second transfer. Skipped, nothing changed.` };
      const e = log(st, { kind: 'skipped', emailId, title: `${emailId}: same confirmation as ${same.emailId}, skipped`, detail: run.results[emailId].why });
      return Object.assign({ logEntry: e }, run.results[emailId]);
    }
    const r = evaluate(st, email, parsed);
    return apply(st, email, r, null);
  }

  function apply(st, email, r, via) {
    const run = runOf(st);
    r.at = now(); r.shadow = st.shadow;
    run.results[email.id] = r;
    run.processed[email.id] = { outcome: r.outcome, kind: r.kind, at: r.at, doublePay: r.doublePay, amountCents: r.parsed.amountCents };
    run.transfers.push({ emailId: email.id, techId: r.techId, amountCents: r.parsed.amountCents, ref: r.parsed.ref, confirmation: r.parsed.confirmation, outcome: r.outcome, receivedAt: email.receivedAt });
    if (r.outcome === 'proven') {
      for (const id of r.jobIds) run.covered[id] = email.id;
      if (!st.shadow) for (const id of r.jobIds) st.paid[id] = { ref: r.parsed.ref, confirmation: r.parsed.confirmation, at: r.at, emailId: email.id, by: via ? 'person' : 'proof' };
      r.logEntry = log(st, { kind: st.shadow ? 'would' : 'paid', emailId: email.id,
        title: `${st.shadow ? 'WOULD mark' : 'Marked'} ${listJobs(r.jobIds)} paid`,
        detail: `${money(r.parsed.amountCents)} to ${r.parsed.payee} · ${r.parsed.ref} · ${r.parsed.confirmation}. ${mathOf(st, r.jobIds)}${r.jobIds.length > 1 ? ' = ' + money(r.parsed.amountCents) : ''}.${via ? ' ' + via : ''}`, checks: brief(r) });
    } else {
      if (!st.shadow) {
        const item = { id: 'P' + (++st.seq), emailId: email.id, at: r.at, status: 'open', kind: r.kind, title: r.title, why: r.why,
          candidates: r.candidates, diffCents: r.diffCents, doublePay: r.doublePay, techId: r.techId };
        st.person.unshift(item);
        r.personId = item.id;
      }
      r.logEntry = log(st, { kind: st.shadow ? 'would' : 'person', emailId: email.id,
        title: `${st.shadow ? 'WOULD send to a person' : 'Sent to a person'}: ${email.id} ${r.title.toLowerCase()}`, detail: r.why, checks: brief(r), doublePay: r.doublePay });
    }
    return r;
  }

  // A person decides: approve with a note, reject, or fix what was read and re-run the checks.
  function resolve(st, personId, action, o) {
    o = o || {};
    const item = st.person.find(p => p.id === personId);
    if (!item || item.status !== 'open') return { error: 'closed' };
    const email = st.inbox.find(e => e.id === item.emailId);
    const run = st.runs.live;
    const note = String(o.note || '').trim();
    if (action === 'approve') {
      if (!note) return { error: 'note', message: 'Add a note saying why it is OK to mark these jobs paid.' };
      const r = run.results[item.emailId];
      const ids = item.candidates.filter(id => !run.covered[id]);
      for (const id of ids) { run.covered[id] = item.emailId; st.paid[id] = { ref: r.parsed.ref, confirmation: r.parsed.confirmation, at: now(), emailId: item.emailId, by: 'person', note }; }
      item.status = 'approved'; item.note = note; item.closedAt = now();
      item.resolution = ids.length ? `Approved: ${listJobs(ids)} marked paid by a person. “${note}”` : `Approved, nothing marked paid. “${note}”`;
      log(st, { shadow: false, kind: 'approved', emailId: item.emailId, title: ids.length ? `Approved by a person: ${listJobs(ids)} marked paid` : `Approved by a person: ${item.emailId} closed, nothing marked paid`, detail: `Note: ${note}` });
      return { outcome: 'approved', jobIds: ids, item };
    }
    if (action === 'reject') {
      item.status = 'rejected'; item.note = note; item.closedAt = now();
      item.resolution = `Rejected: nothing marked paid.${note ? ' “' + note + '”' : ''}`;
      log(st, { shadow: false, kind: 'rejected', emailId: item.emailId, title: `Rejected by a person: ${item.emailId}, nothing marked paid`, detail: note ? `Note: ${note}` : '' });
      return { outcome: 'rejected', item };
    }
    if (action === 'fix') {
      const f = o.fields || {};
      const old = run.results[item.emailId].parsed;
      const parsed = Object.assign({}, old, {
        payee: f.payee != null ? String(f.payee).trim() : old.payee,
        amountCents: f.amount != null ? toCents(f.amount) : old.amountCents,
        ref: f.ref != null ? String(f.ref).trim().toUpperCase() : old.ref,
        date: f.date != null ? (parseDate(f.date, email.receivedAt) || null) : old.date,
        account: f.account != null ? (String(f.account).replace(/\D/g, '').slice(-4) || null) : old.account,
        confirmation: f.confirmation != null ? String(f.confirmation).trim().toUpperCase() : old.confirmation,
      });
      if (f.memo != null) { parsed.memo = String(f.memo).trim(); parsed.memoJobs = parsed.memo.toUpperCase().match(RX.jobs) || []; }
      parsed.missing = [];
      if (parsed.amountCents == null || isNaN(parsed.amountCents)) parsed.missing.push('amount');
      if (!parsed.payee) parsed.missing.push('payee');
      if (!parsed.ref) parsed.missing.push('reference');
      if (!parsed.date) parsed.missing.push('date');
      if (!parsed.confirmation) parsed.missing.push('confirmation #');
      parsed.ok = !parsed.missing.length; parsed.format = 'fixed by a person';
      // Re-run against the run as it is now, without this transfer's own earlier record.
      const saved = run.transfers; run.transfers = run.transfers.filter(t => t.emailId !== item.emailId);
      const shadow = st.shadow; st.shadow = false;
      const r = evaluate(st, email, parsed);
      run.transfers = saved;
      if (r.outcome === 'proven') {
        run.transfers = run.transfers.filter(t => t.emailId !== item.emailId);
        apply(st, email, r, `Fixed by a person${note ? ': ' + note : ''}.`);
        st.shadow = shadow;
        item.status = 'fixed'; item.closedAt = now(); item.note = note;
        item.resolution = `Fixed and proven: ${listJobs(r.jobIds)} marked paid.${note ? ' “' + note + '”' : ''}`;
        return { outcome: 'fixed', result: r, item };
      }
      st.shadow = shadow;
      Object.assign(item, { kind: r.kind, title: r.title, why: r.why, candidates: r.candidates, diffCents: r.diffCents, doublePay: r.doublePay, techId: r.techId, fixed: true });
      run.results[item.emailId] = Object.assign(r, { at: now(), personId: item.id });
      log(st, { shadow: false, kind: 'person', emailId: item.emailId, title: `Fix re-checked: ${item.emailId} still ${r.title.toLowerCase()}`, detail: r.why, checks: brief(r) });
      return { outcome: 'still', result: r, item };
    }
    return { error: 'action' };
  }

  function setShadow(st, on) {
    st.shadow = !!on;
    log(st, { kind: 'admin', title: on ? 'Shadow mode turned ON: transfers are checked, nothing is marked paid' : 'Shadow mode turned OFF: proven transfers mark jobs paid for real',
      detail: on ? 'The log says what it WOULD do.' : 'Emails checked in shadow mode can be checked again for real.' });
  }

  function counts(st) {
    const run = runOf(st);
    const res = Object.values(run.results);
    const proven = res.filter(r => r.outcome === 'proven');
    const shadow = st.shadow;
    return {
      proven: proven.length,
      jobsPaid: shadow ? Object.keys(run.covered).length : Object.keys(st.paid).length,
      provenCents: proven.reduce((s, r) => s + r.parsed.amountCents, 0),
      held: shadow ? res.filter(r => r.outcome === 'person').length : st.person.filter(p => p.status === 'open').length,
      doubles: res.filter(r => r.doublePay).length,
      skipped: res.filter(r => r.outcome === 'skipped').length,
      checked: res.length,
      left: st.inbox.filter(e => !run.processed[e.id]).length,
    };
  }
  // Status of one pay-run line, for the table.
  function lineStatus(st, jobId) {
    const run = runOf(st);
    if (st.paid[jobId] && !st.shadow) return Object.assign({ status: 'paid' }, st.paid[jobId]);
    if (st.shadow && run.covered[jobId]) { const r = run.results[run.covered[jobId]]; return { status: 'would', emailId: run.covered[jobId], confirmation: r.parsed.confirmation, ref: r.parsed.ref }; }
    if (!st.shadow) { const p = st.person.find(x => x.status === 'open' && (x.candidates.includes(jobId))); if (p) return { status: 'held', personId: p.id, emailId: p.emailId }; }
    return { status: 'owed' };
  }

  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const P = {
    PAY_RATE_PCT, RULE_TEXT, WINDOW_DAYS, BANK, OPERATING, PAYEES, KIND_TITLE,
    toCents, money, payFor, dollars, parseDate, dayKey, keyToMs, isoWeek, fmtShort, fmtDay, fmtTime, fmtStamp, esc,
    buildPayRun, buildHistory, buildInbox, bankEmail, parseEmail, matchPayee, subsetSum, refFor,
    createState, runOf, evaluate, process, resolve, setShadow, counts, lineStatus, jobById, listJobs,
  };
  root.Proofing = P;
  if (typeof module !== 'undefined' && module.exports) module.exports = P;
})(typeof window !== 'undefined' ? window : globalThis);
