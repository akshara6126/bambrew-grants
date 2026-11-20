// /api/cron/grant-reminders — daily grant & award email (Vercel Cron, see vercel.json).
// Sends at most one digest per day to RECIPIENTS: new "now open" notifications
// (with Accept / Reject buttons) + the single fortnight reminder per item.
//
//   ?dryRun=1                → don't send or record anything; return items + email HTML
//   ?dryRun=1&date=YYYY-MM-DD → simulate another day
//
// Env: MAIL_RELAY_SECRET (shared with the compliance project), KV vars (already on the project).
// Optional: REMINDER_SECRET for signing Accept/Reject links (falls back to KV token).

import { kv } from '@vercel/kv';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  RECIPIENTS, todayIST, collectDue, markSent, parseGrantsFromHtml, buildEmail,
} from '../../lib/reminder-logic.js';

export const SITE_URL = 'https://bambrew-grants.vercel.app';
const SHARED_KEY = 'bambrew-shared-state';
const LOG_KEY = 'grant-reminder-log';
// Emails go out through the compliance dashboard's Gmail (bambrewcompliance@gmail.com)
// via its /api/mail-relay endpoint, so the Gmail password is stored in one place only.
const MAIL_RELAY_URL = 'https://bambrew-compliance.vercel.app/api/mail-relay';

async function sendMail({ subject, html }) {
  if (!process.env.MAIL_RELAY_SECRET) throw new Error('MAIL_RELAY_SECRET env var is not set on this Vercel project');
  const r = await fetch(MAIL_RELAY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.MAIL_RELAY_SECRET}` },
    body: JSON.stringify({ to: RECIPIENTS, subject, html, fromName: 'Bambrew Grants' }),
  });
  if (!r.ok) throw new Error(`Mail relay failed: HTTP ${r.status} ${await r.text()}`);
}

export default async function handler(req, res) {
  const dryRun = req.query.dryRun === '1';
  const today = dryRun && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : todayIST();
  const secret = process.env.REMINDER_SECRET || process.env.KV_REST_API_TOKEN;

  try {
    if (!secret) throw new Error('No signing secret (REMINDER_SECRET or KV_REST_API_TOKEN) available');
    const curated = parseGrantsFromHtml(readFileSync(join(process.cwd(), 'index.html'), 'utf8'));
    const [shared, savedLog] = await Promise.all([kv.get(SHARED_KEY), kv.get(LOG_KEY)]);
    const userState = (shared && shared.userState) || {};
    const userGrants = (shared && shared.userGrants) || [];
    const log = { notified: {}, reminded: {}, ...(savedLog || {}) };

    const due = collectDue(curated.concat(userGrants), userState, log, today);
    const summary = [...due.notifications.map(i => ({ type: 'notification', ...i })), ...due.reminders.map(i => ({ type: 'reminder', ...i }))]
      .map(({ type, id, name, category, deadline, daysLeft, status, estimated }) => ({ type, id, name, category, deadline, daysLeft, status, estimated }));

    if (!summary.length) {
      return res.status(200).json({ ok: true, today, sent: false, reason: 'nothing due today' });
    }
    const { subject, html } = buildEmail(due, today, SITE_URL, secret);

    if (dryRun) {
      return res.status(200).json({ ok: true, dryRun: true, today, recipients: RECIPIENTS, subject, items: summary, html });
    }
    await sendMail({ subject, html });

    await kv.set(LOG_KEY, markSent(log, due, today));
    return res.status(200).json({ ok: true, today, sent: true, recipients: RECIPIENTS, items: summary });
  } catch (err) {
    console.error('grant-reminders error:', err);
    return res.status(500).json({ error: err.message });
  }
}
