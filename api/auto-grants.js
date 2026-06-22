import { kv } from '@vercel/kv';

export default async function handler(req, res) {
  try {
    const data = await kv.get('auto-grants');
    return res.json(data || { grants: [], updatedAt: null });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
