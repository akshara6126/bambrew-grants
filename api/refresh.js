// Vercel cron: runs every Monday at 9am IST (3:30 UTC)
// Fetches Google News for grant-related keywords, saves to KV.
// No GitHub push / redeploy needed — frontend reads from /api/auto-grants.

import { kv } from '@vercel/kv';

const KEYWORDS = [
  'Bambrew sustainable packaging',
  'biopolymer packaging India',
  'PBAT compostable India',
  'PLA biodegradable India',
  '"BIRAC BioE3" 2026',
  '"BIRAC BIG" grant',
  '"DBT BIRAC" call 2026',
  '"NABARD" climate fund 2026',
  '"NITI Aayog" "Atal Innovation Mission" circular',
  '"Atal New India Challenge" startup',
  '"ELEVATE Karnataka" 2026',
  '"C-CAMP" sustainability grant',
  '"TDB" "India-Finland" 2026',
  '"Marico Innovation Foundation"',
  '"Horizon Europe" circular packaging',
  '"Innovate UK" SSPP plastic packaging',
  '"Bezos Earth Fund" biopolymer',
  '"Earthshot Prize" 2027',
  '"Green Climate Fund" India NABARD',
  '"ADB Ventures" climate India',
  'India plastic waste management rules 2026',
  'sustainable packaging India funding 2026',
  'compostable packaging startup India funding',
  '"EPR" "plastic" India 2026',
  '"single-use plastic" ban India 2026',
  '"bamboo packaging" India',
  '"circular packaging" India brand',
  '"compostable bags" India launch',
  '"biodegradable packaging" India launch',
  '"plastic-free packaging" India',
  '"sustainable packaging" "Series A" OR "seed" India 2026',
  '"green bond" India startup 2026',
  '"climate tech" India funding 2026',
];

const GRANT_TOKENS = ['grant','scheme','fund ','funding','challenge','prize','call for proposals',
  'applications open','applications invited','award','innovation challenge','launches','announces',
  'non-dilutive','incubator','accelerator','cohort'];
const RELEVANCE_TOKENS = ['sustainab','compost','biodegrad','biopolymer','bioplastic','circular',
  'plastic','packaging','bio-econom','biomanufactur','climate','cleantech','green'];
const TRUSTED = ['economic times','business standard','mint','livemint','financial express',
  'businessline','moneycontrol','ndtv','bloomberg','reuters','times of india','india today',
  'inc42','yourstory','entrackr','vccircle','techcrunch','fortune india','business today',
  'down to earth','mongabay','eco-business','pib','press information bureau','pti','ani',
  'biospectrum','biovoice','pharmabiz','expresspharma','dbt.gov','birac.nic','dst.gov',
  'nabard.org','niti.gov','startupindia.gov','makeinindia.com','abi.org.in'];

function isGrant(title) {
  const t = title.toLowerCase();
  return GRANT_TOKENS.some(g => t.includes(g)) && RELEVANCE_TOKENS.some(r => t.includes(r));
}
function isTrusted(source) {
  if (!source) return false;
  const s = source.toLowerCase();
  return TRUSTED.some(t => s.includes(t));
}
function makeId(url) {
  let h = 0;
  for (let i = 0; i < url.length; i++) h = (Math.imul(31, h) + url.charCodeAt(i)) | 0;
  return 'auto-' + Math.abs(h).toString(36);
}
function parseRSS(xml) {
  const items = [];
  const re = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = re.exec(xml))) {
    const b = m[1];
    const get = tag => {
      const r = new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>|<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
      const x = r.exec(b);
      return x ? (x[1] || x[2] || '').trim() : '';
    };
    const decode = s => s.replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&#39;/g,"'").replace(/&quot;/g,'"');
    const title = decode(get('title')), link = get('link'), pubDate = get('pubDate'), source = decode(get('source'));
    if (title && link) items.push({ title, link, pubDate, source });
  }
  return items;
}
async function fetchKeyword(kw) {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(kw)}&hl=en-IN&gl=IN&ceid=IN:en`;
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(8000) });
    if (!r.ok) return [];
    return parseRSS(await r.text());
  } catch { return []; }
}

export default async function handler(req, res) {
  try {
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const results = [];
    for (let i = 0; i < KEYWORDS.length; i += 5) {
      const items = await Promise.all(KEYWORDS.slice(i, i + 5).map(fetchKeyword));
      results.push(...items.flat());
    }

    const seen = new Set();
    const unique = results.filter(x => { if (seen.has(x.link)) return false; seen.add(x.link); return true; });

    const filtered = unique.filter(x => {
      if (!isTrusted(x.source)) return false;
      if (x.pubDate && new Date(x.pubDate).getTime() < cutoff) return false;
      return isGrant(x.title);
    });

    filtered.sort((a, b) => new Date(b.pubDate || 0) - new Date(a.pubDate || 0));
    const today = new Date().toISOString().slice(0, 10);

    const grants = filtered.slice(0, 12).map(x => ({
      id: makeId(x.link),
      name: x.title,
      region: 'india',
      type: 'deadline',
      value: 'See source',
      domain: 'Auto-detected from news headline',
      eligibility: 'Visit source link to verify eligibility',
      url: x.link,
      notes: `Auto-discovered from news on ${x.pubDate ? new Date(x.pubDate).toISOString().slice(0,10) : today}`,
      discoveredOn: x.pubDate ? new Date(x.pubDate).toISOString().slice(0, 10) : today,
      autoDiscovered: true,
    }));

    await kv.set('auto-grants', { grants, updatedAt: today });

    return res.json({ ok: true, count: grants.length, date: today });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
