// Node tests for the M4 engine. Run from the project folder:  node tests/engine.test.js
// No test framework needed. Exits with code 1 on the first failure.
'use strict';
global.window = global;
require('../shared/data.js');
const P = require('../engine.js');

let passed = 0;
function ok(cond, msg) {
  if (!cond) { console.error('  FAIL -', msg); process.exit(1); }
  passed++; console.log('  ok -', msg);
}
const section = s => console.log('\n' + s);
const fresh = (o = {}) => P.createState(Object.assign({ shadow: false }, o));
const check = (r, k) => r.checks.find(c => c.k === k);
const failed = r => r.checks.filter(c => c.pass === false).map(c => c.k);
const runAll = st => st.inbox.map(e => P.process(st, e.id));
// A custom bank email, added to the inbox so it can be processed like the real ones.
let n = 0;
function add(st, o) {
  const pr = st.payRun;
  const e = P.bankEmail(Object.assign({ id: 'X' + (++n), acct: '0000', conf: 'CRB-TEST-' + String(n).padStart(4, '0'), sentAt: pr.runDay + 3600000 }, o));
  st.inbox.push(e);
  return e;
}

section('Money is whole cents');
{
  ok(P.toCents('1,240.00') === 124000, '"1,240.00" → 124000 cents');
  ok(P.toCents('$0.10') + P.toCents('$0.20') === P.toCents('0.30'), '$0.10 + $0.20 is exactly $0.30 (no float error)');
  ok(0.1 + 0.2 !== 0.3, '(while 0.1 + 0.2 in floating point is not 0.3)');
  ok(P.toCents('12.3') === 1230 && P.toCents('7') === 700, '"12.3" → 1230, "7" → 700');
  ok(isNaN(P.toCents('twelve')) && isNaN(P.toCents('1.234')), 'garbage and 3 decimals are rejected, not rounded');
  ok(P.money(124000) === '$1,240.00' && P.money(5) === '$0.05' && P.money(-4000) === '-$40.00', 'money() formats cents');
  ok(P.payFor(223) === 10035, '45% of $223 = $100.35');
  ok(P.payFor(251) === 11295 && P.payFor(398) === 17910, '45% of $251 = $112.95, of $398 = $179.10');
  ok(P.payFor(223.33) === 10050, '45% of $223.33 = $100.4985 → rounds to $100.50');
  ok(P.payFor(0.01) === 0 && P.payFor(0.03) === 1, 'tiny amounts round half up to the cent');
}

section('Pay run from the shared jobs');
{
  const st = fresh(), pr = st.payRun;
  ok(pr.lines.length === 11, '11 completed/invoiced jobs fall in the 14-day period');
  ok(pr.lines.every(l => l.completedAt >= pr.periodStart && l.completedAt <= pr.periodEnd), 'every line was finished inside the period');
  ok(pr.lines.every(l => l.payCents === P.payFor(l.revenue)), 'every line is 45% of its revenue');
  ok(pr.techs.T1.totalCents === 56655 && pr.techs.T1.jobIds.join() === 'SH-1013,SH-1017,SH-1022', 'Marcus: 3 jobs, $566.55');
  ok(pr.techs.T2.totalCents === 34470, 'Dana: $344.70');
  ok(pr.techs.T3.totalCents === 12060 && pr.techs.T4.totalCents === 15210 && pr.techs.T5.totalCents === 29520, 'Luis $120.60, Priya $152.10, Jake $295.20');
  ok(pr.totalCents === pr.lines.reduce((s, l) => s + l.payCents, 0), 'run total = sum of lines');
  ok(pr.techs.T1.ref === `PAY-W${pr.week}-MR`, 'expected ref is PAY-W<week>-<initials>');
  ok(pr.window.from === P.dayKey(pr.runDay) && pr.window.to > pr.window.from, 'pay window starts on the run day');
  ok(st.history['SH-1009'] && st.history['SH-1009'].ref.startsWith('PAY-W') && !pr.lines.some(l => l.jobId === 'SH-1009'), 'SH-1009 was paid in an earlier run, not this one');
  ok(!pr.lines.some(l => l.jobId === 'SH-1024'), 'SH-1024 (finished after the period) is not in this run');
}

section('Reading bank emails');
{
  const st = fresh();
  const e1 = P.parseEmail(st.inbox[0].body, st.inbox[0].receivedAt);
  ok(e1.ok && e1.amountCents === 12060 && e1.payee === 'Luis Ortega' && e1.ref === st.payRun.techs.T3.ref, 'summary line: amount, payee, ref');
  ok(e1.date === P.dayKey(st.payRun.runDay) && e1.account === '7730' && e1.confirmation === 'CRB-5Q2K-1187', 'summary line: date, masked account, confirmation');
  ok(e1.memoJobs.length === 0, '"Memo: (none)" means no jobs listed');
  const fw = P.parseEmail(st.inbox.find(e => e.id === 'E09').body, Date.now());
  ok(fw.ok && fw.format === 'receipt fields' && fw.amountCents === 15210 && fw.payee === 'Priya Nair' && fw.account === '6248', 'forwarded receipt format is read too');
  const one = P.parseEmail('Cedar Ridge Bank\nYou sent $1,240.00 to Marcus Reyes · ref PAY-W45-MR · Nov 6\nConfirmation: CRB-AAAA-0001', +new Date(2026, 10, 8));
  ok(one.ok && one.amountCents === 124000 && one.date === '2026-11-06', 'the one-line format from the brief: "$1,240.00 to Marcus Reyes · ref PAY-W45-MR · Nov 6"');
  const pipes = P.parseEmail('You sent $80.55 to Dana Whitfield | ref PAY-W45-DW | Nov 7, 2026\nMemo: SH-1023\nConfirmation #: CRB-AAAA-0002', Date.now());
  ok(pipes.ok && pipes.memoJobs[0] === 'SH-1023' && pipes.confirmation === 'CRB-AAAA-0002', 'pipe separators, memo job numbers, "Confirmation #:"');
  const bad = P.parseEmail('Your statement is ready. Log in to see it.', Date.now());
  ok(!bad.ok && bad.missing.includes('amount') && bad.missing.includes('payee'), 'an email without transfer details is not ok, with what is missing');
  ok(P.parseDate('Jan 3', +new Date(2026, 10, 8)) === '2026-01-03' && P.parseDate('Dec 30', +new Date(2027, 0, 2)) === '2026-12-30', 'year inferred, and a December date read in January is last year');
  ok(P.parseDate('11/06/2026') === '2026-11-06' && P.parseDate('Feb 31, 2026') === null, 'US dates read; impossible dates rejected');
}

section('Payee and known-names table');
{
  ok(P.matchPayee('Marcus Reyes').how === 'exact', 'exact name matches');
  const a = P.matchPayee('M. Reyes', '4410');
  ok(a.techId === 'T1' && a.how === 'alias' && a.accountOk === true, '"M. Reyes" matches Marcus via the known-names table, account ok');
  ok(P.matchPayee('m reyes').techId === 'T1' && P.matchPayee('REYES, MARCUS').techId === 'T1', 'case and punctuation are ignored');
  ok(P.matchPayee('Jake Moore') === null && P.matchPayee('Marco Reyes') === null, 'a different name never matches, however close');
  ok(P.matchPayee('Luis Ortega', '1111').accountOk === false, 'right name, wrong account is flagged');
}

section('Subset sum for combined transfers');
{
  const items = [{ id: 'A', cents: 27450 }, { id: 'B', cents: 11295 }, { id: 'C', cents: 17910 }];
  ok(JSON.stringify(P.subsetSum(items, 38745)) === '[["A","B"]]', '$387.45 = A + B, and only A + B');
  ok(P.subsetSum(items, 56655).length === 1 && P.subsetSum(items, 56655)[0].length === 3, 'all three = $566.55');
  ok(P.subsetSum(items, 38746).length === 0, 'one cent off: no answer');
  const twins = [{ id: 'A', cents: 10035 }, { id: 'B', cents: 10035 }, { id: 'C', cents: 8055 }];
  ok(P.subsetSum(twins, 10035).length === 2, 'two jobs with the same pay: two answers (ambiguous)');
  const many = Array.from({ length: 18 }, (_, i) => ({ id: 'J' + i, cents: 1000 + i * 37 }));
  ok(P.subsetSum(many, 1000 + 1037 + 1074).length >= 1, 'an 18-job list is searched quickly');
}

section('Every inbox email, live mode');
{
  const st = fresh();
  const R = {}; for (const e of st.inbox) R[e.id] = P.process(st, e.id);
  ok(R.E01.outcome === 'proven' && R.E01.jobIds.join() === 'SH-1018', 'exact match: one transfer = Luis\'s one job → proven');
  ok(R.E02.outcome === 'proven' && R.E02.jobIds.join() === 'SH-1013,SH-1017' && /\+/.test(check(R.E02, 'amount').detail), 'combined: $387.45 proven by summing SH-1013 + SH-1017');
  ok(R.E03.outcome === 'person' && R.E03.kind === 'amount' && R.E03.diffCents === -4000, '$40.00 short → person, difference -$40.00');
  ok(/\$40\.00 short of Dana's pay-run total of \$344\.70/.test(R.E03.why) && /top-up/.test(R.E03.why), 'short: plain-English reason and a next step');
  ok(failed(R.E03).join() === 'amount', 'short: only the amount check fails');
  ok(R.E04.outcome === 'person' && R.E04.kind === 'duplicate' && R.E04.doublePay, 'sent twice → person, flagged as possible double payment');
  ok(/CRB-5Q2K-1187/.test(R.E04.why) && /recall/.test(R.E04.why), 'duplicate: names the first transfer and suggests a recall');
  ok(R.E05.kind === 'payee' && failed(R.E05).join() === 'payee', '"Jake Moore" → wrong payee, only the payee check fails');
  ok(/••••3307/.test(R.E05.why) && R.E05.candidates.join() === 'SH-1016,SH-1021', 'wrong payee: shows saved account and the jobs it might cover');
  ok(R.E06.kind === 'paid_twice' && R.E06.doublePay && /SH-1009 was already paid/.test(R.E06.why), 'job already paid in an earlier run → person, double payment');
  ok(R.E07.kind === 'no_line' && R.E07.candidates.length === 0, 'no matching pay-run line → person');
  ok(R.E08.outcome === 'proven' && R.E08.jobIds.join() === 'SH-1022' && check(R.E08, 'payee').label.startsWith('Known name'), '"M. Reyes" proven via alias');
  ok(R.E09.kind === 'date' && failed(R.E09).join() === 'date', 'outside the date window → person, only the date check fails');
  ok(R.E10.outcome === 'skipped' && R.E10.sameAs === 'E02', 'same confirmation # re-sent → skipped, not a second payment');
  for (const e of st.inbox.filter(x => x.expect)) {
    const r = R[e.id];
    const got = r.outcome === 'person' ? r.kind : r.outcome;
    ok(got === e.expect, `${e.id} (${e.label}) → ${e.expect}`);
  }
  ok(Object.keys(st.paid).sort().join() === 'SH-1013,SH-1017,SH-1018,SH-1022', 'only the 4 proven jobs are marked paid. Nothing on a guess.');
  ok(Object.values(st.paid).every(p => /^CRB-/.test(p.confirmation) && /^PAY-W/.test(p.ref)), 'paid jobs carry the transfer ref and confirmation #');
  const c = P.counts(st);
  ok(c.proven === 3 && c.jobsPaid === 4 && c.provenCents === 68715 && c.held === 6 && c.doubles === 2, 'summary: 3 proven, 4 jobs paid, $687.15, 6 held, 2 double payments caught');
  ok(st.person.length === 6 && st.person.every(p => p.status === 'open' && p.why), '6 Needs a person items, each with a reason');
  ok(P.lineStatus(st, 'SH-1018').status === 'paid' && P.lineStatus(st, 'SH-1020').status === 'held' && P.lineStatus(st, 'SH-1015').status === 'held', 'pay run rows: paid, held');
  ok(st.log.length === 10 && st.log.every(l => l.at && l.title), 'every email logged with a timestamp');
}

section('Same email never processed twice');
{
  const st = fresh();
  ok(P.process(st, 'E01').outcome === 'proven', 'first time: proven');
  const again = P.process(st, 'E01');
  ok(again.outcome === 'skipped' && again.reason === 'same_email', 'second time: skipped');
  ok(Object.keys(st.paid).length === 1 && P.counts(st).proven === 1, 'nothing changed');
}

section('Shadow mode');
{
  const st = fresh({ shadow: true });
  ok(st.shadow === true && P.createState().shadow === true, 'shadow mode is the default');
  runAll(st);
  ok(Object.keys(st.paid).length === 0, 'shadow: no job marked paid');
  ok(st.person.length === 0, 'shadow: nothing queued for a person');
  const w = st.log.find(l => l.emailId === 'E02');
  ok(w.kind === 'would' && /^WOULD mark SH-1013 and SH-1017 paid/.test(w.title), 'shadow: log says "WOULD mark SH-1013 and SH-1017 paid"');
  ok(st.log.some(l => /^WOULD send to a person/.test(l.title)), 'shadow: log says "WOULD send to a person"');
  ok(P.lineStatus(st, 'SH-1018').status === 'would', 'shadow: pay run row shows "would be paid", not paid');
  const c = P.counts(st);
  ok(c.proven === 3 && c.held === 6 && c.doubles === 2, 'shadow: same decisions as live');
  P.setShadow(st, false);
  ok(P.process(st, 'E01').outcome === 'proven' && st.paid['SH-1018'], 'after going live, the same email is checked again for real');
  ok(P.process(st, 'E01').outcome === 'skipped', '…and only once');
}

section('More problem cases');
{
  const st = fresh(); P.process(st, 'E01');
  const over = add(st, { payee: 'Dana Whitfield', cents: 34470 + 4000, ref: st.payRun.techs.T2.ref, acct: '9052' });
  const r = P.process(st, over.id);
  ok(r.kind === 'amount' && r.diffCents === 4000 && /\$40\.00 over/.test(r.why) && /return \$40\.00/.test(r.why), '$40.00 over → person, suggests a $40.00 return');
  const left = add(st, { payee: 'Marcus Reyes', cents: 56655 + 1, ref: st.payRun.techs.T1.ref, acct: '4410' });
  ok(P.process(st, left.id).diffCents === 1, 'one cent over is caught');

  const wrongRef = add(st, { payee: 'Dana Whitfield', cents: 34470, ref: st.payRun.techs.T3.ref, acct: '9052' });
  const rr = P.process(st, wrongRef.id);
  ok(rr.kind === 'ref' && failed(rr).join() === 'ref' && /Luis Ortega's reference/.test(check(rr, 'ref').detail), 'Dana paid with Luis\'s ref → reference check fails');

  const acct = add(st, { payee: 'Priya Nair', cents: 15210, ref: st.payRun.techs.T4.ref, acct: '9999' });
  const ra = P.process(st, acct.id);
  ok(ra.kind === 'payee' && /isn't her saved account ••••6248/.test(check(ra, 'payee').detail), 'right name, wrong account → payee check fails');

  const other = add(st, { payee: 'Luis Ortega', cents: 10035, ref: st.payRun.techs.T3.ref, acct: '7730', memo: 'SH-1020' });
  const ro = P.process(st, other.id);
  ok(ro.kind === 'owner' && /SH-1020 was done by Dana Whitfield/.test(check(ro, 'owner').detail), 'memo lists Dana\'s job on Luis\'s transfer → "every job is that tech\'s" fails');

  const next = add(st, { payee: 'Luis Ortega', cents: P.payFor(341), ref: st.payRun.techs.T3.ref, acct: '7730', memo: 'SH-1024' });
  const rn = P.process(st, next.id);
  ok(rn.kind === 'owner' && /next run/.test(check(rn, 'owner').detail), 'a job from the next period is refused');

  const late = add(st, { payee: 'Jake Morrow', cents: 29520, ref: st.payRun.techs.T5.ref, acct: '3307', sentAt: st.payRun.runDay + 9 * 86400000 });
  ok(P.process(st, late.id).kind === 'date', 'a transfer dated after the window → person');

  const memoUnknown = add(st, { payee: 'Jake Morrow', cents: 29520, ref: st.payRun.techs.T5.ref, acct: '3307', memo: 'SH-9999' });
  ok(P.process(st, memoUnknown.id).outcome === 'person', 'a memo with an unknown job number → person');

  const unread = { id: 'X-unread', from: 'alerts@cedarridge-bank.example', subject: 'Statement ready', body: 'Your November statement is ready.', receivedAt: Date.now() };
  st.inbox.push(unread);
  const ru = P.process(st, unread.id);
  ok(ru.kind === 'unreadable' && ru.outcome === 'person', 'an email it can\'t read → person, nothing guessed');
}

section('Never on a guess: two sets of jobs fit');
{
  const st = fresh();
  // A second Dana job that pays exactly what SH-1020 pays.
  const twin = Object.assign({}, st.payRun.lines.find(l => l.jobId === 'SH-1020'), { jobId: 'SH-9001' });
  st.payRun.lines.push(twin);
  const e = add(st, { payee: 'Dana Whitfield', cents: twin.payCents, ref: st.payRun.techs.T2.ref, acct: '9052' });
  const r = P.process(st, e.id);
  ok(r.kind === 'ambiguous' && r.outcome === 'person' && /won't guess/.test(check(r, 'amount').detail), '$100.35 fits SH-1020 or SH-9001 → person, it won\'t guess');
  ok(!st.paid['SH-1020'] && !st.paid['SH-9001'], 'neither job marked paid');
}

section('Partial payment: the jobs that add up are proven, the rest stay owed');
{
  const st = fresh();
  const e = add(st, { payee: 'Dana Whitfield', cents: P.payFor(364) + P.payFor(179), ref: st.payRun.techs.T2.ref, acct: '9052' });
  const r = P.process(st, e.id);
  ok(r.outcome === 'proven' && r.jobIds.join() === 'SH-1015,SH-1023', '$244.35 = SH-1015 + SH-1023, proven');
  ok(P.lineStatus(st, 'SH-1020').status === 'owed', 'SH-1020 still owed');
  const e2 = add(st, { payee: 'D. Whitfield', cents: P.payFor(223), ref: st.payRun.techs.T2.ref, acct: '9052' });
  ok(P.process(st, e2.id).jobIds.join() === 'SH-1020', 'a later $100.35 transfer proves SH-1020');
  const e3 = add(st, { payee: 'Dana Whitfield', cents: P.payFor(364), ref: st.payRun.techs.T2.ref, acct: '9052', memo: 'SH-1015' });
  const r3 = P.process(st, e3.id);
  ok(r3.kind === 'paid_twice' && r3.doublePay && /already proven paid/.test(check(r3, 'twice').label), 'another transfer for SH-1015 → already proven paid in this run');
  const e4 = add(st, { payee: 'Dana Whitfield', cents: P.payFor(223), ref: st.payRun.techs.T2.ref, acct: '9052' });
  ok(P.process(st, e4.id).kind === 'duplicate', 'and the same $100.35 again → duplicate transfer');
}

section('A person decides');
{
  const st = fresh(); runAll(st);
  const short = st.person.find(p => p.emailId === 'E03');
  ok(short.candidates.join() === 'SH-1015,SH-1020,SH-1023', 'the short transfer lists the jobs it might cover');
  ok(P.resolve(st, short.id, 'approve', { note: '' }).error === 'note', 'approve needs a note');
  const a = P.resolve(st, short.id, 'approve', { note: 'Dana agreed a $40 deduction for a lost part.' });
  ok(a.outcome === 'approved' && st.paid['SH-1020'] && st.paid['SH-1020'].by === 'person', 'approve with a note: jobs marked paid, by a person');
  ok(st.log[0].kind === 'approved' && /deduction/.test(st.log[0].detail), 'approval logged with the note');
  ok(P.resolve(st, short.id, 'reject').error === 'closed', 'a closed item can\'t be decided twice');

  const dup = st.person.find(p => p.emailId === 'E04');
  const rj = P.resolve(st, dup.id, 'reject', { note: 'Asked the bank to recall it.' });
  ok(rj.outcome === 'rejected' && dup.status === 'rejected' && P.counts(st).jobsPaid === 7, 'reject: nothing new marked paid');

  const date = st.person.find(p => p.emailId === 'E09');
  const still = P.resolve(st, date.id, 'fix', { fields: { ref: 'PAY-W00-XX' } });
  ok(still.outcome === 'still' && date.status === 'open', 'fix that still fails: item stays open with fresh checks');
  const fx = P.resolve(st, date.id, 'fix', { fields: { date: P.fmtShort(st.payRun.runDay) + ', ' + new Date(st.payRun.runDay).getFullYear(), ref: st.payRun.techs.T4.ref }, note: 'Bank confirmed it was sent on the run day.' });
  ok(fx.outcome === 'fixed' && st.paid['SH-1014'] && st.paid['SH-1019'] && date.status === 'fixed', 'fix the date (bank confirmed) → checks re-run → proven, jobs paid');

  const payee = st.person.find(p => p.emailId === 'E05');
  const fp = P.resolve(st, payee.id, 'fix', { fields: { payee: 'Jake Morrow', account: '3307' } });
  ok(fp.outcome === 'fixed' && st.paid['SH-1016'], 'fix the payee after the bank confirms → proven');
  ok(P.counts(st).held === 2, '2 items left for a person');
}

console.log(`\n${passed} checks passed`);
