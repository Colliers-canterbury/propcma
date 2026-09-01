# Operations Manual — files to add to propcma-main

This zip mirrors the folder structure of your `propcma-main` repo. Extract
it and copy each folder over the matching one in your local repo (same
paths — `api/`, `public/`, `scripts/`), then commit and push as usual.

## New files (just drop these in)
- `api/manual/index.js`
- `api/manual/content.js`
- `api/manual/roster-data.js`
- `public/operations-manual.html`
- `public/css/operations-manual.css`
- `public/js/operations-manual.js`
- `scripts/build-manual-roster.py`

## Files that REPLACE existing ones — check before overwriting
These two already exist in your repo and were edited, not created from
scratch. If you've changed either of them since 1 September 2026, don't
blindly overwrite — diff first and merge the changes in by hand:

- `public/js/accounts.js` — added a "📖 Operations Manual" link in the
  page header (search for `opsManualLink` to find the change).
- `public/css/deal-sheets.css` — added the `.headerRight` / `.opsManualLink`
  styles right after `.brand p` (search for `opsManualLink`).

## After copying the files in
```
git add api/manual public/operations-manual.html public/css/operations-manual.css \
  public/js/operations-manual.js scripts/build-manual-roster.py \
  public/js/accounts.js public/css/deal-sheets.css
git commit -m "Add Operations Manual + Team Dashboard"
git push
```
Vercel will auto-deploy from GitHub as usual. No new environment
variables or dependencies are needed — `api/manual/index.js` reuses the
same `requireUser` / `jose` auth already in the project.

## Reminders
- The GitHub password that was sitting in plaintext in the original
  manual document was **not** carried into `content.js` — it's been
  redacted. Please rotate that password since it had been sitting in a
  shared document.
- The dashboard data is a snapshot (dated in `roster-data.js`), not a
  live spreadsheet connection. Re-run `scripts/build-manual-roster.py`
  against a fresh export whenever the spreadsheet changes, then commit
  the regenerated `api/manual/roster-data.js`.
