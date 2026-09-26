/* Bank of B&B web app. Data lives in a private GitHub repo (plan.json + state.json),
   read and written with a GitHub token stored only on this device. */
(function () {
  'use strict';
  const B = window.BNB;
  const $ = (s, el) => (el || document).querySelector(s);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = B.money;

  // ---------- device settings ----------
  const LS = {
    get(k, d) { try { const v = localStorage.getItem('bnb.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('bnb.' + k, JSON.stringify(v)); } catch (e) { /* storage blocked */ } }
  };
  const guessOwner = location.hostname.endsWith('.github.io') ? location.hostname.split('.')[0] : '';
  let conn = LS.get('conn', { owner: guessOwner, repo: 'bank-of-bnb-data', token: '' });
  let me = LS.get('me', null);

  // ---------- app state ----------
  let plan = null, state = null, events = [], stateSha = null;
  let tab = (location.hash || '#today').slice(1) || 'today';
  let planFilter = 'all', showPast = false, spendMonth = null;
  let saving = false;

  // ---------- GitHub storage ----------
  const API = 'https://api.github.com';
  function ghHeaders(extra) {
    return Object.assign({ Authorization: 'Bearer ' + conn.token, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }, extra || {});
  }
  function b64decode(s) {
    const bin = atob(s.replace(/\n/g, ''));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }
  function b64encode(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }
  async function readFile(path) {
    const r = await fetch(API + '/repos/' + conn.owner + '/' + conn.repo + '/contents/' + path + '?ref=main&t=' + Date.now(), { headers: ghHeaders(), cache: 'no-store' });
    if (r.status === 404) return { sha: null, data: null, status: 404 };
    if (!r.ok) { const e = new Error('GitHub said ' + r.status); e.status = r.status; throw e; }
    const j = await r.json();
    return { sha: j.sha, data: JSON.parse(b64decode(j.content)) };
  }
  async function writeFile(path, data, sha, message) {
    const body = { message, content: b64encode(JSON.stringify(data, null, 2) + '\n'), branch: 'main' };
    if (sha) body.sha = sha;
    const r = await fetch(API + '/repos/' + conn.owner + '/' + conn.repo + '/contents/' + path, { method: 'PUT', headers: ghHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify(body) });
    if (!r.ok) { const e = new Error('Save failed (' + r.status + ')'); e.status = r.status; throw e; }
    const j = await r.json();
    return j.content.sha;
  }
  function blankState() { return { version: 1, done: {}, expenses: [], cardStart: {}, notify: {}, subs: {} }; }
  function normState(s) { s = s || blankState(); ['done', 'cardStart', 'notify', 'subs'].forEach(k => { if (!s[k] || typeof s[k] !== 'object') s[k] = {}; }); if (!Array.isArray(s.expenses)) s.expenses = []; return s; }

  // Apply a change: optimistic locally, then write to GitHub, re-applying on conflict.
  async function mutate(fn, message) {
    fn(state); render();
    saving = true; setSubline();
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const fresh = await readFile('state.json');
        const data = normState(fresh.data);
        fn(data);
        stateSha = await writeFile('state.json', data, fresh.sha, message + ' (' + (me || 'app') + ')');
        state = data; saving = false; setSubline(); render();
        return true;
      } catch (e) {
        if ((e.status === 409 || e.status === 422) && attempt < 3) { await new Promise(r => setTimeout(r, 400 + Math.random() * 600)); continue; }
        saving = false; setSubline();
        toast(e.status === 401 || e.status === 403 ? 'Save refused. Check the GitHub token in Alerts > Connection.' : 'Could not save. Check your connection and try again.');
        await load(true);
        return false;
      }
    }
  }

  async function load(quiet) {
    if (!conn.token || !conn.owner) { tab = 'setup'; render(); return; }
    try {
      const [p, s] = await Promise.all([readFile('plan.json'), readFile('state.json')]);
      if (!p.data) throw Object.assign(new Error('plan.json not found'), { status: 404 });
      plan = p.data; state = normState(s.data); stateSha = s.sha;
      events = B.buildEvents(plan);
      LS.set('cache', { plan, state });
      if (tab === 'setup') tab = 'today';
    } catch (e) {
      const cache = LS.get('cache', null);
      if (cache && !plan) { plan = cache.plan; state = normState(cache.state); events = B.buildEvents(plan); }
      if (!quiet) showBanner(e.status === 401 ? 'The GitHub token was refused. Enter a new one in Alerts > Connection.' : e.status === 404 ? 'Could not find the data repo. Check the owner and repo name in Alerts > Connection.' : 'Offline. Showing the last saved copy.');
      if (!plan) tab = 'setup';
    }
    render();
  }

  // ---------- helpers ----------
  function today() { return B.todayIn(plan ? plan.timezone : 'America/Vancouver'); }
  function whoClass(w) { const names = plan ? Object.keys(plan.people) : []; const i = names.indexOf(w); return i === 0 ? 'p' : i === 1 ? 'a' : 'both'; }
  function daysUntil(d) { return Math.round((B.parse(d) - B.parse(today())) / 86400000); }
  function whenText(d) { const n = daysUntil(d); return n === 0 ? 'Today' : n === 1 ? 'Tomorrow' : n === -1 ? 'Yesterday' : n > 1 ? 'In ' + n + ' days' : Math.abs(n) + ' days ago'; }
  const check = '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
  function setSubline() { const el = $('#subline'); if (el) el.textContent = saving ? 'Saving…' : (plan && plan.subtitle) || 'Payday plan'; }
  function showBanner(t) { const b = $('#banner'); if (!t) { b.hidden = true; return; } b.textContent = t; b.hidden = false; }
  let toastT = null;
  function toast(t) { const el = $('#toast'); el.textContent = t; el.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => el.hidden = true, 2800); }

  function modal(title, bodyHtml, actions) {
    return new Promise(resolve => {
      $('#modalTitle').textContent = title;
      $('#modalBody').innerHTML = bodyHtml;
      const box = $('#modalActions');
      box.className = 'modal-actions' + (actions.length === 1 ? ' one' : '');
      box.innerHTML = actions.map((a, i) => '<button type="button" class="btn ' + (a.cls || '') + '" data-i="' + i + '">' + esc(a.label) + '</button>').join('');
      const wrap = $('#modal'); wrap.hidden = false;
      const done = (v) => { wrap.hidden = true; wrap.onclick = null; document.removeEventListener('keydown', onKey); resolve(v); };
      const onKey = (e) => { if (e.key === 'Escape') done(null); };
      document.addEventListener('keydown', onKey);
      box.querySelectorAll('button').forEach(b => b.onclick = () => done(actions[Number(b.dataset.i)].value));
      wrap.onclick = (e) => { if (e.target === wrap) done(null); };
      setTimeout(() => { const last = box.querySelector('button:last-child'); if (last) last.focus(); }, 30);
    });
  }

  // ---------- step rendering ----------
  function stepHtml(ev, s, i) {
    if (s.type === 'in') {
      return '<li><div class="step info"><span class="box"></span><span class="label">Paycheck arrives</span><span class="amt" style="color:var(--good)">+' + money(s.amount) + '</span></div></li>';
    }
    const done = B.isDone(state, ev, s.key);
    const cls = ['step', done ? 'done' : '', s.big ? 'big' : '', s.type].join(' ');
    const amt = s.type === 'save' ? money(s.amount) : s.type === 'keep' ? money(s.amount) + ' left' : money(s.amount);
    return '<li><button type="button" class="' + cls + '" data-ev="' + esc(ev.id) + '" data-key="' + esc(s.key) + '" aria-pressed="' + done + '">' +
      '<span class="box">' + check + '</span>' +
      '<span class="label"><span class="num">' + i + '.</span>' + esc(s.label) + (s.hint ? '<span class="hint">' + esc(s.hint) + '</span>' : '') + '</span>' +
      '<span class="amt">' + amt + '</span></button></li>';
  }
  function stepsHtml(ev) {
    let n = 0;
    return '<ul class="steps">' + ev.steps.map(s => stepHtml(ev, s, s.type === 'in' ? 0 : ++n)).join('') + '</ul>';
  }
  async function toggleStep(evId, key) {
    const ev = events.find(e => e.id === evId); if (!ev) return;
    const s = ev.steps.find(x => x.key === key); if (!s) return;
    const was = B.isDone(state, ev, key);
    if (!was && s.confirm) {
      const ok = await modal('Confirm: ' + s.label, '<p><b>' + money(s.amount) + '</b> on ' + esc(B.nice(ev.date)) + '.</p>' + (s.hint ? '<p class="muted">' + esc(s.hint) + '</p>' : '') + '<p class="muted small">Only tick this once the money has actually gone out.</p>', [{ label: 'Not yet', cls: 'secondary', value: false }, { label: 'Yes, it is paid', value: true }]);
      if (!ok) return;
    }
    await mutate(st => { st.done[evId] = st.done[evId] || {}; if (was) delete st.done[evId][key]; else st.done[evId][key] = true; }, (was ? 'Untick ' : 'Tick ') + key + ' ' + evId);
    if (!was) { const p = B.eventProgress(state, ev); toast(p.complete ? 'All done for ' + B.nice(ev.date) + '.' : 'Done. ' + (p.total - p.done) + ' to go.'); }
  }

  // ---------- views ----------
  function viewToday() {
    const t = today();
    const sum = B.summary(plan, state, events, t);
    const al = B.alerts(plan, state, events, t);
    let h = '<section><h1>' + (me ? 'Hi ' + esc(me) + '.' : 'Hi there.') + '</h1><p class="lead">' + esc(B.nice(t)) + '</p></section>';

    if (al.length) h += '<section class="section">' + al.map(a => '<div class="alert ' + a.level + '"><div><b>' + esc(a.title) + '</b><span>' + esc(a.text) + '</span></div></div>').join('') + '</section>';

    (plan.trips || []).filter(tr => tr.end >= t).forEach(tr => { h += tripCard(tr); });

    // overdue first
    const overdue = sum.overdue.slice(0, 2);
    overdue.forEach(ev => { h += eventCard(ev, 'Still to do'); });

    const upcoming = events.filter(ev => ev.date >= t && (ev.kind === 'note' || !B.eventProgress(state, ev).complete));
    const nextMine = upcoming.find(ev => ev.kind !== 'note' && (!me || ev.who === me));
    const next = upcoming.find(ev => ev.kind !== 'note');
    if (nextMine) h += eventCard(nextMine, me ? 'Your next payday task' : 'Next up');
    if (next && next !== nextMine) h += eventCard(next, 'Next up for ' + next.who);
    if (!next && !overdue.length) h += '<div class="card empty">Nothing to do right now.</div>';

    // stats
    const pc = sum.cards;
    h += '<section class="section"><h3>This month · ' + esc(B.monthName(sum.month)) + '</h3><div class="stats">' +
      '<div class="stat"><span class="k">Saved so far</span><span class="v">' + money(sum.savingsDone) + '</span><span class="s">Plan: ' + money(sum.savingsPlannedByMonthEnd) + ' by month end</span></div>' +
      Object.keys(pc).map(w => '<div class="stat"><span class="k">' + esc(w) + '\'s card</span><span class="v" style="color:' + (pc[w].owed > pc[w].line ? 'var(--bad)' : 'inherit') + '">' + money(Math.max(0, pc[w].owed)) + '</span><span class="s">' + (pc[w].owed > pc[w].line ? 'Over the ' + money(pc[w].line) + ' line' : money(pc[w].room) + ' room under ' + money(pc[w].line)) + '</span></div>').join('') +
      '</div></section>';
    h += '<section class="card stack"><h3>Budgets left this month</h3>' + sum.budgets.map(budgetMeter).join('') + '<button type="button" class="btn secondary" data-go="spend">Log spending</button></section>';

    // this week's notes
    const soon = events.filter(ev => ev.kind === 'note' && daysUntil(ev.date) >= 0 && daysUntil(ev.date) <= 21);
    if (soon.length) h += '<section class="section"><h3>Coming up</h3>' + soon.map(ev => '<div class="card flat"><div class="row"><b>' + esc(ev.title) + '</b><span class="chip ' + whoClass(ev.who) + '">' + esc(B.nice(ev.date)) + ' · ' + whenText(ev.date) + '</span></div>' + (ev.text ? '<p class="muted small" style="margin:6px 0 0">' + esc(ev.text) + '</p>' : '') + (ev.trip ? '<button type="button" class="btn ghost small" data-go="trip" style="margin-top:6px;padding-left:0">Open trip plan →</button>' : '') + '</div>').join('') + '</section>';
    return h;
  }

  function eventCard(ev, eyebrow) {
    const p = B.eventProgress(state, ev);
    const pay = ev.steps.find(s => s.type === 'in');
    return '<section class="card"><h3>' + esc(eyebrow) + '</h3>' +
      '<div class="event-head" style="margin-top:8px"><div><div class="event-date">' + esc(B.nice(ev.date)) + '</div><div class="event-meta">' + whenText(ev.date) + ' · ' + esc(ev.kind === 'rent' ? 'Rent day' : ev.title) + '</div></div>' +
      '<div style="text-align:right"><span class="chip ' + whoClass(ev.who) + '">' + esc(ev.who) + '</span>' + (pay ? '<div class="pay-in" style="margin-top:8px">+' + money(pay.amount) + '</div>' : '') + '</div></div>' +
      '<div style="margin-top:12px" class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="' + p.total + '" aria-valuenow="' + p.done + '"><i style="width:' + (p.total ? (100 * p.done / p.total) : 0) + '%"></i></div>' +
      '<div class="small muted" style="margin-top:4px">' + p.done + ' of ' + p.total + ' done</div>' +
      stepsHtml(ev) + '</section>';
  }

  function budgetMeter(b) {
    const pct = b.monthly ? b.spent / b.monthly : 0;
    const cls = pct > 1 ? 'bad' : pct >= 0.85 ? 'warn' : '';
    return '<div class="meter"><div class="meter-top"><span class="meter-name">' + esc(b.label) + ' <span class="chip ' + whoClass(b.who) + '">' + esc(b.who) + '</span></span><span class="meter-val">' + money(b.spent) + ' of ' + money(b.monthly) + '</span></div>' +
      '<div class="bar ' + cls + '"><i style="width:' + Math.min(100, pct * 100) + '%"></i></div>' +
      '<div class="meter-note ' + cls + '">' + (b.spent > b.monthly ? money(b.spent - b.monthly) + ' over budget' : money(b.monthly - b.spent) + ' left') + '</div>' + (b.note ? '<div class="meter-note">' + esc(b.note) + '</div>' : '') + '</div>';
  }

  // ---------- trips ----------
  function tripDates(tr) { return B.nice(tr.start) + ' – ' + B.nice(tr.end); }
  function tripCard(tr) {
    const st = B.tripStatus(plan, state, tr, today());
    const when = st.phase === 'before' ? (st.days === 1 ? 'Starts tomorrow' : 'Starts in ' + st.days + ' days') : st.phase === 'during' ? 'Happening now' : 'Finished';
    return '<section class="card trip-card"><div class="row"><div><h3>Trip</h3><div class="event-date" style="margin-top:6px">' + esc(tr.name) + '</div><div class="event-meta">' + esc(tripDates(tr)) + ' · ' + when + '</div></div>' +
      '<span class="chip ' + (st.done === st.count ? 'good' : 'muted') + '">' + st.done + ' of ' + st.count + ' paid</span></div>' +
      '<div class="progress" style="margin-top:12px"><i style="width:' + (100 * st.done / st.count) + '%"></i></div>' +
      '<button type="button" class="btn" data-go="trip" style="margin-top:12px;width:100%">Open trip plan</button></section>';
  }
  function viewTrip() {
    const t = today();
    const tr = (plan.trips || []).filter(x => x.end >= t)[0] || (plan.trips || []).slice(-1)[0];
    if (!tr) return '<div class="card empty">No trips planned.</div>';
    const st = B.tripStatus(plan, state, tr, t);
    let h = '<section><button type="button" class="btn ghost small" data-go="plan" style="padding-left:0">← Plan</button><h1>' + esc(tr.name) + '</h1><p class="lead">' + esc(tripDates(tr)) + '</p></section>';
    h += '<div class="verdict"><b>Can we afford it?</b><span>' + esc(tr.verdict) + '</span></div>';

    // 1. what it costs
    h += '<section class="card"><div class="row"><h2>1. What it costs</h2><span class="meter-val">' + money(st.paid) + ' of ' + money(st.total) + ' paid</span></div>' +
      '<p class="small muted" style="margin:4px 0 0">Tick each one when it\'s paid.</p><ul class="steps">' +
      st.items.map(it => '<li><button type="button" class="step' + (it.done ? ' done' : '') + '" data-trip="' + esc(tr.key) + '" data-trip-item="' + esc(it.key) + '" aria-pressed="' + it.done + '"><span class="box">' + check + '</span>' +
        '<span class="label">' + esc(it.label) + '<span class="hint"><span class="chip ' + whoClass(it.who) + '">' + esc(it.who) + '</span> · ' + esc(it.when) + ' · ' + esc(it.from) + '</span></span><span class="amt">' + money(it.amount) + '</span></button></li>').join('') +
      '</ul><div class="trip-total"><span>Total trip cost</span><b>' + money(st.total) + '</b></div></section>';

    // 2. timeline
    const tl = [{ date: t < tr.start ? t : tr.start, title: 'Now', text: 'Buy the ferry tickets ($119) with your spare money.', who: 'Prithvi', now: true }]
      .concat(events.filter(ev => ev.date >= B.addDays(tr.start, -6) && ev.date <= tr.end && (ev.trip === tr.key || (ev.kind === 'payday' && ev.steps.some(s => s.key === 'tripgas')))).map(ev => ({ date: ev.date, who: ev.who, title: ev.kind === 'payday' ? ev.who + '\'s payday' : ev.title, text: ev.kind === 'payday' ? (ev.steps.some(s => s.key === 'tripgas') ? 'Set aside $164 trip gas and buy the $44 Hullo ticket from this paycheck.' : 'Normal payday steps. Her $350 set-aside pays off the trip spending on her card.') : ev.text })));
    h += '<section class="card"><h2>2. Day by day</h2><ol class="timeline">' + tl.map(x => '<li' + (x.date === t ? ' class="today"' : x.date < t && !x.now ? ' class="past"' : '') + '><span class="tl-date">' + (x.now ? 'Now' : esc(B.nice(x.date))) + '</span><div><b>' + esc(x.title) + '</b> <span class="chip ' + whoClass(x.who) + '">' + esc(x.who) + '</span><p>' + esc(x.text || '') + '</p></div></li>').join('') + '</ol></section>';

    // 3. spending during the trip
    h += '<section class="card stack"><h2>3. Spending on the trip</h2><p class="small muted" style="margin:-8px 0 0">Log each purchase so you know what\'s left.</p>' + st.budgets.map(budgetMeter).join('') +
      '<div class="btns">' + st.budgets.map(b => '<button type="button" class="btn secondary small" data-logcat="' + esc(b.key) + '" data-logwho="' + esc(b.who) + '">Log ' + esc(b.label) + '</button>').join('') + '</div></section>';

    // 4. rules
    h += '<section class="card"><h2>4. Rules for the trip</h2><ul class="ol">' + (tr.rules || []).map(r => '<li>' + esc(r) + '</li>').join('') + '</ul></section>';

    // 5. impact
    h += '<section class="card"><h2>5. What it changes</h2><div class="table-wrap"><table class="impact"><thead><tr><th></th><th>Without trip</th><th>With trip</th></tr></thead><tbody>' +
      (tr.impact || []).map(r => '<tr><td>' + esc(r.label) + '</td><td>' + money(r.before) + '</td><td class="' + (r.after < r.before ? 'down' : '') + '">' + money(r.after) + '</td></tr>').join('') +
      '</tbody></table></div>' + (tr.impactNote ? '<p class="small muted" style="margin:10px 0 0">' + esc(tr.impactNote) + '</p>' : '') + '</section>';
    return h;
  }
  async function toggleTripItem(key, itemKey) {
    const tr = (plan.trips || []).find(x => x.key === key); if (!tr) return;
    const it = tr.items.find(x => x.key === itemKey); if (!it) return;
    const st = B.tripStatus(plan, state, tr, today());
    const was = st.items.find(x => x.key === itemKey).done;
    if (!was) {
      const ok = await modal('Paid: ' + it.label + '?', '<p><b>' + money(it.amount) + '</b> · ' + esc(it.who) + '</p><p class="muted">' + esc(it.from) + '</p>', [{ label: 'Not yet', cls: 'secondary', value: false }, { label: 'Yes, paid', value: true }]);
      if (!ok) return;
    }
    const tid = 'trip|' + key;
    await mutate(stt => {
      stt.done[tid] = stt.done[tid] || {};
      if (was) { delete stt.done[tid][itemKey]; if (it.step) { const [e, k] = it.step.split(':'); if (stt.done[e]) delete stt.done[e][k]; } }
      else { stt.done[tid][itemKey] = true; if (it.step) { const [e, k] = it.step.split(':'); stt.done[e] = stt.done[e] || {}; stt.done[e][k] = true; } }
    }, (was ? 'Untick trip ' : 'Paid trip ') + itemKey);
  }

  function viewPlan() {
    const t = today();
    let list = events.filter(ev => planFilter === 'all' || ev.who === planFilter || ev.who === 'Both');
    const firstMonth = B.month(t) < B.month(plan.startDate) ? B.month(plan.startDate) : B.month(t);
    if (!showPast) list = list.filter(ev => B.month(ev.date) >= firstMonth || (ev.kind !== 'note' && !B.eventProgress(state, ev).complete));
    let h = '<section><h1>The plan</h1><p class="lead">Every payday and what it pays for. Tap a day to see and tick its steps.</p></section>';
    (plan.trips || []).filter(tr => tr.end >= t).forEach(tr => { h += tripCard(tr); });
    h += '<div class="row"><div class="seg" role="group" aria-label="Show">' + ['all'].concat(Object.keys(plan.people)).map(k => '<button type="button" data-filter="' + k + '" aria-pressed="' + (planFilter === k) + '">' + (k === 'all' ? 'Both' : k) + '</button>').join('') + '</div>' +
      '<button type="button" class="btn ghost small" id="pastBtn">' + (showPast ? 'Hide earlier' : 'Show earlier') + '</button></div>';
    let cur = '';
    for (const ev of list) {
      const m = B.month(ev.date);
      if (m !== cur) {
        cur = m;
        const monthEv = events.filter(e => B.month(e.date) === m);
        const endSav = monthEv.length ? monthEv[monthEv.length - 1].savings : 0;
        h += '<div class="month-h"><h2>' + esc(B.monthName(m)) + '</h2><span>Savings by month end: ' + money(endSav) + '</span></div>';
      }
      h += planRow(ev, t);
    }
    if (!list.length) h += '<div class="card empty">No paydays to show.</div>';
    return h;
  }
  function planRow(ev, t) {
    const d = B.parse(ev.date);
    const p = B.eventProgress(state, ev);
    const pay = ev.steps.find(s => s.type === 'in');
    const out = ev.steps.filter(s => s.type === 'out').reduce((a, s) => a + s.amount, 0);
    const save = ev.steps.find(s => s.type === 'save');
    const keep = ev.steps.find(s => s.type === 'keep');
    const cls = 'ev' + (ev.date < t ? ' past' : '') + (ev.date === t ? ' today' : '');
    const open = ev.date === t || (ev.date < t && !p.complete && ev.kind !== 'note');
    let sub = ev.kind === 'note' ? esc(ev.text || '') : (pay ? '+' + money(pay.amount) + ' in · ' : '') + money(out) + ' out' + (save ? ' · ' + money(save.amount) + ' to savings' : keep ? ' · ' + money(keep.amount) + ' left' : '');
    const status = ev.kind === 'note' ? '' : p.complete ? '<span class="chip good">Done</span>' : ev.date < t ? '<span class="chip warn">' + (p.total - p.done) + ' left</span>' : '<span class="chip muted">' + p.done + '/' + p.total + '</span>';
    return '<details class="' + cls + '"' + (open ? ' open' : '') + '><summary><div class="d"><small>' + ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getUTCDay()] + '</small><b>' + d.getUTCDate() + '</b></div>' +
      '<div class="mid"><span class="t">' + esc(ev.kind === 'rent' ? 'Rent · ' + money(ev.steps[0].amount) : ev.title) + '</span><span class="sub">' + sub + '</span></div>' +
      '<div class="right"><span class="chip ' + whoClass(ev.who) + '">' + esc(ev.who) + '</span>' + status + '</div></summary>' +
      (ev.kind === 'note' ? '' : '<div class="inner">' + stepsHtml(ev) + '<div class="bal">' + Object.keys(ev.balances).map(w => '<span>' + esc(w) + ' after: <b>' + money(ev.balances[w]) + '</b></span>').join('') + '<span>Savings: <b>' + money(ev.savings) + '</b></span></div></div>') +
      '</details>';
  }

  function viewSpend() {
    const t = today();
    spendMonth = spendMonth || B.month(t);
    const sum = B.summary(plan, state, events, spendMonth + '-15');
    const cats = B.budgetsFor(plan, B.month(t)).concat(plan.budgets.filter(b => !b.months && !B.budgetsFor(plan, B.month(t)).some(x => x.key === b.key))).map(b => [b.key, b.label]).concat([['other', 'Other (not in the budget)'], ['cardpay', 'Credit card payment']]);
    const myBudget = plan.budgets.find(b => b.who === me); const defaultCat = myBudget ? myBudget.key : plan.budgets[0].key;
    let h = '<section><h1>Spending</h1><p class="lead">Log what you spend. The app warns you before you go over a budget or past 50% on a card.</p></section>';
    h += '<form class="card" id="spendForm" autocomplete="off"><h2>Add spending</h2>' +
      '<div class="grid2"><div class="field"><label for="sAmt">Amount</label><div class="money-input"><span>$</span><input id="sAmt" type="number" inputmode="decimal" min="0.01" step="0.01" required placeholder="0.00"></div></div>' +
      '<div class="field"><label for="sDate">Date</label><input id="sDate" type="date" value="' + t + '" required></div></div>' +
      '<div class="grid2"><div class="field"><label for="sCat">What for</label><select id="sCat">' + cats.map(c => '<option value="' + c[0] + '"' + (c[0] === defaultCat ? ' selected' : '') + '>' + esc(c[1]) + '</option>').join('') + '</select></div>' +
      '<div class="field"><label for="sWho">Who</label><select id="sWho">' + Object.keys(plan.people).map(w => '<option' + (w === me ? ' selected' : '') + '>' + esc(w) + '</option>').join('') + '</select></div></div>' +
      '<div class="field" id="methodField"><span class="lab">Paid with</span><div class="seg" role="group" aria-label="Paid with"><button type="button" data-method="card" aria-pressed="true">Credit card</button><button type="button" data-method="bank" aria-pressed="false">Bank / debit</button></div></div>' +
      '<div class="field"><label for="sNote">Note (optional)</label><input id="sNote" type="text" maxlength="80" placeholder="e.g. Save-On-Foods"></div>' +
      '<button class="btn" type="submit">Add</button></form>';

    const months = []; for (let m = B.month(plan.startDate); m <= B.month(B.addMonths(t, 0)); m = B.month(B.addMonths(m + '-01', 1))) months.push(m);
    if (months.indexOf(spendMonth) === -1) months.push(spendMonth);
    h += '<section class="card stack"><div class="row"><h2>Budgets</h2><select id="monthSel" style="width:auto">' + months.map(m => '<option value="' + m + '"' + (m === spendMonth ? ' selected' : '') + '>' + esc(B.monthName(m)) + '</option>').join('') + '</select></div>' + sum.budgets.map(budgetMeter).join('') + '</section>';

    const rows = state.expenses.filter(e => B.month(e.date) === spendMonth).sort((a, b) => a.date < b.date ? 1 : a.date > b.date ? -1 : (b.ts || 0) - (a.ts || 0));
    const catName = k => (cats.find(c => c[0] === k) || [k, k])[1];
    h += '<section class="card"><h2>' + esc(B.monthName(spendMonth)) + ' entries</h2><div class="list">' +
      (rows.length ? rows.map(e => '<div class="li"><div><div class="t">' + esc(catName(e.cat)) + (e.note ? ' · ' + esc(e.note) : '') + '</div><div class="sub">' + esc(B.nice(e.date)) + ' · <span class="chip ' + whoClass(e.who) + '">' + esc(e.who) + '</span> · ' + (e.cat === 'cardpay' ? 'Paid off card' : e.method === 'card' ? 'Credit card' : 'Bank') + '</div></div><div class="amt"' + (e.cat === 'cardpay' ? ' style="color:var(--good)"' : '') + '>' + money(e.amount) + '</div><button type="button" class="icon-btn" data-del="' + esc(e.id) + '" aria-label="Delete entry">✕</button></div>').join('') : '<div class="empty">Nothing logged for this month yet.</div>') +
      '</div></section>';
    return h;
  }

  async function submitSpend(form) {
    const amount = Math.round(parseFloat($('#sAmt').value) * 100) / 100;
    if (!(amount > 0)) { toast('Enter an amount.'); return; }
    const date = $('#sDate').value || today();
    const cat = $('#sCat').value; const who = $('#sWho').value; const note = $('#sNote').value.trim();
    const method = cat === 'cardpay' ? 'bank' : (form.querySelector('[data-method][aria-pressed="true"]') || {}).dataset.method || 'card';
    const sum = B.summary(plan, state, events, date);
    const warn = [];
    const budget = sum.budgets.find(b => b.key === cat);
    if (budget) {
      const after = budget.spent + amount;
      if (after > budget.monthly) warn.push('<b>' + esc(budget.label) + '</b> would be ' + money(after) + ' of ' + money(budget.monthly) + ' for ' + esc(B.monthName(B.month(date))) + ', <b>' + money(after - budget.monthly) + ' over</b>. The extra comes out of ' + (plan.people[budget.who].leftover === 'save' ? 'savings' : 'the rent cushion') + '.');
      else if (after >= budget.monthly * 0.85) warn.push('This leaves only <b>' + money(budget.monthly - after) + '</b> of ' + esc(budget.label) + ' for the rest of the month.');
      if (budget.who !== who) warn.push(esc(budget.label) + ' is normally ' + esc(budget.who) + '\'s budget. It will still count against it.');
    }
    if (cat === 'other') warn.push('This is <b>not in the budget</b>. It comes out of ' + (plan.people[who].leftover === 'save' ? 'this month\'s savings' : who + '\'s rent cushion') + '.');
    if (method === 'card' && cat !== 'cardpay' && sum.cards[who]) {
      const c = sum.cards[who]; const after = c.owed + amount;
      if (after > c.line) warn.push(esc(who) + '\'s card would owe <b>' + money(after) + '</b>, over the ' + money(c.line) + ' line (50% of ' + money(c.limit) + '). Use the bank card instead, or pay the card down first.');
    }
    if (warn.length) {
      const ok = await modal('Before you add this', '<p>' + money(amount) + ' · ' + esc(who) + '</p><ul>' + warn.map(w => '<li>' + w + '</li>').join('') + '</ul>', [{ label: 'Cancel', cls: 'secondary', value: false }, { label: 'Add anyway', cls: warn.some(w => w.indexOf('over') > -1) ? 'danger' : '', value: true }]);
      if (!ok) return;
    }
    const entry = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), date, who, cat, amount, method, note, ts: Date.now(), by: me || '' };
    form.reset();
    const ok = await mutate(st => { st.expenses.push(entry); }, 'Log ' + cat + ' ' + amount);
    if (ok) toast('Added ' + money(amount) + '.');
  }

  function viewCards() {
    const sum = B.summary(plan, state, events, today());
    let h = '<section><h1>Credit cards</h1><p class="lead">Keep each card at or under 50% of its limit. Charges you log on a card add to what you owe; ticked card payments and logged payments take it down.</p></section>';
    for (const w of Object.keys(sum.cards)) {
      const c = sum.cards[w];
      const owed = Math.max(0, c.owed);
      const pct = c.limit ? owed / c.limit : 0;
      const cls = c.owed > c.line ? 'bad' : c.room < c.line * 0.2 ? 'warn' : '';
      h += '<section class="card stack"><div class="row"><h2>' + esc(w) + '</h2><span class="chip ' + whoClass(w) + '">' + money(c.limit) + ' limit</span></div>' +
        '<div class="meter"><div class="meter-top"><span class="meter-name">Owed ' + money(owed) + '</span><span class="meter-val">50% line: ' + money(c.line) + '</span></div>' +
        '<div class="bar ' + cls + '"><i style="width:' + Math.min(100, pct * 100) + '%"></i><span class="line" style="left:' + ((plan.cards.maxPct || 0.5) * 100) + '%"></span></div>' +
        '<div class="meter-note ' + cls + '">' + (c.owed > c.line ? 'Over the line by ' + money(c.owed - c.line) + '. Pay it down before using the card again.' : money(c.room) + ' of room before the line.') + (c.owed < 0 ? ' You have a ' + money(-c.owed) + ' credit on this card.' : '') + '</div></div>' +
        '<div class="grid2"><div class="field"><label for="start-' + w + '">What you owed on Oct 1</label><div class="money-input"><span>$</span><input id="start-' + w + '" data-start="' + esc(w) + '" type="number" inputmode="decimal" min="0" step="0.01" value="' + Number(state.cardStart[w] || 0) + '"></div></div>' +
        '<div class="field"><span class="lab">&nbsp;</span><button type="button" class="btn secondary" data-cardpay="' + esc(w) + '">Log a card payment</button></div></div></section>';
    }
    if (plan.cardTips && plan.cardTips.length) h += '<div class="card flat small"><b>What goes on each card</b><ul class="ol">' + plan.cardTips.map(t => '<li>' + esc(t) + '</li>').join('') + '</ul></div>';
    return h;
  }

  // ---------- notifications ----------
  const pushSupported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  let swReg = null, mySub = null;

  async function refreshSub() {
    if (!pushSupported) return;
    try { swReg = await navigator.serviceWorker.ready; mySub = await swReg.pushManager.getSubscription(); } catch (e) { mySub = null; }
  }
  function urlB64(b64) { const pad = '='.repeat((4 - b64.length % 4) % 4); const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(raw, c => c.charCodeAt(0)); }

  async function enablePush() {
    if (!me) { await pickMe(); if (!me) return; }
    if (!pushSupported) { toast(isIOS ? 'Add the app to your Home Screen first, then open it from there.' : 'This browser cannot show notifications.'); return; }
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') { toast('Notifications were not allowed. You can allow them in your phone settings.'); render(); return; }
    try {
      swReg = await navigator.serviceWorker.ready;
      mySub = await swReg.pushManager.getSubscription() || await swReg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64(plan.vapidPublicKey) });
      const json = mySub.toJSON();
      await mutate(st => {
        st.subs[me] = (st.subs[me] || []).filter(s => s.endpoint !== json.endpoint);
        st.subs[me].push({ endpoint: json.endpoint, keys: json.keys, device: deviceName(), added: today() });
        st.notify[me] = true;
      }, 'Turn on notifications for ' + me);
      swReg.showNotification('Bank of B&B', { body: 'Notifications are on for ' + me + '. Payday reminders arrive at 7:00 AM.', icon: 'icon-192.png', badge: 'icon-192.png', tag: 'welcome' });
    } catch (e) { toast('Could not turn on notifications: ' + (e.message || e)); }
    render();
  }
  async function disablePushHere() {
    await refreshSub();
    if (mySub) { const ep = mySub.endpoint; try { await mySub.unsubscribe(); } catch (e) { } mySub = null; await mutate(st => { Object.keys(st.subs).forEach(w => st.subs[w] = (st.subs[w] || []).filter(s => s.endpoint !== ep)); }, 'Remove this device from notifications'); }
    render();
  }
  function deviceName() { const ua = navigator.userAgent; return /iPhone/.test(ua) ? 'iPhone' : /Android/.test(ua) ? 'Android phone' : /Windows/.test(ua) ? 'Windows PC' : /Mac/.test(ua) ? 'Mac' : 'Device'; }
  async function sendTestFromGitHub() {
    if (!me) return;
    try {
      const r = await fetch(API + '/repos/' + conn.owner + '/' + conn.repo + '/actions/workflows/notify.yml/dispatches', { method: 'POST', headers: ghHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify({ ref: 'main', inputs: { person: me } }) });
      if (r.status === 204) toast('Test sent. It usually arrives within a minute.');
      else if (r.status === 403 || r.status === 404) toast('The token needs "Actions: Read and write" to send a test.');
      else toast('GitHub said ' + r.status + '.');
    } catch (e) { toast('Could not reach GitHub.'); }
  }

  function viewSettings() {
    let h = '<section><h1>Alerts &amp; settings</h1><p class="lead">Payday steps arrive as a phone notification at 7:00 AM. You also get a reminder the evening before rent, and a warning if a card goes over 50% or a budget runs out.</p></section>';
    const perm = pushSupported ? Notification.permission : 'unsupported';
    const hereOn = !!mySub;
    h += '<section class="card"><h2>This phone</h2>';
    if (isIOS && !standalone) {
      h += '<p>On iPhone, notifications only work from the Home Screen app.</p><ol class="ol"><li>Open this page in <b>Safari</b>.</li><li>Tap <b>Share</b>, then <b>Add to Home Screen</b>.</li><li>Open <b>B&amp;B</b> from your Home Screen, then come back to this tab and tap <b>Turn on notifications</b>.</li></ol>';
    } else if (!pushSupported) {
      h += '<p>This browser can\'t show notifications. On Android, use Chrome. On iPhone, add the app to your Home Screen from Safari.</p>';
    } else {
      h += '<p class="muted small">' + (hereOn ? 'Notifications are on for this ' + deviceName() + ' (' + esc(me || '') + ').' : perm === 'denied' ? 'Notifications are blocked for this app. Allow them in your phone\'s settings for this site, then reload.' : 'Notifications are off on this ' + deviceName() + '.') + '</p><div class="btns" style="margin-top:10px">' +
        (hereOn ? '<button type="button" class="btn secondary" id="pushOff">Turn off on this phone</button><button type="button" class="btn" id="testLocal">Show a test now</button><button type="button" class="btn secondary" id="testRemote">Send test from GitHub</button>'
          : '<button type="button" class="btn" id="pushOn"' + (perm === 'denied' ? ' disabled' : '') + '>Turn on notifications</button>') + '</div>';
      if (!isIOS && /Brave/.test(navigator.userAgent + (navigator.brave ? ' Brave' : ''))) h += '<p class="small muted" style="margin-top:10px">Using Brave on Android? Turn on <b>Settings › Privacy › Use Google services for push messaging</b>, or use Chrome.</p>';
    }
    h += '</section>';

    h += '<section class="card"><h2>Who gets morning notifications</h2><p class="muted small">Switch someone off to pause their reminders on every device.</p>';
    for (const w of Object.keys(plan.people)) {
      const on = state.notify[w] !== false;
      const n = (state.subs[w] || []).length;
      h += '<div class="switch-row"><div><b>' + esc(w) + '</b><div class="small muted">' + (n ? n + ' device' + (n > 1 ? 's' : '') + ' set up' : 'No devices set up yet') + '</div></div><button type="button" class="switch" role="switch" aria-checked="' + on + '" data-notify="' + esc(w) + '" aria-label="Notifications for ' + esc(w) + '"></button></div>';
    }
    h += '</section>';

    h += '<section class="card"><h2>You are</h2><div class="seg" role="group" aria-label="You are" style="margin-top:8px">' + Object.keys(plan.people).map(w => '<button type="button" data-me="' + esc(w) + '" aria-pressed="' + (me === w) + '">' + esc(w) + '</button>').join('') + '</div><p class="small muted" style="margin:8px 0 0">Saved on this device only.</p></section>';

    h += '<section class="card"><h2>Connection</h2><p class="small muted">Data repo: <code>' + esc(conn.owner + '/' + conn.repo) + '</code></p><div class="btns" style="margin-top:8px"><button type="button" class="btn secondary" id="editConn">Change connection</button><button type="button" class="btn ghost" id="reloadBtn">Reload data</button></div></section>';
    return h;
  }

  function viewSetup() {
    return '<section><h1>Connect Bank of B&amp;B</h1><p class="lead">Do this once on each phone. The token stays on this device only.</p></section>' +
      '<form class="card" id="setupForm" autocomplete="off">' +
      '<div class="grid2"><div class="field"><label for="cOwner">GitHub username</label><input id="cOwner" type="text" autocapitalize="off" autocorrect="off" spellcheck="false" required value="' + esc(conn.owner) + '"></div>' +
      '<div class="field"><label for="cRepo">Data repo</label><input id="cRepo" type="text" autocapitalize="off" autocorrect="off" spellcheck="false" required value="' + esc(conn.repo || 'bank-of-bnb-data') + '"></div></div>' +
      '<div class="field"><label for="cToken">Access token</label><input id="cToken" type="password" autocapitalize="off" autocorrect="off" spellcheck="false" required placeholder="github_pat_…" value="' + esc(conn.token) + '"></div>' +
            '<button class="btn" type="submit">Connect</button></form>' +
      '<div class="card flat small"><b>Where do I get the token?</b><p class="muted" style="margin:4px 0 0">It was made when the app was set up. Both phones use the same token. Get it from whoever set it up, sent privately.</p></div>';
  }

  async function pickMe() {
    const v = await modal('Who is using this phone?', '<p class="muted">This decides whose steps show first and who gets this phone\'s notifications.</p>', Object.keys(plan ? plan.people : {}).map(w => ({ label: w, value: w })));
    if (v) { me = v; LS.set('me', me); render(); }
  }

  // ---------- render + events ----------
  function render() {
    const whoBtn = $('#whoBtn');
    whoBtn.textContent = me || 'Who are you?';
    whoBtn.className = 'who-btn ' + (me ? whoClass(me) : '');
    document.querySelectorAll('.tab').forEach(b => b.setAttribute('aria-current', b.dataset.tab === (tab === 'trip' ? 'plan' : tab) ? 'page' : 'false'));
    $('.tabs').hidden = tab === 'setup';
    const v = $('#view');
    if (tab === 'setup' || !plan) v.innerHTML = viewSetup();
    else if (tab === 'plan') v.innerHTML = viewPlan();
    else if (tab === 'spend') v.innerHTML = viewSpend();
    else if (tab === 'cards') v.innerHTML = viewCards();
    else if (tab === 'settings') v.innerHTML = viewSettings();
    else if (tab === 'trip') v.innerHTML = viewTrip();
    else v.innerHTML = viewToday();
  }

  function go(t) { tab = t; if (history.replaceState) history.replaceState(null, '', '#' + t); render(); window.scrollTo(0, 0); }

  document.addEventListener('click', async (e) => {
    const t = e.target.closest('button, [data-go]');
    if (!t) return;
    if (t.classList.contains('tab')) return go(t.dataset.tab);
    if (t.dataset.go) return go(t.dataset.go);
    if (t.id === 'whoBtn') return pickMe();
    if (t.classList.contains('step') && t.dataset.ev) return toggleStep(t.dataset.ev, t.dataset.key);
    if (t.dataset.filter) { planFilter = t.dataset.filter; return render(); }
    if (t.id === 'pastBtn') { showPast = !showPast; return render(); }
    if (t.dataset.method) { t.parentElement.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', b === t)); return; }
    if (t.dataset.del) {
      const entry = state.expenses.find(x => x.id === t.dataset.del); if (!entry) return;
      const ok = await modal('Delete this entry?', '<p>' + money(entry.amount) + ' on ' + esc(B.nice(entry.date)) + (entry.note ? ' · ' + esc(entry.note) : '') + '</p>', [{ label: 'Keep it', cls: 'secondary', value: false }, { label: 'Delete', cls: 'danger', value: true }]);
      if (ok) mutate(st => { st.expenses = st.expenses.filter(x => x.id !== entry.id); }, 'Delete entry');
      return;
    }
    if (t.dataset.tripItem) return toggleTripItem(t.dataset.trip, t.dataset.tripItem);
    if (t.dataset.logcat) { const c = t.dataset.logcat, w = t.dataset.logwho; go('spend'); setTimeout(() => { $('#sCat').value = c; if (w) $('#sWho').value = w; $('#sAmt').focus(); }, 0); return; }
    if (t.dataset.cardpay) { go('spend'); setTimeout(() => { $('#sCat').value = 'cardpay'; $('#sWho').value = t.dataset.cardpay; $('#methodField').hidden = true; $('#sAmt').focus(); }, 0); return; }
    if (t.dataset.notify) { const w = t.dataset.notify; const on = state.notify[w] !== false; return mutate(st => { st.notify[w] = !on; }, (on ? 'Pause' : 'Resume') + ' notifications for ' + w); }
    if (t.dataset.me) { me = t.dataset.me; LS.set('me', me); return render(); }
    if (t.dataset.setme) { me = t.dataset.setme; LS.set('me', me); t.parentElement.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', b === t)); return; }
    if (t.id === 'pushOn') return enablePush();
    if (t.id === 'pushOff') return disablePushHere();
    if (t.id === 'testLocal') { await refreshSub(); if (swReg) swReg.showNotification('Test from Bank of B&B', { body: 'Notifications work on this ' + deviceName() + '.', icon: 'icon-192.png', tag: 'test' }); return; }
    if (t.id === 'testRemote') return sendTestFromGitHub();
    if (t.id === 'editConn') return go('setup');
    if (t.id === 'reloadBtn') { await load(); toast('Up to date.'); return; }
  });

  document.addEventListener('change', (e) => {
    if (e.target.id === 'monthSel') { spendMonth = e.target.value; render(); }
    if (e.target.id === 'sCat') { const mf = $('#methodField'); if (mf) mf.hidden = e.target.value === 'cardpay'; }
    if (e.target.dataset && e.target.dataset.start) {
      const w = e.target.dataset.start; const v = Math.max(0, parseFloat(e.target.value) || 0);
      mutate(st => { st.cardStart[w] = v; }, 'Set starting card balance for ' + w);
    }
  });

  document.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (e.target.id === 'spendForm') return submitSpend(e.target);
    if (e.target.id === 'setupForm') {
      conn = { owner: $('#cOwner').value.trim(), repo: $('#cRepo').value.trim(), token: $('#cToken').value.trim() };
      LS.set('conn', conn);
      showBanner('');
      tab = 'today';
      await load();
      if (plan && !me) pickMe();
    }
  });

  // keep both phones in sync
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && plan && !saving) load(true); });
  setInterval(() => { if (document.visibilityState === 'visible' && plan && !saving && $('#modal').hidden && (tab === 'today' || tab === 'plan' || tab === 'cards')) load(true); }, 90000);

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').then(() => refreshSub().then(() => { if (tab === 'settings') render(); })).catch(() => {});

  render();
  load();
})();
