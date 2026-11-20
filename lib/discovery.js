// Grant finder: pulls REAL open calls (with opening + closing dates) from official
// funding portals, keeps the ones relevant to Bambrew, and merges them into a
// persistent list. Runs daily from /api/cron/grant-reminders before reminders are
// worked out, so a newly found call gets its "now open" email the same morning.
//
// Sources:
//   eu    EU Funding & Tenders portal (Horizon Europe, CBE JU, LIFE, ...) public search API
//   birac BIRAC "Current Calls for Proposal" page (birac.nic.in/cfp.php)
//   ifs   Innovate UK Funding Service competition search
// Each source is independent: one failing never blocks the others.

// A call is relevant if its title (or summary) mentions one of these.
const RELEVANT = [
  'packag', 'plastic', 'bio-based', 'biobased', 'bioplastic', 'biopolymer', 'polymer',
  'compost', 'biodegrad', 'single-use', 'single use', 'film', 'coating', 'bamboo',
  'lignocellul', 'cellulos', 'biorefin', 'bio-econom', 'bioeconom', 'biomanufactur',
  'circular bio', 'materials', 'waste', 'sustainable manufactur',
];
// BIRAC funds lots of health work; skip calls that are clearly medical.
const MEDICAL = ['diagnos', 'vaccin', 'drug', 'clinical', 'amr', 'antimicrob', 'medical', 'patient',
  'health', ' tb', 'tuberc', 'cancer', 'therap', 'disease', 'hospital', 'patent', 'fellow'];

const has = (text, words) => { const t = ` ${String(text || '').toLowerCase()} `; return words.some(w => t.includes(w)); };
const category = name => (/\b(award|prize)\b/i.test(name) ? 'award' : 'grant');
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const pad = n => String(n).padStart(2, '0');

// "31-Oct-2026", "01st October 2026", "28 January 2027" → "2026-10-31"
export function parseDate(s) {
  const m = String(s || '').match(/(\d{1,2})(?:st|nd|rd|th)?[\s-]+([A-Za-z]{3,})[\s-]+(\d{4})/);
  if (!m) return null;
  const mon = MONTHS[m[2].slice(0, 3).toLowerCase()];
  return mon ? `${m[3]}-${pad(mon)}-${pad(+m[1])}` : null;
}
const decode = s => String(s || '')
  .replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;|&rsquo;|&#8217;/g, "'").replace(/&nbsp;/g, ' ')
  .replace(/\s+/g, ' ').trim();

async function get(url, opts = {}) {
  const r = await fetch(url, {
    ...opts,
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BambrewGrantsBot/1.0)', ...(opts.headers || {}) },
    signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status} from ${new URL(url).host}`);
  return r;
}

// ── EU Funding & Tenders ─────────────────────────────────────────────────────
const EU_QUERIES = ['packaging', 'bio-based', 'plastic', 'biodegradable', 'compostable', 'bioplastic', 'circular bio-based'];
const EU_OPEN = '31094502', EU_FORTHCOMING = '31094501';

async function sourceEU(today) {
  const out = new Map();
  for (const q of EU_QUERIES) {
    const form = new FormData();
    form.append('query', new Blob([JSON.stringify({ bool: { must: [
      { terms: { type: ['1', '2', '8'] } },
      { terms: { status: [EU_OPEN, EU_FORTHCOMING] } },
    ] } })], { type: 'application/json' }));
    form.append('languages', new Blob(['["en"]'], { type: 'application/json' }));
    const url = `https://api.tech.ec.europa.eu/search-api/prod/rest/search?apiKey=SEDIA&text=${encodeURIComponent(q)}&pageSize=50&pageNumber=1`;
    const data = await (await get(url, { method: 'POST', body: form })).json();
    if (!Array.isArray(data.results)) throw new Error('EU search API response format changed');
    for (const r of data.results || []) {
      if (r.language && r.language !== 'en') continue;
      const m = r.metadata || {}, f = k => (m[k] || [])[0] || '';
      const ident = f('identifier'), title = decode(f('title'));
      const deadline = f('deadlineDate').slice(0, 10), launch = f('startDate').slice(0, 10) || null;
      if (!ident || !title || !deadline || deadline < today || out.has(ident)) continue;
      if (!has(`${title} ${r.summary || ''}`, RELEVANT)) continue;
      out.set(ident, {
        id: `eu-${ident.toLowerCase()}`, name: `${title} (${ident})`, region: 'eu', type: 'deadline',
        category: category(title), launch, deadline,
        value: 'See call page',
        domain: f('frameworkProgramme') ? `EU programme ${f('frameworkProgramme')}` : 'EU funding call',
        eligibility: 'EU call: usually needs an EU-based consortium; Indian companies can join as partners (check call conditions)',
        url: `https://ec.europa.eu/info/funding-tenders/opportunities/portal/screen/opportunities/topic-details/${ident}`,
        notes: `Found automatically on the EU Funding & Tenders portal. Status: ${f('status') === EU_OPEN ? 'open' : 'forthcoming'}.`,
      });
    }
  }
  return [...out.values()];
}

// ── BIRAC current calls ──────────────────────────────────────────────────────
async function sourceBIRAC(today) {
  const html = await (await get('https://birac.nic.in/cfp.php')).text();
  const out = [];
  const re = /<a href="(cfp_view\.php\?id=(\d+)[^"]*)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?call-open">([\s\S]*?)<\/small>[\s\S]*?call-closed">([\s\S]*?)<\/small>/g;
  let m, rows = 0;
  while ((m = re.exec(html))) {
    rows++;
    const title = decode(m[3]).replace(/\.\.\.$/, '').trim();
    const launch = parseDate(m[4]), deadline = parseDate(m[5]);
    if (!deadline || deadline < today) continue;
    if (has(title, MEDICAL)) continue;
    out.push({
      id: `birac-${m[2]}`, name: title, region: 'india', type: 'deadline', category: category(title),
      launch, deadline, value: 'See call page', domain: 'BIRAC (DBT) call for proposals',
      eligibility: 'Indian companies / startups; see call document',
      url: `https://birac.nic.in/${decode(m[1])}`,
      notes: 'Found automatically on the BIRAC Call for Proposals page.',
    });
  }
  if (!rows) throw new Error('BIRAC page layout changed: no calls could be read');
  return out;
}

// ── Innovate UK Funding Service ──────────────────────────────────────────────
async function sourceIFS(today) {
  // Results are paged 10 at a time; read up to 5 pages, stop when there is no "Next".
  let html = '';
  for (let page = 0; page < 5; page++) {
    const p = await (await get(`https://apply-for-innovation-funding.service.gov.uk/competition/search?page=${page}`)).text();
    html += p;
    if (!p.includes('rel="next"')) break;
  }
  const out = [], seen = new Set();
  // one block per competition (descriptions can contain their own <li> lists)
  const blocks = html.split('<h2 class="govuk-heading-m').slice(1);
  if (!blocks.some(b => b.includes('/competition/'))) throw new Error('Innovate UK page layout changed: no competitions could be read');
  for (const b of blocks) {
    const link = b.match(/href="(\/competition\/(\d+)\/overview\/[^"]+)">([\s\S]*?)<\/a>/);
    if (!link || seen.has(link[2])) continue;
    seen.add(link[2]);
    const title = decode(link[3]);
    const desc = decode((b.match(/wysiwyg-styles[^>]*>([\s\S]*?)<\/div>/) || [])[1]);
    const launch = parseDate((b.match(/Open(?:ed|s):<\/dt>\s*<dd[^>]*>([^<]+)/) || [])[1]);
    const deadline = parseDate((b.match(/Closes:<\/dt>\s*<dd[^>]*>([^<]+)/) || [])[1]);
    if (!deadline || deadline < today) continue;
    if (!has(`${title} ${desc}`, RELEVANT)) continue;
    out.push({
      id: `ifs-${link[2]}`, name: title, region: 'uk', type: 'deadline', category: category(title),
      launch, deadline, value: desc.match(/(£[\d.,]+\s*(?:million|m|k)?)/i)?.[1] || 'See competition page',
      domain: 'Innovate UK competition',
      eligibility: 'Usually needs a UK-registered business (lead or partner); check competition scope',
      url: `https://apply-for-innovation-funding.service.gov.uk${link[1]}`,
      notes: `Found automatically on the Innovate UK Funding Service. ${desc.slice(0, 200)}`,
    });
  }
  return out;
}

export const SOURCES = { eu: sourceEU, birac: sourceBIRAC, ifs: sourceIFS };

// Merge freshly found calls into the stored list. Keeps the first-seen date,
// refreshes details, drops calls whose deadline has passed.
export function mergeDiscovered(stored, results, today) {
  const items = { ...(stored.items || {}) };
  const sources = { ...(stored.sources || {}) };
  for (const [name, r] of Object.entries(results)) {
    const prev = sources[name] || {};
    if (r.error) {
      sources[name] = { ...prev, lastError: r.error, lastErrorOn: today, failingSince: prev.failingSince || today };
      continue;
    }
    sources[name] = { lastOk: today, lastCount: r.items.length };
    for (const it of r.items) {
      items[it.id] = {
        ...it, autoDiscovered: true, verifiedSource: true, source: name,
        discoveredOn: (items[it.id] && items[it.id].discoveredOn) || today,
      };
    }
  }
  for (const [id, it] of Object.entries(items)) if (it.deadline < today) delete items[id];
  return { items, sources, updatedAt: today };
}

export async function runDiscovery(stored, today) {
  const names = Object.keys(SOURCES);
  const settled = await Promise.allSettled(names.map(n => SOURCES[n](today)));
  const results = {};
  names.forEach((n, i) => {
    results[n] = settled[i].status === 'fulfilled'
      ? { items: settled[i].value }
      : { error: String(settled[i].reason && settled[i].reason.message || settled[i].reason) };
  });
  return mergeDiscovered(stored || {}, results, today);
}
