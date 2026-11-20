// /api/grant-decision — Accept / Reject buttons in the "now open" email.
// GET  → confirmation page (so email link scanners that pre-open links can't
//        trigger a decision by themselves).
// POST → verifies the signed link and updates the dashboard's shared state:
//        accept → status "in-progress" (still gets the fortnight reminder)
//        reject → status "skipped"     (no more reminders)

import { kv } from '@vercel/kv';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { verify, esc, parseGrantsFromHtml } from '../lib/reminder-logic.js';

const SHARED_KEY = 'bambrew-shared-state';
const SITE_URL = 'https://bambrew-grants.vercel.app';
const LOCKED = new Set(['submitted', 'won', 'lost']); // never overwrite real outcomes

function page(title, body, color = '#0f2a1e') {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title></head>
<body style="margin:0;background:#f4f5f6;font-family:-apple-system,'Helvetica Neue',Arial,sans-serif;color:#0f2a1e;">
<div style="max-width:460px;margin:60px auto;padding:28px 24px;background:#fff;border:1px solid #e6e8eb;border-radius:10px;">
<div style="font-size:11px;font-weight:700;letter-spacing:0.8px;color:#57636d;margin-bottom:10px;">BAMBREW GRANTS &amp; AWARDS</div>
<h2 style="margin:0 0 12px;font-size:19px;color:${color};">${esc(title)}</h2>${body}
<p style="margin-top:22px;"><a href="${SITE_URL}" style="color:#1c5496;font-size:13px;">Open grants dashboard</a></p>
</div></body></html>`;
}

export default async function handler(req, res) {
  const params = req.method === 'POST' ? { ...req.query, ...(req.body || {}) } : req.query;
  const { id, cycle, action, sig } = params;
  const secret = process.env.REMINDER_SECRET || process.env.KV_REST_API_TOKEN;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');

  if (!['accept', 'reject'].includes(action) || !id || !cycle || !secret || !verify(secret, id, cycle, action, sig)) {
    return res.status(400).send(page('Invalid or expired link', '<p style="font-size:14px;">This link is not valid. Please update the status directly on the dashboard.</p>', '#b03030'));
  }

  try {
    const shared = (await kv.get(SHARED_KEY)) || { userState: {}, userGrants: [], dismissedAutoIds: [] };
    const userState = shared.userState || {};
    const current = userState[id] || {};
    let name = id;
    try {
      const all = parseGrantsFromHtml(readFileSync(join(process.cwd(), 'index.html'), 'utf8')).concat(shared.userGrants || []);
      name = (all.find(g => g.id === id) || {}).name || id;
    } catch { /* fall back to id */ }

    if (req.method !== 'POST') {
      const verb = action === 'accept' ? 'Accept' : 'Reject';
      const note = action === 'accept'
        ? 'It will be marked <b>In Progress</b> on the dashboard. You will still get one reminder 14 days before the deadline.'
        : 'It will be marked <b>Skipped</b> on the dashboard and no more reminders will be sent for it.';
      return res.status(200).send(page(`${verb} this opportunity?`, `
        <p style="font-size:14px;"><b>${esc(name)}</b></p>
        <p style="font-size:13px;color:#57636d;">${note}</p>
        <form method="POST">
          ${['id', 'cycle', 'action', 'sig'].map(k => `<input type="hidden" name="${k}" value="${esc(params[k])}">`).join('')}
          <button type="submit" style="background:${action === 'accept' ? '#2a8f5e' : '#b03030'};color:#fff;border:0;padding:10px 22px;border-radius:6px;font-size:14px;font-weight:700;cursor:pointer;">Confirm ${verb}</button>
        </form>`));
    }

    if (LOCKED.has(current.status)) {
      return res.status(200).send(page('No change made', `<p style="font-size:14px;">This item is already marked <b>${esc(current.status)}</b> on the dashboard, so it was left as is.</p>`));
    }

    const newStatus = action === 'accept' ? 'in-progress' : 'skipped';
    const stamp = new Date().toISOString().slice(0, 10);
    const decisionNote = `${action === 'accept' ? 'Accepted' : 'Rejected'} via email on ${stamp}.`;
    userState[id] = {
      ...current,
      status: newStatus,
      notes: current.notes ? `${current.notes}\n${decisionNote}` : decisionNote,
      emailDecision: { action, cycle, at: new Date().toISOString() },
    };
    await kv.set(SHARED_KEY, { ...shared, userState });

    return res.status(200).send(page(
      action === 'accept' ? 'Accepted' : 'Rejected',
      `<p style="font-size:14px;">${action === 'accept'
        ? 'Marked <b>In Progress</b>. You will get one reminder 14 days before the deadline.'
        : 'Marked <b>Skipped</b>. No more reminders will be sent for it.'}</p>`,
      action === 'accept' ? '#2a8f5e' : '#b03030'));
  } catch (err) {
    console.error('grant-decision error:', err);
    return res.status(500).send(page('Something went wrong', `<p style="font-size:14px;">${esc(err.message)}</p>`, '#b03030'));
  }
}
