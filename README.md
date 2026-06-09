# Fixed Income Analyser

An interactive Chrome extension (no-build, Manifest V3) that surveys and **ranks fixed-income / yield-generating
instruments** used by HNW investors and private banks — across **13 currencies** (USD, EUR, GBP, CHF, JPY, AUD,
CAD, SGD, AED, INR, ZAR, BRL, MXN) — with risk, reputation, inflation-adjusted "true returns", and a built-in
income calculator.

## What it does

- **~220 instruments** across 13 currencies: cash & T-bills, government & inflation-linked bonds, bank deposits,
  covered/securitised bonds, **Islamic sukuk**, IG & HY credit, **USD/EUR-denominated emerging-market bonds**
  (EM yield *without* EM FX risk), BDCs/private credit, municipals & tax-free bonds, **preferreds & hybrids**
  (incl. **STRC** "Stretch" and **Alphabet's 6.25% mandatory convertible**), REIT income and target-maturity funds.
- **Benchmark of your choice** — measure "true return" against any of the 13 currencies *or* **inflation-free hard
  money** (gold, or a USD·CHF·gold basket). Gold exposes how little actually preserves purchasing power.
- **Accessibility flag** on every instrument — 🌍 Global / 🛂 Cross-border / 🏠 Residents — so a global investor
  immediately sees what they can actually buy.
- **Enter an amount to invest** → see annual & monthly income per instrument, recalculated live.
- **Rank** by:
  - *Best overall* — a transparent, adjustable **Quality Score (0–100)** blending yield, safety, reputation & liquidity.
  - *Highest yield*, *Highest true (net-of-inflation) return*, *Highest monthly income*, or *Safest first*.
  - Or click any column header to sort.
- **"True return" column** subtracts either **local CPI inflation** or the currency's **long-run move vs USD**
  (devaluation), so you see the real, after-erosion yield — and can rank by it.
- **🏆 Best Currency league** — a currency-vs-currency view ranking all 13 on best safe rate, real
  (after-inflation) and hard-$ (after-FX) returns, a currency-quality score (sovereign credit + inflation + FX
  strength), and a blended **Overall** score. Click a currency to drill into its instruments. *(USD ranks best
  overall; BRL wins on raw rate — the "best rate vs best currency" trade-off, made explicit.)*
- **📈 Changelog & month-over-month comparison** — the dataset is versioned; each monthly refresh records the
  prior values so yield moves appear as ▲/▼ chips beside every instrument. See `UPDATE.md`.
- Per-currency **macro strip**: policy rate, CPI, currency drift vs USD.
- Filter by **category** and **risk band**, search, and expand any row for full notes, tax treatment, minimum
  investment, credit rating and the **source link**.

### Why STRC ranks below Alphabet
The user's exact intuition is baked in: STRC's ~11.5% tops the *yield* sort, but its unrated, bitcoin-backed-leverage
profile (risk 5/5, reputation 2/5) drops it to ~#23 on *Best overall*, while Alphabet's 6.25% mandatory convertible
(reputation 5/5) sits at ~#12. Push the *Reputation* / *Safety* weights up in **Methodology** to widen that gap.

## Install (load unpacked)

1. Open `chrome://extensions`
2. Enable **Developer mode** (top-right)
3. **Load unpacked** → select this `fixedincomeanalyser` folder
4. Click the toolbar icon → the analyser opens in a full tab.

## Local preview (no extension needed)

The page is pure HTML/CSS/JS and runs from any static server:

```
python -m http.server 8790 --directory fixedincomeanalyser
```

then open http://localhost:8790 .

## Updating the data (monthly)

Rates move, so the dataset is meant to be refreshed ~monthly. The full recipe is in **`UPDATE.md`**: snapshot the
current yields (so deltas line up), re-research all 13 currencies, append a changelog entry, and bump the version.
Run it manually, or wire it to a schedule (a Claude Code routine, cron, or Windows Task Scheduler).

## ⚠ Data & disclaimer

All figures are an **indicative snapshot as of June 2026**, gathered from public sources (each row carries its own
`as of` date and source link in the detail drawer). **Yields, ratings and prices change continuously.** This tool is
**for comparison only — not investment, tax or legal advice.** Several instruments are restricted to
qualified / professional / accredited investors or to residents of the relevant country. Verify every figure with
the issuer or your broker before acting. To refresh the data, edit `js/data.js`.

## Structure

```
manifest.json      MV3 manifest
background.js       service worker — opens the full-page app on icon click
index.html          app shell
css/styles.css      private-bank dark theme
js/data.js          the curated dataset (edit to update figures)
js/app.js           ranking, scoring, calculator & rendering engine
icons/              16 / 48 / 128 px
```
