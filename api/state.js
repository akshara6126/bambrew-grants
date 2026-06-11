// /api/state — per-user state store backed by Vercel KV.
// GET  ?user=alice            → returns the user's saved state (JSON)
// POST { user, state }         → saves the user's state
//
// State shape (matches the existing localStorage data structures in index.html):
//   {
//     userState:        { [grantId]: { status, notes, lastChecked } },
//     userGrants:       [ { id, name, ... } ],
//     dismissedAutoIds: [ "auto-12345", ... ]
//   }

import { kv } from '@vercel/kv';

function safeUserKey(user) {
  // Normalise: lowercase + trim + strip anything that isn't a letter / digit / dash / underscore.
  const clean = String(user || '').toLowerCase().trim().replace(/[^a-z0-9_-]/g, '');
  if (!clean || clean.length > 40) return null;
  return `bambrew-state:${clean}`;
}

export default async function handler(req, res) {
  try {
    if (req.method === 'GET') {
      const user = req.query.user;
      const key = safeUserKey(user);
      if (!key) return res.status(400).json({ error: 'Invalid or missing user param' });
      const data = await kv.get(key);
      return res.status(200).json(data || {
        userState: {},
        userGrants: [],
        dismissedAutoIds: [],
      });
    }

    if (req.method === 'POST') {
      const { user, state } = req.body || {};
      const key = safeUserKey(user);
      if (!key)  return res.status(400).json({ error: 'Invalid or missing user' });
      if (!state || typeof state !== 'object') {
        return res.status(400).json({ error: 'Missing state body' });
      }
      // Cap size to ~500KB to avoid abuse
      if (JSON.stringify(state).length > 500_000) {
        return res.status(413).json({ error: 'State payload too large' });
      }
      await kv.set(key, state);
      return res.status(200).json({ ok: true });
    }

    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('state api error', err);
    return res.status(500).json({ error: 'Internal error: ' + err.message });
  }
}
