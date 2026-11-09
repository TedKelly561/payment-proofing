// Payment Proofing (M4): the page.
// All decisions live in engine.js (window.Proofing). This file only draws state and wires buttons.
// State is saved in localStorage (wrapped in try/catch, so a private window still works).

(function () {
  'use strict';
  const P = window.Proofing, S = window.SUMMIT;
  const $ = s => document.querySelector(s);
  const esc = P.esc, money = P.money;
  const KEY = 'm4-payment-proofing-v1';
  const store = {
    get(k, fb) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : fb; } catch (e) { return fb; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage blocked: lives in memory */ } },
  };
  const params = new URLSearchParams(location.search);
  const reduce = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---------------------------------------------------------------- state
  let st, ui, busy = false, lastStatus = {};
  function load() {
    const saved = params.get('reset') === '1' ? null : store.get(KEY, null);
    // Dates are relative to today, so a save from another day starts fresh.
    if (saved && saved.state && saved.state.v === 1 && saved.day === S.today) { st = saved.state; ui = Object.assign(defaultUi(), saved.ui || {}); }
    else { st = P.createState(); ui = defaultUi(); }
    if (params.has('shadow')) st.shadow = params.get('shadow') !== '0';
    ui.fix = {};
  }
  function defaultUi() { return { open: 'E01', tab: 'person', fix: {} }; }
  function save() { store.set(KEY, { day: S.today, state: st, ui: { open: ui.open, tab: ui.tab } }); }

  // ---------------------------------------------------------------- helpers
  const run = () => P.runOf(st);
  const tech = id => S.byId(S.techs, id);
  const lines = s => esc(s).replace(/\n/g, '<br>');
  function toast(msg) {
    const t = $('#toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), 2800);
  }
  const ICON = { true: '✓', false: '×', null: '–' };
  const KIND_CHIP = { paid: ['Marked paid', 'good'], would: ['Would do', 'shade'], person: ['Needs a person', 'bad'], skipped: ['Skipped', 'warn'],
    approved: ['Approved', 'good'], rejected: ['Rejected', ''], admin: ['Note', ''] };
  function statusOf(e) {
    const p = run().processed[e.id];
    if (!p) return { tone: '', text: 'New', key: 'new' };
    if (p.outcome === 'skipped') return { tone: 'warn', text: 'Skipped', key: 'skipped' };
    if (p.outcome === 'proven') {
      const item = st.shadow ? null : st.person.find(x => x.emailId === e.id && x.status === 'fixed');
      return st.shadow ? { tone: 'shade', text: 'Would prove', key: 'would' } : { tone: 'good', text: item ? 'Fixed, proven' : 'Proven', key: 'proven' };
    }
    if (st.shadow) return { tone: 'shade', text: 'Would hold', key: 'wouldhold' };
    const item = st.person.find(x => x.emailId === e.id);
    if (item && item.status === 'approved') return { tone: 'good', text: 'Approved by a person', key: 'approved' };
    if (item && item.status === 'rejected') return { tone: '', text: 'Rejected', key: 'rejected' };
    return { tone: 'bad', text: 'Needs a person', key: 'person' };
  }
  const senderOf = e => { const m = /^(.*?)\s*<([^>]+)>$/.exec(e.from); return m ? { name: m[1], email: m[2] } : { name: e.from, email: '' }; };

  // ---------------------------------------------------------------- mode + counters
  function renderMode() {
    $('#shadow').checked = st.shadow;
    document.body.classList.toggle('is-shadow', st.shadow);
    $('#shadowState').textContent = st.shadow ? 'ON' : 'OFF';
    $('#shadowDesc').innerHTML = st.shadow
      ? '<b>Nothing is marked paid.</b> Every transfer is checked and the log says what it <i>would</i> do, e.g. “WOULD mark SH-1013 and SH-1017 paid”. Turn it off to mark jobs paid (in this demo).'
      : '<b>Live.</b> Proven transfers mark their jobs paid with the confirmation #. Anything else goes to a person.';
    const c = P.counts(st), sh = st.shadow;
    $('#counters').innerHTML = [
      [sh ? 'Would prove' : 'Transfers proven', c.proven, 'good'],
      [sh ? 'Jobs that would be paid' : 'Jobs marked paid', c.jobsPaid, 'good'],
      [sh ? '$ that would be proven' : '$ proven', money(c.provenCents), 'good'],
      [sh ? 'Would hold for a person' : 'Held for a person', c.held, c.held ? 'bad' : ''],
      ['Possible double payments caught', c.doubles, c.doubles ? 'bad' : ''],
    ].map(([k, n, tone]) => `<div class="ct ${tone}"><dt>${k}</dt><dd>${n}</dd></div>`).join('');
    $('#checkAll').disabled = busy || !c.left;
    $('#checkAll').textContent = busy ? 'Checking…' : c.left ? `Check all new transfers (${c.left})` : 'All transfers checked';
  }

  // ---------------------------------------------------------------- inbox
  function renderInbox() {
    const c = P.counts(st);
    $('#inboxSub').textContent = `${st.inbox.length} emails · ${c.checked} checked`;
    $('#inbox').innerHTML = st.inbox.map(e => {
      const s = statusOf(e), open = ui.open === e.id, snd = senderOf(e);
      const r = run().results[e.id];
      const dbl = r && r.doublePay ? '<span class="chip bad">Double payment?</span>' : '';
      return `<article class="mail st-${s.key}${open ? ' open' : ''}" id="mail-${e.id}">
        <h3 class="mail-h"><button type="button" class="mail-top" data-act="open" data-email="${e.id}" aria-expanded="${open}" aria-controls="mailb-${e.id}">
          <span class="m-av${/office/i.test(snd.name) ? ' fwd' : ''}" aria-hidden="true">${/office/i.test(snd.name) ? 'OM' : 'CR'}</span>
          <span class="m-main"><span class="m-subj">${esc(e.subject)}</span><span class="m-meta"><span class="mono">${e.id}</span> · ${esc(snd.name)} · ${esc(P.fmtStamp(e.receivedAt))}</span><span class="m-hint">${esc(e.label)}</span></span>
          <span class="m-st"><span class="chip ${s.tone}">${esc(s.text)}</span>${dbl}</span>
        </button></h3>
        <div class="mail-b" id="mailb-${e.id}" ${open ? '' : 'hidden'}>${open ? mailBody(e, r) : ''}</div>
      </article>`;
    }).join('');
  }

  function mailBody(e, r) {
    const snd = senderOf(e);
    const email = `<div class="em">
        <div class="em-h"><div><b>${esc(snd.name)}</b> <span class="muted small">&lt;${esc(snd.email)}&gt;</span></div><div class="small muted">to payroll@summit-home.example · ${esc(P.fmtStamp(e.receivedAt))}</div><div class="em-s">${esc(e.subject)}</div></div>
        <pre class="em-body">${esc(e.body)}</pre>
      </div>`;
    if (!r) {
      return `<div class="mb-grid">${email}<div class="mb-r">
        <div class="decision"><span class="d-k">Not checked yet</span><span class="d-v">${esc(e.label)}</span><p>${esc(e.hint)}</p>
        <button type="button" class="btn" data-act="check" data-email="${e.id}">Check this transfer</button></div>
        <p class="small muted">It reads the amount, payee, reference, date and confirmation #, then runs 6 checks against the pay run.</p></div></div>`;
    }
    const p = r.parsed;
    const read = p ? `<dl class="read">
        <div><dt>Payee</dt><dd>${esc(p.payee || '–')}${p.account ? ` <span class="mono muted">••••${esc(p.account)}</span>` : ''}</dd></div>
        <div><dt>Amount</dt><dd class="mono">${p.amountCents != null && !isNaN(p.amountCents) ? money(p.amountCents) : '–'}</dd></div>
        <div><dt>Reference</dt><dd class="mono">${esc(p.ref || '–')}</dd></div>
        <div><dt>Date</dt><dd>${p.date ? esc(P.fmtShort(P.keyToMs(p.date))) : '–'}</dd></div>
        <div><dt>Memo</dt><dd>${esc(p.memo || 'none')}</dd></div>
        <div><dt>Confirmation</dt><dd class="mono">${esc(p.confirmation || '–')}</dd></div>
      </dl>` : '';
    return `<div class="mb-grid"><div class="mb-l">${email}<div class="p-k">What it read <span class="muted">(${esc(p.format || '')})</span></div>${read}</div>
      <div class="mb-r">${decisionHtml(e, r)}${jobsHtml(r)}${checksHtml(r)}</div></div>`;
  }

  function decisionHtml(e, r) {
    const sh = r.shadow;
    if (r.outcome === 'skipped') return `<div class="decision warn" role="status"><span class="d-k">Never twice</span><span class="d-v">Skipped, nothing changed</span><p>${esc(r.why)}</p></div>`;
    if (r.outcome === 'proven') {
      const ids = P.listJobs(r.jobIds);
      return `<div class="decision ${sh ? 'shadow' : 'good'}" role="status"><span class="d-k">${sh ? 'Shadow mode' : 'Proven'}</span>
        <span class="d-v">${sh ? `WOULD mark ${esc(ids)} paid` : `Proven → ${esc(ids)} marked paid`}</span>
        <p>${sh ? 'Every check passes. In live mode these jobs would be marked paid with this confirmation #. The pay run is unchanged.' : `Every check passes. Marked paid with ${esc(r.parsed.ref)} · ${esc(r.parsed.confirmation)}.`}</p></div>`;
    }
    const item = st.person.find(x => x.emailId === e.id);
    const closed = item && item.status !== 'open';
    return `<div class="decision ${sh ? 'shadow' : closed ? 'info' : 'bad'}" role="status"><span class="d-k">${sh ? 'Shadow mode: would send to a person' : closed ? 'Decided by a person' : 'Needs a person'}</span>
      <span class="d-v">${esc(r.title)}</span><p>${esc(closed ? item.resolution : r.why)}</p>
      ${!sh && item && !closed ? `<button type="button" class="btn ghost small" data-act="toPerson" data-pid="${item.id}">Open in Needs a person</button>` : ''}
      <p class="small"><b>Nothing was marked paid.</b></p></div>`;
  }

  function jobsHtml(r) {
    const ids = r.jobIds && r.jobIds.length ? r.jobIds : (r.candidates || []);
    if (!ids.length) return '';
    const ls = ids.map(id => P.jobById(st, id)).filter(Boolean);
    const sum = ls.reduce((s, l) => s + l.payCents, 0);
    const amt = r.parsed.amountCents;
    const diff = amt - sum;
    const label = r.outcome === 'proven' ? 'The jobs it paid' : r.jobIds.length ? 'The jobs it looks like' : 'What the tech is owed';
    return `<div class="jobs-math"><div class="p-k">${label}</div>
      <ul>${ls.map(l => `<li><span class="mono">${esc(l.jobId)}</span><span class="jm-i">${esc(l.issue)} · ${esc(P.fmtShort(l.completedAt))}${l.paidAt ? ` · <b class="bad-t">paid ${esc(P.fmtShort(l.paidAt))}</b>` : ''}</span><span class="mono num">${money(l.payCents)}</span></li>`).join('')}</ul>
      <div class="jm-sum"><span>Jobs total</span><span class="mono num">${money(sum)}</span></div>
      <div class="jm-sum"><span>Transfer</span><span class="mono num">${money(amt)}</span></div>
      <div class="jm-sum diff ${diff === 0 ? 'good-t' : 'bad-t'}"><span>${diff === 0 ? 'Difference' : diff < 0 ? 'Short by' : 'Over by'}</span><span class="mono num">${diff === 0 ? '$0.00 ✓' : money(Math.abs(diff))}</span></div>
    </div>`;
  }

  function checksHtml(r) {
    if (!r.checks || !r.checks.length) return '';
    const pass = r.checks.filter(c => c.pass === true).length;
    return `<div class="p-k">Checks <span class="muted">(${pass} of ${r.checks.length} pass)</span></div>
      <ol class="trace" aria-label="Checks">${r.checks.map(c => `<li class="${c.pass === true ? 'good' : c.pass === false ? 'bad' : 'na'}">
        <span class="t-ic" aria-hidden="true">${ICON[c.pass]}</span><span class="sr-only">${c.pass === true ? 'Pass' : c.pass === false ? 'Fail' : 'Not checked'}:</span>
        <span class="t-k">${esc(c.name)}</span><b>${esc(c.label)}</b><span class="t-d">${esc(c.detail)}</span></li>`).join('')}</ol>`;
  }

  // ---------------------------------------------------------------- pay run
  function renderPayRun() {
    const pr = st.payRun, c = P.counts(st);
    $('#prChip').textContent = `Run ${pr.id}`;
    $('#prMeta').innerHTML = `Jobs finished <b>${esc(P.fmtShort(pr.periodStart))} – ${esc(P.fmtShort(pr.periodEnd))}</b> · paid <b>${esc(P.fmtDay(pr.runDay))}</b> · transfers accepted if dated <b>${esc(P.fmtShort(P.keyToMs(pr.window.from)))} – ${esc(P.fmtShort(P.keyToMs(pr.window.to)))}</b><br><span class="muted">${esc(P.RULE_TEXT)}</span>`;
    const paidCents = pr.lines.filter(l => ['paid', 'would'].includes(P.lineStatus(st, l.jobId).status)).reduce((s, l) => s + l.payCents, 0);
    const pct = Math.round(paidCents / pr.totalCents * 100);
    $('#prTotals').innerHTML = `<div class="prt"><span>${st.shadow ? 'Would be proven paid' : 'Proven paid'}</span><b>${money(paidCents)}</b></div>
      <div class="prt"><span>Owed in this run</span><b>${money(pr.totalCents)}</b></div>
      <div class="bar" role="img" aria-label="${pct}% of the pay run proven paid"><span style="width:${pct}%"></span></div>`;
    const groups = [];
    for (const t of Object.values(pr.techs)) {
      const rows = [];
      const ls = pr.lines.filter(l => l.techId === t.techId);
      const done = ls.filter(l => ['paid', 'would'].includes(P.lineStatus(st, l.jobId).status)).length;
      rows.push(`<tr class="grp${done === ls.length ? ' all' : ''}"><th scope="rowgroup" colspan="3"><span class="g-in">
        <span class="av-tech" style="--c:${t.color}" aria-hidden="true">${esc(t.initials)}</span>
        <span class="g-name">${esc(t.name)}</span><span class="mono g-ref">${esc(t.ref)}</span>
        <span class="g-tot"><span class="muted">${done} of ${ls.length} ${st.shadow ? 'would be ' : ''}paid ·</span> <b class="mono">${money(t.totalCents)}</b></span></span></th></tr>`);
      for (const l of ls) {
        const s = P.lineStatus(st, l.jobId);
        const changed = lastStatus[l.jobId] && lastStatus[l.jobId] !== s.status;
        lastStatus[l.jobId] = s.status;
        let chip;
        if (s.status === 'paid') chip = `<span class="chip good">✓ Paid${s.by === 'person' ? ' (by a person)' : ''}</span><span class="st-ref mono">${esc(s.confirmation)}</span>`;
        else if (s.status === 'would') chip = `<span class="chip shade">Would be paid</span><span class="st-ref mono">${esc(s.confirmation)}</span>`;
        else if (s.status === 'held') chip = `<button type="button" class="chip bad chip-btn" data-act="toPerson" data-pid="${s.personId}">Held: ${esc(s.emailId)}</button>`;
        else chip = '<span class="chip">Owed</span>';
        rows.push(`<tr class="ln s-${s.status}${changed ? ' fresh' : ''}" data-job="${l.jobId}">
          <td><span class="mono j-id">${esc(l.jobId)}</span><span class="j-i">${esc(l.issue)} · ${esc(P.fmtShort(l.completedAt))}</span></td>
          <td class="num"><span class="mono">${money(l.payCents)}</span><span class="j-i">45% of ${esc(P.dollars(l.revenue))}</span></td>
          <td class="st">${chip}</td></tr>`);
      }
      groups.push(`<tbody>${rows.join('')}</tbody>`);
    }
    const tbl = $('#prTable');
    tbl.querySelectorAll('tbody').forEach(b => b.remove());
    tbl.insertAdjacentHTML('beforeend', groups.join(''));
    $('#aliasList').innerHTML = S.techs.filter(t => P.PAYEES[t.id]).map(t => `<li><b>${esc(t.name)}</b> <span class="mono muted">••••${esc(P.PAYEES[t.id].account)}</span><br><span class="small">${P.PAYEES[t.id].names.map(n => `“${esc(n)}”`).join(', ')}</span></li>`).join('');
  }

  // ---------------------------------------------------------------- needs a person + log
  function personCard(p) {
    const e = st.inbox.find(x => x.id === p.emailId);
    const r = st.runs.live.results[p.emailId];
    const open = p.status === 'open';
    const fails = (r.checks || []).filter(c => c.pass === false);
    const f = r.parsed;
    const fixOpen = ui.fix[p.id];
    const fixForm = `<form class="fix" data-pid="${p.id}" ${fixOpen ? '' : 'hidden'}>
        <p class="small muted">Use this when the email was read wrong, or the bank confirmed different details. The checks re-run on what you type; if they all pass, the jobs are marked paid.</p>
        <div class="fix-grid">
          <div><label for="fx-payee-${p.id}">Payee</label><input id="fx-payee-${p.id}" name="payee" value="${esc(f.payee || '')}"></div>
          <div><label for="fx-account-${p.id}">Account (last 4)</label><input id="fx-account-${p.id}" name="account" inputmode="numeric" maxlength="4" value="${esc(f.account || '')}"></div>
          <div><label for="fx-amount-${p.id}">Amount</label><input id="fx-amount-${p.id}" name="amount" inputmode="decimal" value="${f.amountCents != null && !isNaN(f.amountCents) ? (f.amountCents / 100).toFixed(2) : ''}"></div>
          <div><label for="fx-ref-${p.id}">Reference</label><input id="fx-ref-${p.id}" name="ref" value="${esc(f.ref || '')}"></div>
          <div><label for="fx-date-${p.id}">Date</label><input id="fx-date-${p.id}" name="date" placeholder="Nov 6, 2026" value="${f.date ? esc(P.fmtShort(P.keyToMs(f.date)) + ', ' + f.date.slice(0, 4)) : ''}"></div>
          <div><label for="fx-memo-${p.id}">Memo (job numbers)</label><input id="fx-memo-${p.id}" name="memo" placeholder="SH-1020" value="${esc(f.memo || '')}"></div>
        </div>
        <div class="row"><button type="submit" class="btn small">Re-run the checks</button><button type="button" class="btn ghost small" data-act="fixToggle" data-pid="${p.id}">Cancel</button></div>
      </form>`;
    const cands = p.candidates.map(id => P.jobById(st, id)).filter(Boolean);
    const candHtml = cands.length
      ? `<ul class="p-jobs">${cands.map(l => `<li><span class="mono">${esc(l.jobId)}</span> <span class="small">${esc(l.issue)}</span> <span class="mono num">${money(l.payCents)}</span></li>`).join('')}</ul>
         <div class="jm-sum"><span>Jobs total</span><span class="mono num">${money(cands.reduce((s, l) => s + l.payCents, 0))}</span></div>
         <div class="jm-sum"><span>Transfer</span><span class="mono num">${money(f.amountCents)}</span></div>
         ${p.diffCents ? `<div class="jm-sum diff bad-t"><span>${p.diffCents < 0 ? 'Short by' : 'Over by'}</span><span class="mono num">${money(Math.abs(p.diffCents))}</span></div>` : ''}`
      : `<p class="small muted">${p.doublePay ? 'None: the jobs it pays are already paid. Approving closes it without marking anything.' : 'None in this pay run. Approving closes it without marking anything paid.'}</p>`;
    return `<article class="p-card k-${p.kind}${open ? '' : ' closed'}" id="pc-${p.id}">
      <div class="p-top"><span class="mono p-id">${esc(p.emailId)}</span><b class="p-subj">${esc(p.title)}</b>${p.doublePay ? '<span class="chip bad">Possible double payment</span>' : ''}${p.fixed && open ? '<span class="chip warn">Fixed, still failing</span>' : ''}<time class="small muted">${esc(P.fmtStamp(p.at))}</time></div>
      <p class="p-sub small"><b>${esc(e.subject)}</b> · ${esc(senderOf(e).name)}</p>
      <p class="p-why">${esc(p.why)}</p>
      ${open ? `<div class="p-grid">
        <div><div class="p-k">Failed checks</div><ul class="p-fails">${fails.map(c => `<li><b>${esc(c.name)}:</b> ${esc(c.label)}. <span class="muted">${esc(c.detail)}</span></li>`).join('')}</ul>
          <details class="p-email"><summary>The email</summary><pre class="em-body">${esc(e.body)}</pre></details></div>
        <div><div class="p-k">Jobs it might cover</div>${candHtml}</div>
      </div>
      <div class="p-act">
        <label for="note-${p.id}">Note (required to approve)</label>
        <textarea id="note-${p.id}" rows="2" placeholder="e.g. Called the bank: it was sent to Jake's new account." aria-describedby="noteErr-${p.id}"></textarea>
        <p class="p-err small" id="noteErr-${p.id}" role="alert"></p>
        <div class="row p-btns">
          <button type="button" class="btn small" data-act="approve" data-pid="${p.id}">${cands.length ? `Approve: mark ${esc(P.listJobs(cands.map(l => l.jobId)))} paid` : 'Approve and close'}</button>
          <button type="button" class="btn ghost small" data-act="reject" data-pid="${p.id}">Reject: don't mark paid</button>
          <button type="button" class="btn ghost small" data-act="fixToggle" data-pid="${p.id}" aria-expanded="${fixOpen ? 'true' : 'false'}">Fix what was read</button>
          <button type="button" class="btn ghost small" data-act="open" data-email="${p.emailId}" data-scroll="1">Show the email</button>
        </div>
        ${fixForm}
      </div>` : `<p class="p-done small"><span class="chip ${p.status === 'rejected' ? '' : 'good'}">${esc(p.status === 'fixed' ? 'Fixed' : p.status[0].toUpperCase() + p.status.slice(1))}</span> ${esc(p.resolution || '')}</p>`}
    </article>`;
  }

  function renderLists() {
    const open = st.person.filter(p => p.status === 'open').sort((a, b) => a.emailId.localeCompare(b.emailId)), closed = st.person.filter(p => p.status !== 'open');
    $('#nPerson').textContent = open.length;
    $('#nPerson').className = 'chip' + (open.length ? ' bad' : '');
    $('#nLog').textContent = st.log.length;
    let empty;
    if (st.shadow) empty = '<p class="q-empty muted">Shadow mode is on, so nothing is queued here: problems are only logged as “WOULD send to a person”. Turn shadow mode off and check the transfers to see real items.</p>';
    else empty = `<p class="q-empty muted">Nothing needs a person right now. Try <button type="button" class="linkish" data-act="open" data-email="E03" data-scroll="1">E03, the $40.00 short transfer</button>.</p>`;
    $('#person').innerHTML = (st.shadow && open.length ? '<p class="shadow-note small">Shadow mode is on. These items came from live checks earlier; new problems are only logged.</p>' : '')
      + (open.length ? open.map(personCard).join('') : empty)
      + (closed.length ? `<details class="p-closed"><summary>Handled (${closed.length})</summary>${closed.map(personCard).join('')}</details>` : '');
    $('#log').innerHTML = st.log.length ? st.log.slice(0, 100).map(e => {
      const [lab, tone] = KIND_CHIP[e.kind] || ['Note', ''];
      return `<li class="log-e k-${e.kind}"><div class="l-top"><time datetime="${new Date(e.at).toISOString()}">${esc(P.fmtStamp(e.at))}</time><span class="chip ${tone}">${lab}</span>${e.shadow && e.kind !== 'admin' ? '<span class="chip shade">shadow</span>' : ''}${e.doublePay ? '<span class="chip bad">double payment?</span>' : ''}${e.emailId ? `<span class="l-key mono">${esc(e.emailId)}</span>` : ''}</div>
        <div class="l-title">${esc(e.title)}</div>${e.detail ? `<div class="l-detail small muted">${esc(e.detail)}</div>` : ''}
        ${e.checks && e.checks.length ? `<details><summary>Checks</summary><ol class="steps-l">${e.checks.map(c => `<li><span class="s-k">${c.pass === true ? '✓ pass' : c.pass === false ? '× fail' : '– n/a'}</span><span><b>${esc(c.name)}:</b> ${esc(c.label)}</span></li>`).join('')}</ol></details>` : ''}</li>`;
    }).join('') : '<li class="q-empty muted">The log is empty. Check a transfer to see entries.</li>';
    $('#clearLog').hidden = !st.log.length;
    setTab(ui.tab, false);
  }
  function setTab(tab, focus) {
    ui.tab = tab;
    document.querySelectorAll('[role="tab"]').forEach(b => {
      const on = b.dataset.tab === tab;
      b.setAttribute('aria-selected', String(on)); b.tabIndex = on ? 0 : -1;
      $('#pane-' + b.dataset.tab).hidden = !on;
      if (on && focus) b.focus();
    });
  }

  // ---------------------------------------------------------------- rules
  function renderRules() {
    const R = [
      ['Shadow mode first', 'On a first visit every transfer is checked but nothing is marked paid. The log says “WOULD mark SH-1013 and SH-1017 paid”. In a real install you run it beside the spreadsheet for a pay run or two, compare, then switch it on.', null, 'Toggle shadow mode above'],
      ['Exact to the cent', 'Money is kept as whole cents, never rounded dollars. A transfer must equal the jobs it pays exactly. One cent off is a mismatch, and it goes to a person with the difference.', 'E03', 'E03: $40.00 short'],
      ['Right payee', 'The name on the transfer must be the tech, or a name in the known-names table (“M. Reyes” is Marcus Reyes), and the masked account must be the saved one. A different name never matches, however close.', 'E05', 'E05: “Jake Moore”, E08: “M. Reyes”'],
      ['Right dates, right reference', 'The transfer must be dated inside this pay run\'s window and carry the tech\'s reference, like PAY-W45-MR. An old receipt forwarded by the office is caught.', 'E09', 'E09: dated before the work was done'],
      ['No job paid twice', 'Every job can be proven paid once. A second transfer with the same payee, amount and reference is flagged as a possible double payment, and so is a job that was paid in an earlier run.', 'E04', 'E04: sent twice, E06: already paid'],
      ['Never on a guess', 'Without a memo, it finds the jobs whose pay adds up to the amount. If no set does, or two different sets do, it stops and asks. It only marks paid what it can prove.', 'E02', 'E02: two jobs, proven by the sum'],
      ['Same email, once', 'Each email and each bank confirmation # is processed once. If the bank re-sends a confirmation, it is skipped, not counted as a second payment.', 'E10', 'E10: the bank re-sent E02'],
      ['Everything is logged', 'Every check, decision, approval, rejection and fix is in the activity log with a timestamp and the reason. A person\'s approval always needs a note.', null, 'Activity log tab'],
    ];
    $('#rules').innerHTML = R.map(([h, p, em, tryTxt]) => `<li><h3>${esc(h)}</h3><p>${esc(p)}</p><p class="try small">Try it: ${em ? `<button type="button" class="linkish" data-act="open" data-email="${em}" data-scroll="1">${esc(tryTxt)}</button>` : esc(tryTxt)}</p></li>`).join('');
  }

  // ---------------------------------------------------------------- render all
  function render() { renderMode(); renderInbox(); renderPayRun(); renderLists(); save(); }

  // ---------------------------------------------------------------- actions
  const SAY = { proven: 'Proven: jobs marked paid', person: 'Sent to Needs a person', skipped: 'Already checked: skipped' };
  function say(r) {
    if (!r) return '';
    if (r.outcome === 'proven') return st.shadow ? `Shadow: WOULD mark ${P.listJobs(r.jobIds)} paid` : `Proven: ${P.listJobs(r.jobIds)} marked paid`;
    if (r.outcome === 'person') return st.shadow ? `Shadow: WOULD send to a person (${r.title.toLowerCase()})` : `Needs a person: ${r.title.toLowerCase()}`;
    return SAY[r.outcome] || r.outcome;
  }
  function scrollToEl(el, block) { if (el) el.scrollIntoView({ behavior: reduce() ? 'auto' : 'smooth', block: block || 'start' }); }

  function checkOne(id) {
    const r = P.process(st, id);
    ui.open = id;
    render();
    toast(say(r));
    if (r && r.outcome === 'person' && !st.shadow) setTab('person', false);
    return r;
  }
  async function checkAll() {
    if (busy) return;
    busy = true; renderMode();
    const ids = st.inbox.filter(e => !run().processed[e.id]).map(e => e.id);
    const delay = reduce() || params.get('fast') === '1' ? 0 : 650;
    const before = P.counts(st);
    for (const id of ids) {
      P.process(st, id);
      renderMode(); renderInbox(); renderPayRun();
      const el = document.getElementById('mail-' + id); if (el) { el.classList.add('flash'); }
      if (delay) await new Promise(res => setTimeout(res, delay));
    }
    busy = false;
    const c = P.counts(st);
    if (!st.shadow && c.held > before.held) ui.tab = 'person';
    render();
    toast(st.shadow ? `Shadow: ${c.proven - before.proven} would be proven, ${c.held - before.held} would go to a person` : `${c.proven - before.proven} proven, ${c.held - before.held} sent to a person`);
  }

  function act(el) {
    const a = el.dataset.act;
    if (a === 'open') {
      const id = el.dataset.email;
      ui.open = ui.open === id && !el.dataset.scroll ? null : id;
      render();
      if (el.dataset.scroll || matchMedia('(max-width: 1099px)').matches) scrollToEl(document.getElementById('mail-' + id));
      const btn = document.querySelector(`#mail-${id} .mail-top`); if (btn && el.dataset.scroll) btn.focus({ preventScroll: true });
      return;
    }
    if (a === 'check') { checkOne(el.dataset.email); const b = document.querySelector(`#mail-${el.dataset.email} .mail-top`); if (b) b.focus({ preventScroll: true }); return; }
    if (a === 'toPerson') {
      setTab('person', false); save();
      const c = document.getElementById('pc-' + el.dataset.pid);
      scrollToEl(c || $('#lists'));
      return;
    }
    if (a === 'fixToggle') {
      ui.fix[el.dataset.pid] = !ui.fix[el.dataset.pid]; renderLists();
      const f = document.querySelector(`form.fix[data-pid="${el.dataset.pid}"]`);
      if (ui.fix[el.dataset.pid] && f) f.querySelector('input').focus();
      return;
    }
    if (a === 'approve' || a === 'reject') {
      const pid = el.dataset.pid;
      const note = ($('#note-' + pid) || {}).value || '';
      const r = P.resolve(st, pid, a, { note });
      if (r.error === 'note') { const err = $('#noteErr-' + pid); err.textContent = r.message; $('#note-' + pid).focus(); return; }
      render();
      toast(a === 'approve' ? (r.jobIds && r.jobIds.length ? `Approved: ${P.listJobs(r.jobIds)} marked paid by a person` : 'Approved and closed') : 'Rejected: nothing marked paid');
      return;
    }
  }

  function submitFix(form) {
    const pid = form.dataset.pid;
    const fields = {};
    for (const k of ['payee', 'account', 'amount', 'ref', 'date', 'memo']) fields[k] = form.elements[k].value;
    const note = ($('#note-' + pid) || {}).value || '';
    const r = P.resolve(st, pid, 'fix', { fields, note });
    if (r.error) { toast('Already decided'); render(); return; }
    if (r.outcome === 'fixed') { delete ui.fix[pid]; render(); toast(`Fixed and proven: ${P.listJobs(r.result.jobIds)} marked paid`); }
    else { render(); toast(`Still not proven: ${r.result.title.toLowerCase()}`); const c = document.getElementById('pc-' + pid); if (c) c.querySelector('.p-why').focus && c.classList.add('flash'); }
  }

  function wire() {
    document.addEventListener('click', e => { const el = e.target.closest('[data-act]'); if (el && !el.disabled) act(el); });
    document.addEventListener('submit', e => { const f = e.target.closest('form.fix'); if (f) { e.preventDefault(); submitFix(f); } });
    $('#shadow').addEventListener('change', e => {
      P.setShadow(st, e.target.checked);
      render(); toast(st.shadow ? 'Shadow mode on: checks only, nothing marked paid' : 'Live: proven transfers mark jobs paid');
    });
    $('#checkAll').addEventListener('click', checkAll);
    $('#resetAll').addEventListener('click', () => { const sh = st.shadow; st = P.createState({ shadow: sh }); ui = defaultUi(); lastStatus = {}; render(); toast('Demo reset'); });
    $('#clearLog').addEventListener('click', () => { st.log = []; render(); toast('Log cleared'); });
    $('.tabs').addEventListener('keydown', e => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
      const tabs = [...document.querySelectorAll('[role="tab"]')]; const i = tabs.findIndex(t => t.dataset.tab === ui.tab);
      const n = e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : (i + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
      setTab(tabs[n].dataset.tab, true); save(); e.preventDefault();
    });
    document.querySelectorAll('[role="tab"]').forEach(b => b.addEventListener('click', () => { setTab(b.dataset.tab, false); save(); }));
  }

  load();
  renderRules();
  wire();
  render();
  window.ProofingDemo = { get state() { return st; }, render, checkAll };
})();
