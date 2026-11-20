import { kv } from '@vercel/kv';

// Returns everything found automatically:
//   - real open calls from official portals (EU / BIRAC / Innovate UK), kept until their deadline
//   - news leads from the weekly Google News scan (headlines, no deadline)
export default async function handler(req, res) {
  try {
    const [news, discovered] = await Promise.all([kv.get('auto-grants'), kv.get('discovered-grants')]);
    const found = Object.values((discovered && discovered.items) || {})
      .sort((a, b) => String(a.deadline).localeCompare(String(b.deadline)));
    const leads = (news && news.grants) || [];
    const updatedAt = [news && news.updatedAt, discovered && discovered.updatedAt].filter(Boolean).sort().pop() || null;
    return res.json({
      grants: found.concat(leads),
      updatedAt,
      sources: (discovered && discovered.sources) || {},
      newsUpdatedAt: (news && news.updatedAt) || null,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
