# Bambrew Grants Dashboard

Live grants tracker + auto-refreshing news drawer for the Bambrew Founder's
Office. Hosted on Vercel, refreshed twice a week by GitHub Actions.

**Live URL:** _to be filled in after first deploy_

---

## What's where

| File / folder | Purpose |
|---|---|
| `index.html` | The dashboard — open this in the browser. Auto-rewritten by the refresher. |
| `scripts/refresh.py` | Python script that fetches news from Google News, rewrites the NEWS array in `index.html`. Stdlib only — no pip install needed. |
| `scripts/keywords.txt` | What to track. One keyword per line, `#` for comments. Edit freely. |
| `.github/workflows/refresh-news.yml` | GitHub Action — runs the refresher every Mon + Thu at 09:00 IST. |
| `vercel.json` | Vercel config — tells Vercel this is a static site. |

---

## How auto-refresh works

```
Mon 09:00 IST  →  GitHub Action wakes up
                  → Runs scripts/refresh.py
                  → Script fetches Google News for ~50 keywords
                  → Rewrites NEWS array in index.html
                  → Commits the new index.html to the repo
                  → Vercel detects the commit and auto-deploys (~30 sec)
                  → Live URL serves fresh data
```

Same for Thursdays. **No human action required.**

---

## Editing the dashboard (no developer / no Claude / no terminal needed)

All edits happen in GitHub's web editor:

1. Go to the repo on github.com
2. Click the file you want to edit (e.g. `index.html` or `scripts/keywords.txt`)
3. Click the pencil icon (✏️) top-right
4. Edit in the browser
5. Scroll down → "Commit changes" → done
6. Vercel auto-redeploys in ~30 seconds

For the common edit patterns, see `OWNERS-MANUAL.md` in the original local setup at `~/bambrew-news-refresher/`.

---

## Manual run

In the GitHub repo → **Actions** tab → **Refresh Bambrew Grants News** → **Run workflow**. Refreshes immediately.

---

## Local development (optional)

The repo also runs locally:

```bash
git clone <your-repo-url>
cd bambrew-vercel
python3 scripts/refresh.py
open index.html
```

---

## License

Internal use only. Bambrew Founder's Office.
