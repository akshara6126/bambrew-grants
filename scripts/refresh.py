#!/usr/bin/env python3
"""
Bambrew Grants Dashboard — News Refresher
==========================================
Fetches the latest Google News results for Bambrew-relevant keywords and
rewrites the NEWS array in ~/bambrew-grants-dashboard.html in place.

- Reads keywords from keywords.txt (one per line)
- Uses Google News RSS — no API key required
- Stdlib only (no pip install)
- Writes a backup of the dashboard before every change
- Logs every run to refresh.log

Run manually:    python3 refresh.py
Scheduled:       installed via install.sh (launchd, every Monday 9am)
"""

from urllib.parse import urlencode
from urllib.request import urlopen, Request
from urllib.error import URLError
from email.utils import parsedate_to_datetime
import xml.etree.ElementTree as ET
import datetime
import html
import logging
import pathlib
import ssl
import sys

# macOS Python (Homebrew + python.org installers) often lacks a configured CA
# bundle, which makes urlopen() fail with CERTIFICATE_VERIFY_FAILED on HTTPS.
# We're reading public RSS only (no creds sent), so we try verified first and
# transparently fall back to an unverified context on cert errors.
_VERIFIED_CTX = ssl.create_default_context()
_UNVERIFIED_CTX = ssl._create_unverified_context()

# ---------------------------------------------------------------
# Config
# ---------------------------------------------------------------
HERE          = pathlib.Path(__file__).parent.resolve()
DASHBOARD     = (HERE.parent / "index.html").resolve()
KEYWORDS_FILE = HERE / "keywords.txt"
LOG_FILE      = HERE / "refresh.log"

MAX_ITEMS_TOTAL   = 12   # cards shown in the What's New drawer
PER_KEYWORD_MAX   = 2    # cap per keyword (prevents one keyword dominating)
DAYS_BACK         = 30   # only keep stories from the last N days
REQUEST_TIMEOUT_S = 15

# A news item is flagged as a likely new grant if its title contains any of
# these tokens AND any of the sustainability/biopolymer relevance keywords below.
GRANT_TOKENS = [
    "grant", "scheme", "fund ", "funding", "challenge", "prize",
    "call for proposals", "applications open", "applications invited",
    "award", "innovation challenge", "launches", "announces",
    "non-dilutive", "incubator", "accelerator", "cohort",
]
RELEVANCE_TOKENS = [
    "sustainab", "compost", "biodegrad", "biopolymer", "bioplastic",
    "circular", "plastic", "packaging", "bio-econom", "biomanufactur",
    "climate", "cleantech", "green",
]

def is_likely_grant(title):
    t = title.lower()
    return any(g in t for g in GRANT_TOKENS) and any(r in t for r in RELEVANCE_TOKENS)

# ---------------------------------------------------------------
# Verified-sources whitelist
# ---------------------------------------------------------------
# Google News aggregates from thousands of sites including SEO blogs and
# unverified republishers. We only keep items whose `source` field matches a
# known editorial publisher OR whose URL is on a .gov.in / .nic.in domain.
# Match is case-insensitive substring against the source name.
TRUSTED_SOURCE_PATTERNS = [
    # --- Indian business / financial press ---
    "economic times", "livemint", "mint",
    "business standard", "financial express",
    "businessline", "the hindu businessline", "hindu businessline",
    "moneycontrol", "bq prime", "bloombergquint",
    # --- Indian startup / VC press ---
    "inc42", "yourstory", "your story", "entrackr", "vccircle", "the ken",
    # --- Indian general (national) ---
    "the hindu", "hindustan times", "indian express", "times of india", "tribune india",
    # --- Indian government / official ---
    "pib", "press information bureau", "ministry of",
    # --- Global wire / financial ---
    "reuters", "bloomberg", "associated press", "ap news",
    "financial times", "wall street journal", "wsj", "the guardian",
    # --- Climate / sustainability press ---
    "mongabay", "down to earth", "downtoearth", "carbon brief", "climate home",
    # --- Industry trade press (relevant to Bambrew) ---
    "biospectrum", "pharmabiz", "packaging south asia",
    # --- Devex (international grants) ---
    "devex",
]

TRUSTED_URL_DOMAINS = [
    ".gov.in/", ".nic.in/", "pib.gov.in",
    # Already-good news domains that sometimes ship without a clean source name:
    "reuters.com", "bloomberg.com", "ft.com", "economictimes.indiatimes.com",
    "livemint.com", "business-standard.com", "thehindu.com",
    "inc42.com", "yourstory.com", "moneycontrol.com",
]

def is_trusted_source(source, url=""):
    """True if the item comes from a whitelisted publisher OR a govt domain."""
    s = (source or "").lower().strip()
    u = (url or "").lower().strip()
    # 1. Govt / known-good URL domain (high signal, low collision)
    if any(d in u for d in TRUSTED_URL_DOMAINS):
        return True
    # 2. Reject obvious junk (empty source, generic placeholder)
    if not s or s in ("google news", "news", "press release"):
        return False
    # 3. Source-name whitelist
    return any(p in s for p in TRUSTED_SOURCE_PATTERNS)

# Best-effort: map a keyword fragment to a grantId in the dashboard
# so the auto-fetched card gets a clickable "Open grant" button.
GRANT_MAP = {
    "BioE3":                 "bioe3",
    "BIRAC BIG":             "birac-big",
    "DBT BIRAC":             "bioe3",
    "CBE JU":                "cbe-ju",
    "Horizon Europe circular": "cbe-ju",
    "EU LIFE":               "life",
    "ELEVATE Karnataka":     "elevate",
    "ELEVATE NxT":           "elevate-nxt",
    "NABARD climate":        "nabard-ngif",
    "NABARD Green Impact":   "nabard-ngif",
    "Green Climate Fund":    "gcf",
    "C-CAMP":                "ccamp-coe",
    "IKEA Foundation":       "ikea-ceic",
    "Bezos Earth Fund":      "bezos",
    "Innovate UK SSPP":      "sspp",
    "Earthshot Prize":       "earthshot",
    "NITI Aayog":            "anic",
    "Atal New India":        "anic",
    "Marico Innovation":     "marico",
    "TDB India-Finland":     "tdb-finland",
    "ADB Ventures":          "adb",
}

# ---------------------------------------------------------------
# Logging
# ---------------------------------------------------------------
logging.basicConfig(
    filename=str(LOG_FILE),
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
)
log = logging.getLogger("refresher")

# ---------------------------------------------------------------
# Fetch + parse
# ---------------------------------------------------------------
def fetch_keyword(kw):
    url = "https://news.google.com/rss/search?" + urlencode({
        "q": kw, "hl": "en-IN", "gl": "IN", "ceid": "IN:en"
    })
    req = Request(url, headers={"User-Agent": "Mozilla/5.0 BambrewNewsRefresher"})
    data = None
    for ctx in (_VERIFIED_CTX, _UNVERIFIED_CTX):
        try:
            data = urlopen(req, timeout=REQUEST_TIMEOUT_S, context=ctx).read()
            break
        except URLError as e:
            if "CERTIFICATE_VERIFY_FAILED" in str(e):
                continue
            log.warning("Fetch failed for %r: %s", kw, e)
            return []
        except Exception as e:
            log.warning("Fetch failed for %r: %s", kw, e)
            return []
    if data is None:
        log.warning("Fetch failed for %r: SSL trust path exhausted", kw)
        return []
    try:
        root = ET.fromstring(data)
    except ET.ParseError as e:
        log.warning("Parse failed for %r: %s", kw, e)
        return []

    items = []
    now_utc = datetime.datetime.now(datetime.timezone.utc)
    for item in root.findall(".//item"):
        title_raw = (item.findtext("title") or "").strip()
        link      = (item.findtext("link") or "").strip()
        pub_raw   = (item.findtext("pubDate") or "").strip()
        source_el = item.find("source")
        source    = source_el.text.strip() if (source_el is not None and source_el.text) else ""

        # Google News titles often look like "Headline - Source Name"
        if " - " in title_raw and not source:
            title, trailing = title_raw.rsplit(" - ", 1)
            source = trailing
        else:
            title = title_raw

        title = html.unescape(title).strip()
        source = html.unescape(source).strip() or "Google News"

        try:
            dt = parsedate_to_datetime(pub_raw) if pub_raw else None
        except Exception:
            dt = None
        if not dt:
            continue
        if (now_utc - dt).days > DAYS_BACK:
            continue

        items.append({
            "date":   dt.strftime("%Y-%m-%d"),
            "title":  title,
            "url":    link,
            "source": source,
            "matched_kw": kw,
            "_dt":    dt,
        })
    return items

def _norm_title(t):
    # strip the trailing " - Source Name" if present (Google News appends it)
    base = t.rsplit(" - ", 1)[0] if " - " in t else t
    return " ".join(base.lower().split())

def dedupe(items):
    """Dedupe by URL AND by normalised title. Google News rewrites URLs per
    search, so the same story matched by two keywords ends up with two
    different URLs but the same title."""
    seen_urls, seen_titles, out = set(), set(), []
    for it in items:
        norm_title = _norm_title(it["title"])
        if it["url"] in seen_urls or norm_title in seen_titles:
            continue
        seen_urls.add(it["url"])
        seen_titles.add(norm_title)
        out.append(it)
    return out

def grant_id_for(matched_kw, title):
    text = (matched_kw + " " + title).lower()
    for kw_frag, gid in GRANT_MAP.items():
        if kw_frag.lower() in text:
            return gid
    return None

# ---------------------------------------------------------------
# Emit JS
# ---------------------------------------------------------------
def js_str(s):
    if s is None:
        return ""
    return (
        s.replace("\\", "\\\\")
         .replace("'", "\\'")
         .replace("\n", " ")
         .replace("\r", " ")
         .strip()
    )

def guess_region(title, source):
    """Best-effort region guess from text."""
    text = (title + " " + source).lower()
    if any(k in text for k in ["india", "indian", "bharat", "delhi", "mumbai", "bengaluru", "karnataka"]): return "india"
    if any(k in text for k in ["eu ", " eu", "horizon europe", "european", "brussels", "cbe ju", "life programme"]): return "eu"
    if any(k in text for k in ["uk ", "united kingdom", "innovate uk", "british"]): return "uk"
    if any(k in text for k in ["world bank", "ifc", "adb", "undp", "unep", "gef", "gcf"]): return "multilateral"
    return "global"

def title_to_clean_name(title):
    # strip trailing " - Source" suffix
    base = title.rsplit(" - ", 1)[0] if " - " in title else title
    # truncate very long titles
    if len(base) > 110: base = base[:107] + "..."
    return base

def to_news_js(items):
    now_iso = datetime.datetime.now().strftime("%Y-%m-%d %H:%M")
    today_iso = datetime.datetime.now().strftime("%Y-%m-%d")

    lines = [
        f"const LAST_REFRESH = '{now_iso}';",
        "const NEWS = ["
    ]
    for it in items[:MAX_ITEMS_TOTAL]:
        gid = grant_id_for(it.get("matched_kw", ""), it["title"])
        sig = "Auto-fetched · Keyword: " + it.get("matched_kw", "")
        is_grant = "true" if is_likely_grant(it["title"]) else "false"
        lines.append(
            "  { date: '"        + js_str(it["date"])   + "', "
            "title: '"           + js_str(it["title"])  + "', "
            "grantId: "          + (("'" + gid + "'") if gid else "null") + ", "
            "significance: '"    + js_str(sig)          + "', "
            "source: '"          + js_str(it["source"]) + "', "
            "url: '"             + js_str(it["url"])    + "', "
            "isLikelyGrant: "    + is_grant             + " },"
        )
    lines.append("];")

    # AUTO_DISCOVERED_GRANTS: items flagged as likely grants get appended to
    # GRANTS via allGrants() in the dashboard so they appear automatically.
    lines.append("// __AUTO_GRANTS_START__")
    lines.append("const AUTO_DISCOVERED_GRANTS = [")
    auto_count = 0
    for it in items:
        if not is_likely_grant(it["title"]):
            continue
        # skip if already linked to a known grant
        if grant_id_for(it.get("matched_kw", ""), it["title"]):
            continue
        slug = "auto-" + str(abs(hash(it["url"])) % (10**8))
        name = title_to_clean_name(it["title"])
        region = guess_region(it["title"], it.get("source", ""))
        lines.append(
            "  { id: '"       + slug                + "', "
            "name: '"         + js_str(name)        + "', "
            "region: '"       + region              + "', "
            "type: 'deadline', "
            "value: 'See source', "
            "domain: 'Auto-detected from news headline', "
            "eligibility: 'Visit source link to verify eligibility', "
            "url: '"          + js_str(it["url"])   + "', "
            "notes: 'Auto-discovered from news on " + today_iso + " · keyword: " + js_str(it.get("matched_kw", "")) + "', "
            "discoveredOn: '" + today_iso           + "', "
            "autoDiscovered: true },"
        )
        auto_count += 1
        if auto_count >= 8:   # cap auto-discovered per run
            break
    lines.append("];")
    lines.append("// __AUTO_GRANTS_END__")
    return "\n".join(lines)

# ---------------------------------------------------------------
# Surgical rewrite of the dashboard
# ---------------------------------------------------------------
def update_dashboard(news_js):
    text = DASHBOARD.read_text(encoding="utf-8")
    start_marker = "// __NEWS_START__"
    end_marker   = "// __NEWS_END__"
    if start_marker not in text or end_marker not in text:
        log.error("Sentinels missing in dashboard HTML — aborting")
        return False
    start = text.index(start_marker) + len(start_marker)
    end   = text.index(end_marker)
    new_text = text[:start] + "\n" + news_js + "\n" + text[end:]

    backup = DASHBOARD.with_suffix(".html.bak")
    backup.write_text(text, encoding="utf-8")
    DASHBOARD.write_text(new_text, encoding="utf-8")
    log.info("Dashboard rewritten · backup at %s", backup)
    return True

# ---------------------------------------------------------------
# Main
# ---------------------------------------------------------------
def main():
    log.info("=== Refresh start ===")
    if not DASHBOARD.exists():
        log.error("Dashboard not found at %s — aborting", DASHBOARD)
        print("ERR · Dashboard not found at", DASHBOARD)
        sys.exit(1)
    if not KEYWORDS_FILE.exists():
        log.error("keywords.txt missing — aborting")
        print("ERR · keywords.txt missing")
        sys.exit(1)

    keywords = [
        line.strip()
        for line in KEYWORDS_FILE.read_text(encoding="utf-8").splitlines()
        if line.strip() and not line.strip().startswith("#")
    ]
    log.info("Loaded %d keywords", len(keywords))

    all_items = []
    for kw in keywords:
        items = fetch_keyword(kw)
        items = items[:PER_KEYWORD_MAX]
        log.info("  %r -> %d items", kw, len(items))
        all_items.extend(items)

    all_items = dedupe(all_items)
    before_trust = len(all_items)
    rejected = [it for it in all_items if not is_trusted_source(it["source"], it["url"])]
    all_items = [it for it in all_items if is_trusted_source(it["source"], it["url"])]
    log.info("Trusted-source filter: kept %d of %d items (dropped %d untrusted)",
             len(all_items), before_trust, len(rejected))
    for r in rejected[:10]:
        log.info("  dropped (untrusted source=%r): %s", r["source"], r["title"][:100])
    all_items.sort(
        key=lambda x: x["_dt"] or datetime.datetime.min.replace(tzinfo=datetime.timezone.utc),
        reverse=True,
    )
    kept = min(len(all_items), MAX_ITEMS_TOTAL)
    log.info("Total after dedupe + trust filter: %d; keeping top %d", len(all_items), kept)

    if not all_items:
        log.warning("Zero items fetched — leaving dashboard untouched")
        print("WARN · zero items fetched; dashboard unchanged")
        sys.exit(0)

    if update_dashboard(to_news_js(all_items)):
        print("OK · {} items written to NEWS array".format(kept))
        log.info("=== Refresh done (OK) ===\n")
    else:
        print("ERR · dashboard rewrite failed; see refresh.log")
        log.error("=== Refresh done (FAIL) ===\n")
        sys.exit(1)

def health_check():
    """Run a self-test — no writes, no network reach to the dashboard.
    Confirms: dashboard exists, sentinels present, keywords file readable,
    log writable, Python+SSL working, Google News reachable for one query."""
    ok = True
    print("Bambrew news refresher · health check")
    print("-" * 50)

    if DASHBOARD.exists():
        print(f"✓ dashboard found at {DASHBOARD}")
        text = DASHBOARD.read_text(encoding="utf-8")
        if "// __NEWS_START__" in text and "// __NEWS_END__" in text:
            print("✓ sentinels (__NEWS_START__ / __NEWS_END__) found in dashboard")
        else:
            print("✗ sentinels MISSING in dashboard — script can't write to it")
            ok = False
    else:
        print(f"✗ dashboard NOT found at {DASHBOARD}")
        ok = False

    if KEYWORDS_FILE.exists():
        kws = [l for l in KEYWORDS_FILE.read_text(encoding="utf-8").splitlines()
               if l.strip() and not l.strip().startswith("#")]
        print(f"✓ keywords.txt readable · {len(kws)} active keywords")
    else:
        print("✗ keywords.txt MISSING")
        ok = False

    try:
        LOG_FILE.touch(exist_ok=True)
        print(f"✓ log file writable: {LOG_FILE}")
    except Exception as e:
        print(f"✗ log file NOT writable: {e}")
        ok = False

    print("→ testing Google News fetch (1 generic query)…")
    test_items = fetch_keyword("India news")  # broad, virtually always returns results
    if test_items:
        print(f"✓ Google News reachable · {len(test_items)} test items returned")
    else:
        print("✗ Google News fetch returned 0 items — network or RSS broken?")
        ok = False

    plist_dest = pathlib.Path.home() / "Library/LaunchAgents/com.bambrew.newsrefresher.plist"
    if plist_dest.exists():
        print(f"✓ launchd schedule installed at {plist_dest}")
    else:
        print(f"⚠ launchd schedule not installed (run: bash install.sh)")

    print("-" * 50)
    print("RESULT:", "ALL CHECKS PASSED ✓" if ok else "ISSUES FOUND ✗ — see lines above")
    return 0 if ok else 1

if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] in ("--health-check", "--test", "-t"):
        sys.exit(health_check())
    main()
