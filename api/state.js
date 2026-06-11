// /api/state — single shared state for the whole Bambrew team.
// GET   → returns the current shared state (JSON)
// POST  → overwrites the shared state with the new payload
//
// State shape (matches the existing structures in index.html):
//   {
//     userState:        { [grantId]: { status, notes, lastChecked } },
//     userGrants:       [ { id, name, ... } ],
//     dismissedAutoIds: [ "auto-12345", ... ]
//   }
//
// Conflict policy: last write wins. Realistic for a 3–4 person team.

import { kv } from '@vercel/kv';

const SHARED_KEY = 'bambrew-shared-state';

export default async function handler(req, res) {
  try {
    if (req.method === 'GET') {
      const data = await kv.get(SHARED_KEY);
      return res.status(200).json(data || {
        userState: {},
        userGrants: [],
        dismissedAutoIds: [],
      });
    }

    if (req.method === 'POST') {
      const { state } = req.body || {};
      if (!state || typeof state !== 'object') {
        return res.status(400).json({ error: 'Missing state body' });
      }
      // Cap size to ~500KB to avoid abuse
      if (JSON.stringify(state).length > 500_000) {
        return res.status(413).json({ error: 'State payload too large' });
      }
      await kv.set(SHARED_KEY, state);
      return res.status(200).json({ ok: true });
    }

    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('state api error', err);
    return res.status(500).json({ error: 'Internal error: ' + err.message });
  }
}
