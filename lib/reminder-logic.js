// Pure logic for grant/award email reminders. No I/O, so it can be tested locally.
//
// Per grant/award, per cycle, at most TWO emails' worth of mentions:
//   1. NOTIFICATION when it comes up (application window opens) — with Accept / Reject buttons.
//   2. ONE REMINDER when the deadline is REMINDER_DAYS (a fortnight) or less away.
// Rejected (status "skipped"), submitted, won or lost items are never reminded.
// Everything due on the same day is bundled into one digest email.

import { createHmac, timingSafeEqual } from 'node:crypto';

// ── CONFIG ──────────────────────────────────────────────────────────────────
export const RECIPIENTS = ['arjun@bambrew.in', 'manisha@bambrew.in'];
export const REMINDER_DAYS = 14;          // the "before the fortnight" reminder
export const NO_LAUNCH_NOTIFY_DAYS = 60;  // no known opening date → notify this many days before deadline
export const DONE_STATUSES = new Set(['submitted', 'won', 'lost', 'skipped']);
// ────────────────────────────────────────────────────────────────────────────

export function todayIST(now = new Date()) {
  return new Date(now.getTime() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
}
function dayNum(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return Date.UTC(y, m - 1, d) / 86400000;
}
function addMonths(iso, months) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1 + months, d)).toISOString().slice(0, 10);
}
const isISO = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);

// Same rollover rule as effectiveDeadline() in index.html: a cyclical grant whose
// deadline has passed moves forward by cycleMonths until it is today or later.
// The opening date shifts by the same amount. Rolled dates are estimates.
export function effectiveDates(g, today) {
  if (!isISO(g.deadline)) return { deadline: null, launch: null, rolled: false };
  let deadline = g.deadline, shift = 0;
  if (g.cycleMonths) {
    while (dayNum(deadline) < dayNum(today)) {
      shift += g.cycleMonths;
      deadline = addMonths(g.deadline, shift);
    }
  }
  const launch = isISO(g.launch) ? (shift ? addMonths(g.launch, shift) : g.launch) : null;
  return { deadline, launch, rolled: shift > 0 };
}

// log = { notified: {cycleKey: date}, reminded: {cycleKey: date} } — persisted in KV.
export function collectDue(grants, userState, log, today) {
  const notifications = [], reminders = [];
  for (const g of grants) {
    if (!g || !g.id || g.autoDiscovered) continue;   // news headlines, not real calls
    const status = (userState[g.id] && userState[g.id].status) || 'not-started';
    if (DONE_STATUSES.has(status)) continue;

    const { deadline, launch, rolled } = effectiveDates(g, today);
    if (!deadline) continue;                          // rolling / undated: nothing to time
    const daysLeft = dayNum(deadline) - dayNum(today);
    if (daysLeft < 0) continue;                       // past and not cyclical

    const cycle = `${g.id}|${deadline}`;
    const opensOn = launch || new Date((dayNum(deadline) - NO_LAUNCH_NOTIFY_DAYS) * 86400000).toISOString().slice(0, 10);
    const item = {
      id: g.id, cycle, name: g.name, category: g.category === 'award' ? 'award' : 'grant',
      url: g.url || '', value: g.value || '', deadline, launch, daysLeft, status, estimated: rolled,
    };

    if (!log.notified[cycle]) {
      if (dayNum(opensOn) <= dayNum(today)) notifications.push(item);
    } else if (!log.reminded[cycle] && daysLeft <= REMINDER_DAYS) {
      reminders.push(item);
    }
  }
  const byDays = (a, b) => a.daysLeft - b.daysLeft;
  return { notifications: notifications.sort(byDays), reminders: reminders.sort(byDays) };
}

// After a successful send: mark notifications (and, if already inside the
// fortnight window, their reminder too, so nobody gets two emails back to back).
export function markSent(log, { notifications, reminders }, today) {
  for (const it of notifications) {
    log.notified[it.cycle] = today;
    if (it.daysLeft <= REMINDER_DAYS) log.reminded[it.cycle] = today;
  }
  for (const it of reminders) log.reminded[it.cycle] = today;
  return log;
}

export function parseGrantsFromHtml(html) {
  const start = html.indexOf('const GRANTS = [');
  if (start < 0) throw new Error('GRANTS array not found in index.html');
  const open = html.indexOf('[', start);
  const end = html.indexOf('\n];', open);
  if (end < 0) throw new Error('End of GRANTS array not found');
  return new Function(`return ${html.slice(open, end + 2)};`)();
}

// ── Signed Accept / Reject links ─────────────────────────────────────────────
export function sign(secret, id, cycle, action) {
  return createHmac('sha256', secret).update(`${id}\n${cycle}\n${action}`).digest('hex').slice(0, 32);
}
export function verify(secret, id, cycle, action, sig) {
  const a = Buffer.from(sign(secret, id, cycle, action)), b = Buffer.from(String(sig || ''));
  return a.length === b.length && timingSafeEqual(a, b);
}
function decisionUrl(siteUrl, secret, it, action) {
  const q = new URLSearchParams({ id: it.id, cycle: it.cycle, action, sig: sign(secret, it.id, it.cycle, action) });
  return `${siteUrl}/api/grant-decision?${q}`;
}

// ── Email HTML ───────────────────────────────────────────────────────────────
export const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function fmt(iso) {
  if (!iso) return '-';
  return new Date(iso + 'T00:00:00Z').toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}
const pill = (txt, fg, bg) => `<span style="background:${bg};color:${fg};border-radius:4px;padding:2px 7px;font-size:10px;font-weight:700;">${txt}</span>`;
const btn = (href, txt, bg) => `<a href="${esc(href)}" style="display:inline-block;background:${bg};color:#fff;padding:6px 14px;border-radius:5px;font-size:12px;font-weight:700;text-decoration:none;margin-right:6px;">${txt}</a>`;

function card(it, { siteUrl, secret, withButtons }) {
  const name = it.url ? `<a href="${esc(it.url)}" style="color:#0f2a1e;">${esc(it.name)}</a>` : esc(it.name);
  const kind = it.category === 'award' ? pill('AWARD', '#6b3fa0', '#f1eafa') : pill('GRANT', '#1c5496', '#dbeafe');
  const dueColor = it.daysLeft <= 7 ? '#b03030' : it.daysLeft <= REMINDER_DAYS ? '#c0740a' : '#57636d';
  const due = it.daysLeft === 0 ? 'due today' : `${it.daysLeft} day${it.daysLeft !== 1 ? 's' : ''} left`;
  const est = it.estimated ? ' <span style="color:#8a929a;">(estimated next cycle, verify on site)</span>' : '';
  const status = it.status === 'in-progress' ? ` · ${pill('Accepted / In Progress', '#b88410', '#fef8e1')}` : '';
  const buttons = withButtons
    ? `<div style="margin-top:10px;">${btn(decisionUrl(siteUrl, secret, it, 'accept'), 'Accept', '#2a8f5e')}${btn(decisionUrl(siteUrl, secret, it, 'reject'), 'Reject', '#b03030')}</div>`
    : '';
  return `<div style="border:1px solid #e6e8eb;border-radius:8px;padding:12px 14px;margin-bottom:10px;">
    <div style="margin-bottom:4px;">${kind}${status}</div>
    <div style="font-size:14px;font-weight:700;">${name}</div>
    ${it.value ? `<div style="font-size:12px;color:#57636d;margin-top:2px;">${esc(it.value)}</div>` : ''}
    <div style="font-size:12px;margin-top:6px;">Deadline: <b>${fmt(it.deadline)}</b> · <span style="color:${dueColor};font-weight:700;">${due}</span>${est}</div>
    ${buttons}
  </div>`;
}

export function buildEmail({ notifications, reminders }, today, siteUrl, secret) {
  const opts = { siteUrl, secret };
  const sec = (title, sub, items, withButtons) => items.length
    ? `<h3 style="font-size:12px;font-weight:700;color:#0f2a1e;margin:22px 0 4px;text-transform:uppercase;letter-spacing:0.5px;">${title} (${items.length})</h3>
       <p style="font-size:12px;color:#57636d;margin:0 0 10px;">${sub}</p>
       ${items.map(it => card(it, { ...opts, withButtons })).join('')}`
    : '';
  const dateStr = new Date(today + 'T00:00:00Z').toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
  const html = `
<div style="font-family:-apple-system,'Helvetica Neue',Arial,sans-serif;max-width:620px;margin:0 auto;padding:32px 26px;border:1px solid #e6e8eb;border-radius:10px;background:#fff;color:#0f2a1e;">
  <div style="margin-bottom:18px;"><span style="background:#0f2a1e;color:#fff;padding:5px 12px;border-radius:4px;font-size:11px;font-weight:700;letter-spacing:0.8px;">BAMBREW GRANTS &amp; AWARDS</span></div>
  <p style="font-size:12px;color:#57636d;margin:0 0 4px;">${dateStr}</p>
  ${sec('Now open', 'Accept to pursue it, or Reject to stop all reminders for it.', notifications, true)}
  ${sec(`Reminder: deadline within ${REMINDER_DAYS} days`, 'Final reminder. No further emails will be sent for these.', reminders, false)}
  <a href="${esc(siteUrl)}" style="display:inline-block;margin-top:14px;background:#0f2a1e;color:#fff;padding:11px 22px;border-radius:6px;font-size:13px;font-weight:700;text-decoration:none;">Open grants dashboard</a>
  <p style="color:#a0a8b0;font-size:11px;margin:20px 0 0;">Marking an item Submitted, Won, Lost or Skipped on the dashboard also stops reminders. Automated email, do not reply.</p>
</div>`;
  const parts = [];
  if (notifications.length) parts.push(`${notifications.length} now open`);
  if (reminders.length) parts.push(`${reminders.length} due within ${REMINDER_DAYS} days`);
  return { subject: `[Grants & Awards] ${parts.join(', ')}`, html };
}
