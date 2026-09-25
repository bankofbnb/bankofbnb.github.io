/* Bank of B&B plan engine. Shared by the web app and the morning notification job.
   It turns plan.json (rules + amounts) into dated events with ordered steps and
   running balances, and summarises activity from state.json. No personal data lives here. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BNB = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---- dates (all dates are plain YYYY-MM-DD strings, no time zones) ----
  function parse(iso) { const [y, m, d] = iso.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); }
  function iso(dt) { return dt.toISOString().slice(0, 10); }
  function addDays(isoStr, n) { const d = parse(isoStr); d.setUTCDate(d.getUTCDate() + n); return iso(d); }
  function month(isoStr) { return isoStr.slice(0, 7); }
  function monthNum(isoStr) { return Number(isoStr.slice(5, 7)); }
  function addMonths(isoStr, n) { const d = parse(isoStr); d.setUTCMonth(d.getUTCMonth() + n); return iso(d); }
  function todayIn(tz) {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'America/Vancouver', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    return parts; // en-CA gives YYYY-MM-DD
  }
  function hourIn(tz) {
    return Number(new Intl.DateTimeFormat('en-GB', { timeZone: tz || 'America/Vancouver', hour: '2-digit', hour12: false }).format(new Date()));
  }
  const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function nice(isoStr, withDow) {
    const d = parse(isoStr);
    return (withDow === false ? '' : DOW[d.getUTCDay()] + ' ') + MON[d.getUTCMonth()] + ' ' + d.getUTCDate();
  }
  function monthName(ym) { const [y, m] = ym.split('-').map(Number); return MON[m - 1] + ' ' + y; }
  function money(n) {
    const v = Math.round(Number(n) || 0);
    return (v < 0 ? '-$' : '$') + Math.abs(v).toLocaleString('en-US');
  }

  function matches(list, date, who, key) {
    return (list || []).some(r => r.date === date && r.who === who && (key === undefined || r.key === key));
  }

  // ---- build the schedule ----
  function buildEvents(plan, opts) {
    opts = opts || {};
    const start = plan.startDate;
    const end = opts.end || addMonths(start, plan.horizonMonths || 12);
    const events = [];
    const firstSeen = {}; // who|YYYY-MM -> true

    // paydays
    for (const who of Object.keys(plan.people)) {
      const p = plan.people[who];
      for (let d = p.firstPay; d <= end; d = addDays(d, p.everyDays || 14)) {
        const ym = month(d);
        const firstOfMonth = !firstSeen[who + '|' + ym];
        firstSeen[who + '|' + ym] = true;
        const amount = d === p.firstPay && p.firstPayAmount ? p.firstPayAmount : p.payAmount;
        const steps = [{ key: 'pay', type: 'in', label: 'Paycheck arrives', amount, order: 0 }];
        const add = (item) => {
          if (item.months && item.months.indexOf(monthNum(d)) === -1) return;
          if (matches(plan.skip, d, who, item.key)) return;
          steps.push({ key: item.key, type: 'out', label: item.label, amount: item.amount, order: item.order || 50, hint: item.hint, confirm: !!item.confirm, cat: item.cat, card: item.card });
        };
        (plan.everyPay[who] || []).forEach(add);
        if (firstOfMonth) (plan.firstPayOfMonth[who] || []).forEach(add);
        (plan.oneOff || []).filter(o => o.date === d && o.who === who).forEach(o => {
          steps.push({ key: o.key, type: 'out', label: o.label, amount: o.amount, order: o.order || 50, hint: o.hint, confirm: !!o.confirm, big: true, card: o.card });
        });
        const hold = (plan.holdInstead || []).find(h => h.date === d && h.who === who);
        if (hold) steps.push({ key: 'hold', type: 'keep', label: hold.label, order: 99 });
        else if (p.leftover === 'save') steps.push({ key: 'save', type: 'save', label: 'Move everything left to savings', order: 99 });
        else steps.push({ key: 'keep', type: 'keep', label: p.keepLabel || 'Leave the rest in your account', order: 99 });
        steps.sort((a, b) => a.order - b.order);
        events.push({ id: d + '|' + who, date: d, who, kind: 'payday', title: who + "'s payday", steps });
      }
    }
    // rent
    if (plan.rent) {
      for (let d = plan.rent.firstDate; d <= end; d = addMonths(d, 1)) {
        events.push({ id: d + '|' + plan.rent.who + '|rent', date: d, who: plan.rent.who, kind: 'rent', title: 'Rent day',
          steps: [{ key: 'rent', type: 'out', label: plan.rent.label || 'Pay rent', amount: plan.rent.amount, confirm: true, big: true, order: 1 }] });
      }
    }
    // notes (flight day etc.)
    (plan.notes || []).forEach(n => {
      if (n.date <= end) events.push({ id: n.date + '|Both|' + (n.key || 'note'), date: n.date, who: 'Both', kind: 'note', title: n.title, text: n.text, steps: [] });
    });

    const kindOrder = { payday: 0, rent: 1, note: 2 };
    events.sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : kindOrder[a.kind] - kindOrder[b.kind]);

    // running balances (planned)
    const bal = {}; Object.keys(plan.people).forEach(w => bal[w] = 0);
    let savings = 0;
    for (const ev of events) {
      for (const s of ev.steps) {
        const w = ev.who;
        if (s.type === 'in') bal[w] += s.amount;
        else if (s.type === 'out') bal[w] -= s.amount;
        else if (s.type === 'save') { s.amount = Math.max(0, bal[w]); savings += s.amount; bal[w] -= s.amount; }
        else if (s.type === 'keep') s.amount = bal[w];
        s.after = w in bal ? bal[w] : 0;
      }
      ev.balances = Object.assign({}, bal);
      ev.savings = savings;
    }
    return events;
  }

  // ---- activity summaries ----
  function isDone(state, ev, key) { return !!(state.done && state.done[ev.id] && state.done[ev.id][key]); }
  function eventProgress(state, ev) {
    const actionable = ev.steps.filter(s => s.type !== 'in');
    const done = actionable.filter(s => isDone(state, ev, s.key)).length;
    return { done, total: actionable.length, complete: actionable.length > 0 && done === actionable.length };
  }

  function summary(plan, state, events, today) {
    const ym = month(today);
    const out = { month: ym, budgets: [], cards: {}, savingsDone: 0, savingsPlanned: 0, overdue: [], next: null };
    // budgets this month
    for (const b of plan.budgets || []) {
      const spent = (state.expenses || []).filter(e => e.cat === b.key && month(e.date) === ym).reduce((t, e) => t + Number(e.amount), 0);
      out.budgets.push(Object.assign({}, b, { spent, left: b.monthly - spent, pct: b.monthly ? spent / b.monthly : 0 }));
    }
    // cards: start + charges on card - payments (logged payments + ticked card steps)
    for (const who of Object.keys(plan.cards || {})) {
      if (who === 'maxPct') continue;
      const c = plan.cards[who];
      const start = Number((state.cardStart || {})[who] || 0);
      const charges = (state.expenses || []).filter(e => e.who === who && e.method === 'card' && e.cat !== 'cardpay').reduce((t, e) => t + Number(e.amount), 0);
      const logged = (state.expenses || []).filter(e => e.who === who && e.cat === 'cardpay').reduce((t, e) => t + Number(e.amount), 0);
      let stepPaid = 0;
      events.forEach(ev => { if (ev.who === who) ev.steps.forEach(s => { if (s.key === 'card' && isDone(state, ev, 'card')) stepPaid += s.amount; }); });
      const owed = start + charges - logged - stepPaid;
      const line = c.limit * (plan.cards.maxPct || 0.5);
      out.cards[who] = { limit: c.limit, line, owed, room: line - owed, pct: c.limit ? owed / c.limit : 0 };
    }
    // savings
    events.forEach(ev => ev.steps.forEach(s => {
      if (s.type === 'save') {
        if (ev.date <= today || isDone(state, ev, 'save')) out.savingsPlanned += 0;
        if (isDone(state, ev, 'save')) out.savingsDone += s.amount;
      }
    }));
    const endOfMonth = events.filter(e => month(e.date) === ym).slice(-1)[0];
    out.savingsPlannedByMonthEnd = endOfMonth ? endOfMonth.savings : (events.filter(e => e.date <= today).slice(-1)[0] || { savings: 0 }).savings;
    // overdue and next
    for (const ev of events) {
      if (ev.kind === 'note') continue;
      const p = eventProgress(state, ev);
      if (ev.date < today && !p.complete) out.overdue.push(ev);
    }
    out.next = events.find(ev => ev.date >= today && (ev.kind === 'note' || !eventProgress(state, ev).complete)) || null;
    return out;
  }

  // ---- alerts used by the app banner and the morning job ----
  function alerts(plan, state, events, today) {
    const s = summary(plan, state, events, today);
    const list = [];
    for (const who of Object.keys(s.cards)) {
      const c = s.cards[who];
      if (c.owed > c.line) list.push({ who, level: 'bad', title: who + "'s card is over the 50% line", text: who + ' owes ' + money(c.owed) + ' on the card. The line is ' + money(c.line) + ' (50% of ' + money(c.limit) + '). Pay ' + money(c.owed - c.line) + ' off from the bank before using it again.' });
      else if (c.room < c.line * 0.2) list.push({ who, level: 'warn', title: who + "'s card is close to the 50% line", text: 'Only ' + money(c.room) + ' of room left before ' + money(c.line) + '. Use the bank card for the rest of this cycle.' });
    }
    for (const b of s.budgets) {
      if (b.spent > b.monthly) list.push({ who: b.who, level: 'bad', title: b.label + ' is over budget', text: money(b.spent) + ' spent of ' + money(b.monthly) + ' in ' + monthName(s.month) + '. The extra ' + money(b.spent - b.monthly) + ' comes out of ' + (plan.people[b.who] && plan.people[b.who].leftover === 'save' ? 'savings.' : 'the rent cushion.') });
      else if (b.pct >= 0.85) list.push({ who: b.who, level: 'warn', title: b.label + ' is almost used up', text: money(b.left) + ' left for the rest of ' + monthName(s.month) + '.' });
    }
    if (s.overdue.length) list.push({ who: 'Both', level: 'warn', title: s.overdue.length + ' earlier ' + (s.overdue.length === 1 ? 'payday has' : 'paydays have') + ' unticked steps', text: 'Open the Plan tab and tick off what was done, starting ' + nice(s.overdue[0].date) + '.' });
    return list;
  }

  // ---- text for notifications ----
  function stepLine(s) {
    if (s.type === 'in') return 'Paycheck: ' + money(s.amount);
    if (s.type === 'save') return s.label + ' (about ' + money(s.amount) + ')';
    if (s.type === 'keep') return s.label + (s.amount != null ? ' (about ' + money(s.amount) + ')' : '');
    return s.label + ': ' + money(s.amount);
  }
  function notificationsFor(plan, state, events, today, who) {
    const out = [];
    const tomorrow = addDays(today, 1);
    events.filter(ev => ev.date === today && (ev.who === who || ev.who === 'Both')).forEach(ev => {
      if (ev.kind === 'payday') {
        const pay = ev.steps.find(s => s.type === 'in');
        const rest = ev.steps.filter(s => s.type !== 'in');
        out.push({ title: 'Payday: ' + money(pay.amount) + ' today', body: rest.map((s, i) => (i + 1) + '. ' + stepLine(s)).join('\n') + '\nTap to tick them off.', tag: ev.id });
      } else if (ev.kind === 'rent') {
        out.push({ title: 'Rent day: ' + money(ev.steps[0].amount), body: 'Pay rent from your account today, then tick it off in the app.', tag: ev.id });
      } else if (ev.kind === 'note') {
        out.push({ title: ev.title, body: ev.text || '', tag: ev.id });
      }
    });
    events.filter(ev => ev.date === tomorrow && ev.kind === 'rent' && ev.who === who).forEach(ev => {
      out.push({ title: 'Rent is due tomorrow', body: money(ev.steps[0].amount) + ' on ' + nice(ev.date) + '. Make sure it is in your account tonight.', tag: ev.id + '|eve' });
    });
    alerts(plan, state, events, today).filter(a => a.who === who && a.level === 'bad').forEach(a => out.push({ title: a.title, body: a.text, tag: 'alert|' + a.title }));
    return out;
  }

  return { parse, iso, addDays, addMonths, month, nice, monthName, money, todayIn, hourIn, buildEvents, isDone, eventProgress, summary, alerts, stepLine, notificationsFor };
});
