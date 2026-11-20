// /api/cron/grant-reminders — daily grant & award email (Vercel Cron, see vercel.json).
// Sends at most one digest per day to RECIPIENTS: new "now open" notifications
// (with Accept / Reject buttons) + the single fortnight reminder per item.
//
//   ?dryRun=1                → don't send or record anything; return items + email HTML
//   ?dryRun=1&date=YYYY-MM-DD → simulate another day
//
// Env: GMAIL_USER, GMAIL_PASS (Gmail app password), KV vars (already on the project).
// Optional: REMINDER_SECRET for signing Accept/Reject links (falls back to KV token).

import { kv } from '@vercel/kv';
import nodemailer from 'nodemailer';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  RECIPIENTS, todayIST, collectDue, markSent, parseGrantsFromHtml, buildEmail,
} from '../../lib/reminder-logic.js';

export const SITE_URL = 'https://bambrew-grants.vercel.app';
const SHARED_KEY = 'bambrew-shared-state';
const LOG_KEY = 'grant-reminder-log';

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
    if (!process.env.GMAIL_USER || !process.env.GMAIL_PASS) {
      throw new Error('GMAIL_USER / GMAIL_PASS env vars are not set on this Vercel project');
    }

    await nodemailer.createTransport({
      service: 'gmail',
      auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_PASS },
    }).sendMail({ from: `Bambrew Grants <${process.env.GMAIL_USER}>`, to: RECIPIENTS.join(', '), subject, html });

    await kv.set(LOG_KEY, markSent(log, due, today));
    return res.status(200).json({ ok: true, today, sent: true, recipients: RECIPIENTS, items: summary });
  } catch (err) {
    console.error('grant-reminders error:', err);
    return res.status(500).json({ error: err.message });
  }
}
