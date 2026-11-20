// Vercel cron: runs every Monday at 9am IST (3:30 UTC)
// Fetches Google News for grant-related keywords, saves to KV.
// No GitHub push / redeploy needed — frontend reads from /api/auto-grants.
// KEYWORDS mirrors scripts/keywords.txt (the news-drawer pipeline's source list) —
// keep the two in sync; add new terms to keywords.txt and copy them here too.

import { kv } from '@vercel/kv';

const KEYWORD_TEMPLATES = [
  'Bambrew sustainable packaging',
  'biopolymer packaging India',
  'PBAT compostable India',
  'PLA biodegradable India',
  '"BIRAC BioE3" {YEAR}',
  '"BIRAC BIG" grant',
  '"DBT BIRAC" call {YEAR}',
  '"NABARD" climate fund {YEAR}',
  '"NABARD Green Impact Fund"',
  '"NITI Aayog" "Atal Innovation Mission" circular',
  '"Atal New India Challenge" startup',
  '"ELEVATE Karnataka" {YEAR}',
  '"ELEVATE NxT" Karnataka startup',
  '"C-CAMP" sustainability grant',
  '"TDB" "India-Finland" {YEAR}',
  '"Marico Innovation Foundation"',
  '"CBE JU" films coatings {YEAR}',
  '"EU LIFE Programme" circular economy {YEAR}',
  '"Horizon Europe" circular packaging',
  '"Innovate UK" SSPP plastic packaging',
  '"IKEA Foundation" India circular',
  '"Bezos Earth Fund" biopolymer',
  '"Earthshot Prize" {NEXT_YEAR}',
  '"Green Climate Fund" India NABARD',
  '"ADB Ventures" climate India',
  'India plastic waste management rules {YEAR}',
  'India circular economy grant {YEAR}',
  'sustainable packaging India funding {YEAR}',
  'compostable packaging startup India funding',
  '"sustainable packaging" India {YEAR}',
  '"compostable packaging" India',
  '"biodegradable packaging" India launch',
  '"plastic-free packaging" India',
  '"circular packaging" India brand',
  '"EPR" "plastic" India {YEAR}',
  '"single-use plastic" ban India {YEAR}',
  '"compostable bags" India launch',
  '"bamboo packaging" India',
  '"commits to" "plastic-free" packaging',
  '"pledges" "sustainable packaging"',
  '"100% sustainable packaging"',
  '"plastic-free pledge" brand',
  '"transition to" "compostable packaging"',
  '"phase out plastic" packaging brand',
  '"net zero" packaging India',
  '"ESG" packaging India brand',
  '"recycled content" packaging India brand',
  'FMCG "sustainable packaging" India',
  'D2C brand "plastic-free" India',
  '"compostable films" India',
  '"compostable film" launch',
  '"bio films" packaging India',
  '"compostable wrappers"',
  '"compostable mailers" India',
  '"biodegradable courier bags" India',
  '"compostable cutlery" India',
  '"biodegradable mulch film"',
  '"compostable food packaging" India',
  '"compostable trays" India',
  '"sustainability grant" India {YEAR}',
  '"sustainability funding" startup India',
  '"climate tech funding" India {YEAR}',
  '"cleantech grants" India',
  '"green tech grants" India',
  '"ESG funding" startup India',
  '"impact investment" circular economy India',
  '"carbon credit" startup grant India',
  '"climate fund" India {YEAR} startup',
  '"green finance" India startup {YEAR}',
  '"environmental grants" India {YEAR}',
  '"Extended Producer Responsibility" India',
  '"EPR" packaging India {YEAR}',
  '"single-use plastic alternatives" India',
  '"plastic ban" India {YEAR} alternatives',
  '"ASEAN" circular economy grant',
  '"UNDP India" sustainability grant',
  '"UNEP India" plastic grant',
  '"World Bank India" sustainable packaging',
  '"compostable garbage bags" India',
  '"compostable bin liners" India',
  '"home compostable bags" launch',
  '"biodegradable trash bags" India',
  '"compostable waste bags" India',
  '"sustainability initiative" packaging India',
  '"launches" "sustainable packaging" India',
  '"launches" "compostable" India',
  '"introduces" "compostable packaging" India',
  '"rolls out" "sustainable packaging"',
  '"adopts" "compostable packaging"',
  '"switches to" "sustainable packaging" India',
  '"sustainability commitment" brand India',
  '"partners with" "sustainable packaging" India',
  '"collaborates" "sustainable packaging" India',
  'brand "goes plastic-free" India',
  'company "eco-friendly packaging" India launch',
  '"sustainable packaging" "Series A" OR "seed" India {YEAR}',
  '"green bond" India startup {YEAR}',
  '"climate tech" India funding {YEAR}'
];

// {YEAR}/{NEXT_YEAR} are filled in at run time so searches never go stale.
function keywordsForNow() {
  const y = new Date().getUTCFullYear();
  return KEYWORD_TEMPLATES.map(k => k.replaceAll('{YEAR}', String(y)).replaceAll('{NEXT_YEAR}', String(y + 1)));
}

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
  'nabard.org','niti.gov','startupindia.gov','makeinindia.com','abi.org.in',
  'et government','etgovernment','packaging gateway','packaging insights','packaging europe',
  'plastics news','bioplastics','the hindu','hindustan times','indian express','deccan herald',
  'eco-business','edie','greenbiz','development bank','world bank','undp','unep','unido',
  'european commission','eu-startups','innovate uk','ukri','devex','the guardian','carbon brief'];

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
    const KEYWORDS = keywordsForNow();
    for (let i = 0; i < KEYWORDS.length; i += 10) {
      const items = await Promise.all(KEYWORDS.slice(i, i + 10).map(fetchKeyword));
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
      category: /award|prize/i.test(x.title) ? 'award' : 'grant',
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
