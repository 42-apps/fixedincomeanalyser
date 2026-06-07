# Monthly data refresh — playbook

**Purpose:** Fixed Income Analyser ships a *dated snapshot* of yields. Rates move, so refresh the dataset
~monthly. This file is the exact recipe an agent (or you) follows. Run it on/around the **1st of each month**.

> Keep instrument **names stable** — they are the keys used to line up month-over-month deltas (`▲/▼`). Don't
> rename rows. If an instrument is discontinued, note it in the changelog (and only then remove it).

## Steps

1. **Snapshot the current month first (for deltas).**
   Before changing any numbers, capture every instrument's current yield into `js/data.js` →
   `window.FIA.snapshots`. Append one entry:
   ```js
   { date: "<YYYY-MM-01>", version: "<current FIA.version>", yields: {
       "USD|US Treasury Bill — 3-Month": 3.78,
       "USD|US Treasury Note — 10-Year": 4.55,
       /* …one "CCY|name": yield for EVERY instrument… */
   } }
   ```
   (The app diffs current data against the **most recent** snapshot, so this preserves "last month".)

2. **Re-research current figures for all 13 currencies** (USD, EUR, GBP, CHF, JPY, AUD, CAD, SGD, AED, INR,
   ZAR, BRL, MXN). For each currency update, in `js/data.js`:
   - **Per instrument:** `y` (representative nominal yield), `yr` (range), `realY` (only if inflation-linked),
     and `asOf`. Use a representative midpoint; cite a source in `src`; don't fabricate — flag uncertainty in
     the changelog. Keep notes ≤ ~240 chars.
   - **Per currency `macro`:** `policyRate`, `cpi`, `cpiAsOf`, `fx` (long-run % move vs USD; negative = the
     currency appreciates), and refresh `note` if the regime changed (rate cut/hike, new instrument, etc.).
   - Add genuinely new instruments where relevant; mark discontinued ones.
   A good approach: one research pass per currency (central-bank rate, CPI print, benchmark govt yields,
   deposit/credit/preferred/sukuk levels). Sonnet sub-agents per currency work well.

3. **Add a changelog entry** to `window.FIA.changelog` (append to the array; the app shows newest first):
   ```js
   { version: "<bumped, e.g. 1.1>", date: "<YYYY-MM-DD>", title: "<Month Year> refresh",
     summary: "Notable moves: <policy changes>, <biggest yield ▲/▼>, <new/removed instruments>." }
   ```

4. **Bump versions:** set `window.FIA.version` (e.g. `"1.1"`) and `window.FIA.meta.asOf` (e.g. `"July 2026"`).

5. **Verify.** Start the preview server (launch config **`fixedincome`**, port **8790**), reload, and check:
   - `preview_console_logs` → no errors.
   - Instrument table now shows `▲/▼` delta chips vs last month.
   - "🏆 Best currency" league still ranks sensibly.
   - "📈 Changelog" lists the new entry + current snapshot table.
   (Screenshots time out in this setup — verify with `preview_eval` against the DOM.)

6. **Persist.** If this is a git repo: `git commit -m "data: <Month Year> monthly refresh"` and push. Otherwise
   the local file edits are the update.

## Guardrails
- Indicative data, **not** investment advice. Representative midpoints, dated, sourced.
- Don't invent precision. If a figure can't be verified this month, keep last month's and note it.
- Preserve the file's structure and field names exactly (the app and the delta logic depend on them).
