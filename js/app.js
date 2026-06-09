/* ===== Fixed Income Analyser — engine ===== */
(function () {
  "use strict";
  const FIA = window.FIA;
  const CCY = FIA.currencies;
  const $ = (id) => document.getElementById(id);

  // ---- persistence (works as extension page OR static preview) ----
  const LS = {
    get(k, d) { try { const v = localStorage.getItem("fia_" + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem("fia_" + k, JSON.stringify(v)); } catch (e) {} },
  };

  const CAT_ORDER = [
    "Cash & Money Market", "Government", "Sukuk (Islamic)", "Inflation-Linked", "Bank Deposit",
    "Municipal & Tax-Free", "Securitized & Covered", "Supranational",
    "Corporate IG", "Corporate HY", "EM Hard-Currency Bond", "BDC & Private Credit",
    "Preferred & Hybrid", "Property & REIT", "Fund / ETF",
  ];

  // Per-currency sovereign credit (drives the "Best currency" quality score). Updated rarely.
  const SOVEREIGN = {
    USD: { rating: "AA+ / Aaa", score: 5.0 }, EUR: { rating: "AAA (core)", score: 5.0 },
    CHF: { rating: "AAA", score: 5.0 }, GBP: { rating: "AA-", score: 4.0 },
    JPY: { rating: "A+ / A1", score: 4.0 }, AUD: { rating: "AAA", score: 5.0 },
    CAD: { rating: "AAA", score: 5.0 }, SGD: { rating: "AAA", score: 5.0 },
    AED: { rating: "AA / Aa2", score: 4.5 }, INR: { rating: "BBB-", score: 3.0 },
    ZAR: { rating: "BB-", score: 2.0 }, BRL: { rating: "Ba1 / BB", score: 2.0 },
    MXN: { rating: "BBB-", score: 3.0 },
  };

  // ---- benchmark assets: currencies + "inflation-free" hard money ----
  const GOLD = { fx: -10, cpi: 0.25 };            // gold ≈ +10%/yr vs USD (20y CAGR); ~0.25% storage drag, no coupon
  const BASKET_W = { USD: 0.40, CHF: 0.30, GOLD: 0.30 };
  const BENCH_LABEL = { GOLD: "Gold", BASKET: "Hard-money basket" };
  function benchMacro(id) {
    if (id === "GOLD") return GOLD;
    if (id === "BASKET") return {
      fx: BASKET_W.USD * CCY.USD.macro.fx + BASKET_W.CHF * CCY.CHF.macro.fx + BASKET_W.GOLD * GOLD.fx,
      cpi: BASKET_W.USD * CCY.USD.macro.cpi + BASKET_W.CHF * CCY.CHF.macro.cpi + BASKET_W.GOLD * GOLD.cpi,
    };
    return CCY[id].macro;
  }
  function bmName() { return BENCH_LABEL[state.benchmark] || state.benchmark; }

  // ---- accessibility for a global investor ----
  const DM_GOVT = ["USD", "EUR", "GBP", "CHF", "JPY", "AUD", "CAD", "SGD"];
  const RESIDENT_RE = /retail saving|savings bond|premium bond|income bond|direct saver|british savings|provident fund|\bppf\b|\bssb\b|singapore saving|frsb|floating rate saving|top-up bond|pillar 3a|kassenobligation|national bonds|poup|pagar|sovereign gold bond/i;
  function accessOf(it) {
    if (it.access) return it.access;
    const n = (it.name + " " + it.type + " " + it.issuer).toLowerCase();
    if (RESIDENT_RE.test(n)) return "Residents";
    if (it.cat === "Bank Deposit") return "Residents";
    if (["Government", "Cash & Money Market", "Inflation-Linked", "Municipal & Tax-Free"].includes(it.cat) && !DM_GOVT.includes(it.ccy)) return "Cross-border";
    return "Global";
  }
  const ACCESS_META = {
    "Global": { c: "acc-g", t: "Buyable worldwide via international brokers" },
    "Cross-border": { c: "acc-x", t: "Open to foreigners but needs a specific broker/custodian or qualified-investor access" },
    "Residents": { c: "acc-r", t: "Effectively residents-only (local account / citizenship / tax status required)" },
  };
  const ACCESS_ORDER = ["Global", "Cross-border", "Residents"];

  // ---- attach currency code + per-currency yield bounds (stable normalisation) ----
  const YBOUNDS = {};
  Object.keys(CCY).forEach((code) => {
    const list = CCY[code].instruments;
    let lo = Infinity, hi = -Infinity;
    list.forEach((it) => { it.ccy = code; lo = Math.min(lo, it.y); hi = Math.max(hi, it.y); });
    YBOUNDS[code] = { lo, hi };
  });
  const INSTR_BY_KEY = {};
  Object.keys(CCY).forEach((code) => CCY[code].instruments.forEach((it) => { INSTR_BY_KEY[code + "|" + it.name] = it; }));

  // ---- most-recent yield snapshot (for month-over-month deltas) ----
  const SNAP = (FIA.snapshots && FIA.snapshots.length) ? FIA.snapshots[FIA.snapshots.length - 1] : null;
  const SNAP_Y = SNAP ? SNAP.yields : null;
  const instKey = (it) => it.ccy + "|" + it.name;

  // ---- state ----
  const state = {
    view: LS.get("view", "inst"),       // 'inst' | 'ccy'
    ccy: LS.get("ccy", "USD"),
    amount: LS.get("amount", 1000000),
    rankBy: LS.get("rankBy", "best"),
    erosion: LS.get("erosion", "real"),
    benchmark: LS.get("benchmark", "CHF"),
    fxBasis: LS.get("fxBasis", "historical"),
    search: "",
    cats: new Set(),
    risks: new Set(),
    access: new Set(),
    portfolio: LS.get("portfolio", []),
    weights: LS.get("weights", Object.assign({}, FIA.weights)),
    sort: { key: "q", dir: "desc" },
    ccySort: { key: "overall", dir: "desc" },
  };
  if (!CCY[state.ccy]) state.ccy = "USD";
  if (!CCY[state.benchmark] && state.benchmark !== "GOLD" && state.benchmark !== "BASKET") state.benchmark = "CHF";

  // ---- helpers ----
  const SYM = {
    USD: "$", EUR: "€", CHF: "CHF ", ZAR: "R", INR: "₹",
    GBP: "£", JPY: "¥", AUD: "A$", CAD: "C$", SGD: "S$", AED: "AED ", BRL: "R$", MXN: "MX$",
  };
  const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
  function moneyFmt(ccy) {
    const locale = ccy === "INR" ? "en-IN" : "en-US";
    return new Intl.NumberFormat(locale, { maximumFractionDigits: 0 });
  }
  function money(v, ccy) {
    const neg = v < 0;
    const s = SYM[ccy] || "";
    return (neg ? "-" : "") + s + moneyFmt(ccy).format(Math.abs(Math.round(v)));
  }
  const pct = (v) => (v >= 0 ? "" : "−") + Math.abs(v).toFixed(2) + "%";
  const fxText = (fx) => fx === 0 ? "0%" : (fx > 0 ? "−" + fx.toFixed(1) + "%" : "+" + Math.abs(fx).toFixed(1) + "%");
  const liqScore = (l) => (l === "High" ? 1 : l === "Medium" ? 0.5 : 0.2);
  const liqClass = (l) => (l === "High" ? "liq-h" : l === "Medium" ? "liq-m" : "liq-l");

  function benchPolicy(id) {
    if (id === "GOLD") return 0;                        // gold lease rate ≈ 0
    if (id === "BASKET") return BASKET_W.USD * CCY.USD.macro.policyRate + BASKET_W.CHF * CCY.CHF.macro.policyRate;
    return CCY[id].macro.policyRate;
  }
  function deprecVsBenchmark(ccy) {
    if (state.fxBasis === "hedged") return CCY[ccy].macro.policyRate - benchPolicy(state.benchmark); // covered-interest-parity (forward-implied)
    return CCY[ccy].macro.fx - benchMacro(state.benchmark).fx;                                        // long-run historical average
  }
  function erosionBase(ccy) {
    const m = CCY[ccy].macro;
    if (state.erosion === "cpi") return m.cpi;
    const deprec = deprecVsBenchmark(ccy);
    if (state.erosion === "fx") return deprec;                  // currency move only
    return deprec + benchMacro(state.benchmark).cpi;            // "real": currency move + benchmark inflation
  }
  function netReal(it) {
    if (state.erosion === "cpi" && typeof it.realY === "number") return it.realY;
    return it.y - erosionBase(it.ccy);
  }
  function quality(it) {
    const b = YBOUNDS[it.ccy];
    const span = b.hi - b.lo;
    const normY = span > 0 ? (it.y - b.lo) / span : 0.5;
    const safety = (5 - it.risk) / 4;
    const repN = (it.rep - 1) / 4;
    const liqN = liqScore(it.liq);
    const w = normalisedWeights();
    return 100 * (w.yield * normY + w.safety * safety + w.reputation * repN + w.liquidity * liqN);
  }
  function normalisedWeights() {
    const w = state.weights;
    const s = w.yield + w.safety + w.reputation + w.liquidity || 1;
    return { yield: w.yield / s, safety: w.safety / s, reputation: w.reputation / s, liquidity: w.liquidity / s };
  }
  // delta vs last snapshot (dormant until a monthly refresh has run)
  function deltaChip(it) {
    if (!SNAP_Y) return "";
    const prev = SNAP_Y[instKey(it)];
    if (typeof prev !== "number") return "";
    const d = it.y - prev;
    if (Math.abs(d) < 0.005) return ` <span class="delta flat" title="unchanged vs ${SNAP.date}">→</span>`;
    const up = d > 0;
    return ` <span class="delta ${up ? "up" : "down"}" title="vs ${SNAP.date}">${up ? "▲" : "▼"}${Math.abs(d).toFixed(2)}</span>`;
  }

  // ---- working set (instrument view) ----
  function baseList() {
    return state.ccy === "ALL"
      ? Object.keys(CCY).flatMap((c) => CCY[c].instruments)
      : CCY[state.ccy].instruments;
  }
  function decorate(it) {
    const annual = state.amount * it.y / 100;
    return { it, annual, monthly: annual / 12, net: netReal(it), q: quality(it), base: erosionBase(it.ccy) };
  }
  function visibleRows() {
    const q = state.search.trim().toLowerCase();
    let rows = baseList().filter((it) => {
      if (state.cats.size && !state.cats.has(it.cat)) return false;
      if (state.risks.size && !state.risks.has(it.risk)) return false;
      if (state.access.size && !state.access.has(accessOf(it))) return false;
      if (q) {
        const hay = (it.name + " " + it.issuer + " " + it.ticker + " " + it.type + " " + it.cat).toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    }).map(decorate);

    const dir = state.sort.dir === "asc" ? 1 : -1;
    const key = state.sort.key;
    const val = (r) => ({
      name: r.it.name, cat: r.it.cat, y: r.it.y, risk: r.it.risk, rep: r.it.rep,
      q: r.q, base: r.base, net: r.net, annual: r.annual, monthly: r.monthly, liq: liqScore(r.it.liq),
    }[key]);
    rows.sort((a, b) => {
      let av = val(a), bv = val(b), c;
      if (typeof av === "string") c = av.localeCompare(bv); else c = av - bv;
      if (c !== 0) return c * dir;
      return b.q - a.q;
    });
    return rows;
  }

  // ===================================================================== CURRENCY LEAGUE
  function ccyLeague() {
    const bmFx = benchMacro(state.benchmark).fx;
    const rows = Object.keys(CCY).map((code) => {
      const c = CCY[code], m = c.macro, insts = c.instruments;
      // "best safe rate" = highest-yielding genuinely safe, reasonably liquid instrument.
      // Exclude inflation-linked (their nominal yield isn't a locked rate, it rides on CPI).
      let pool = insts.filter((i) => i.risk <= 1 && i.liq !== "Low" && !i.il);
      if (!pool.length) pool = insts.filter((i) => i.risk <= 1 && !i.il);
      if (!pool.length) pool = insts.filter((i) => i.risk <= 2 && !i.il);
      if (!pool.length) pool = insts;
      const bestSafe = pool.reduce((a, b) => (b.y > a.y ? b : a));
      const top = insts.reduce((a, b) => (b.y > a.y ? b : a));
      const sov = SOVEREIGN[code] || { rating: "—", score: 3 };
      const real = bestSafe.y - m.cpi;                 // safe yield after local inflation
      const hard = bestSafe.y - deprecVsBenchmark(code); // safe yield after currency move vs the benchmark (respects FX basis)
      const inflN = clamp(1 - m.cpi / 10, 0, 1);
      const fxN = clamp(1 - (m.fx + 3) / 10, 0, 1);
      const ccyScore = 100 * (0.40 * (sov.score / 5) + 0.30 * inflN + 0.30 * fxN);
      return { code, c, m, sov, bestSafe, safeY: bestSafe.y, top, topY: top.y, real, hard, ccyScore };
    });
    const hards = rows.map((r) => r.hard);
    const lo = Math.min(...hards), hi = Math.max(...hards), span = (hi - lo) || 1;
    rows.forEach((r) => { r.overall = 100 * (0.5 * ((r.hard - lo) / span) + 0.5 * (r.ccyScore / 100)); });
    return rows;
  }

  const LCOLS = [
    { key: "rank", label: "#", lft: true, sortable: false },
    { key: "code", label: "Currency", lft: true },
    { key: "sov", label: "Sovereign", lft: true },
    { key: "policy", label: "Policy" },
    { key: "safeY", label: "Best safe rate" },
    { key: "topY", label: "Top yield" },
    { key: "cpi", label: "Inflation" },
    { key: "fx", label: "FX vs USD" },
    { key: "real", label: "Real (after infl)" },
    { key: "hard", label: "Hard-$ (after FX)" },
    { key: "ccyScore", label: "Currency score" },
    { key: "overall", label: "Overall" },
  ];

  function leagueSorted() {
    const rows = ccyLeague();
    const dir = state.ccySort.dir === "asc" ? 1 : -1, key = state.ccySort.key;
    const val = (r) => ({
      code: r.code, sov: r.sov.score, policy: r.m.policyRate, safeY: r.safeY, topY: r.topY,
      cpi: r.m.cpi, fx: r.m.fx, real: r.real, hard: r.hard, ccyScore: r.ccyScore, overall: r.overall,
    }[key]);
    rows.sort((a, b) => {
      let av = val(a), bv = val(b), c;
      if (typeof av === "string") c = av.localeCompare(bv); else c = av - bv;
      if (c !== 0) return c * dir;
      return b.overall - a.overall;
    });
    return rows;
  }

  function renderLeague() {
    const rows = leagueSorted();

    // macro strip → methodology note
    $("macro").innerHTML = `<div class="macro-note" style="grid-column:1/-1">
      <strong>Best currency for fixed income.</strong> One row per currency. <em>Best safe rate</em> = the highest-yielding genuinely safe (risk 1), liquid instrument available.
      <em>Real</em> nets off local inflation; <em>Hard</em> nets off the currency's move vs the chosen <strong>benchmark</strong> (a currency, or hard money — gold / a USD·CHF·gold basket).
      <em>Currency score</em> blends sovereign credit (40%), low inflation (30%) and FX strength (30%). <em>Overall</em> = 50% hard-currency real rate + 50% currency score.
      Click a row to drill into that currency's instruments; click any header to re-rank.</div>`;

    // highlights (best = the maximum on each metric)
    const best = (k) => rows.slice().sort((a, b) => k(b) - k(a))[0];
    const topOverall = best((r) => r.overall);
    const topRate = best((r) => r.safeY);
    const topReal = best((r) => r.real);
    const topHard = best((r) => r.hard);
    const strongest = best((r) => r.ccyScore);
    const card = (cls, tag, r, line) =>
      `<div class="hl-card ${cls}"><div class="hl-tag">${tag}</div><div class="hl-name">${r.c.flag} ${r.code} — ${r.c.name}</div><div class="hl-val">${line}</div></div>`;
    $("highlights").innerHTML = [
      card("", "Best currency overall", topOverall, `Score <b>${Math.round(topOverall.overall)}</b> · safe ${topOverall.safeY.toFixed(2)}% · hard-$ ${pct(topOverall.hard)}`),
      card("gold", "Highest safe rate", topRate, `<b>${topRate.safeY.toFixed(2)}%</b> · ${topRate.bestSafe.name}`),
      card("teal", "Best after inflation", topReal, `<b>${pct(topReal.real)}</b> real · ${topReal.safeY.toFixed(2)}% gross`),
      card("blue", `Best hard (vs ${bmName()})`, topHard, `<b>${pct(topHard.hard)}</b> · ${topHard.safeY.toFixed(2)}% safe, after FX vs ${bmName()}`),
    ].join("");

    // head
    $("thead").innerHTML = "<tr>" + LCOLS.map((c) => {
      const arrow = state.ccySort.key === c.key ? `<span class="arrow">${state.ccySort.dir === "asc" ? "▲" : "▼"}</span>` : "";
      const lbl = c.key === "hard" ? "Hard (vs " + bmName() + ")" : c.label;
      return `<th class="${c.lft ? "lft" : ""}" data-lkey="${c.key}" ${c.sortable === false ? 'data-nosort="1"' : ""}>${lbl}${arrow}</th>`;
    }).join("") + "</tr>";
    $("thead").querySelectorAll("th").forEach((th) => {
      if (th.dataset.nosort) return;
      th.onclick = () => {
        const k = th.dataset.lkey;
        if (state.ccySort.key === k) state.ccySort.dir = state.ccySort.dir === "asc" ? "desc" : "asc";
        else state.ccySort = { key: k, dir: k === "code" ? "asc" : "desc" };
        renderLeague();
      };
    });

    // body
    $("empty").hidden = true;
    $("tbody").innerHTML = rows.map((r, i) => {
      const income = money(state.amount * r.safeY / 100, r.code);
      const fxCls = r.m.fx > 0 ? "net-neg" : r.m.fx < 0 ? "net-pos" : "";
      return `<tr data-code="${r.code}">
        <td class="lft rank">${i + 1}</td>
        <td class="lft"><span class="inst-name">${r.c.flag} ${r.code}</span><div class="inst-sub">${r.c.name}</div></td>
        <td class="lft"><span class="risk-txt">${r.sov.rating}</span></td>
        <td>${r.m.policyRate.toFixed(2)}%</td>
        <td><span class="yield-val" style="font-size:13.5px">${r.safeY.toFixed(2)}%</span><div class="inst-sub">${r.bestSafe.name} · ${income}/yr</div></td>
        <td>${r.topY.toFixed(2)}%</td>
        <td class="gold-txt">${r.m.cpi.toFixed(2)}%</td>
        <td class="${fxCls}">${fxText(r.m.fx)}</td>
        <td class="${r.real >= 0 ? "net-pos" : "net-neg"}">${pct(r.real)}</td>
        <td class="${r.hard >= 0 ? "net-pos" : "net-neg"}">${pct(r.hard)}</td>
        <td><div class="qbar"><span style="width:${clamp(r.ccyScore, 3, 100).toFixed(0)}%"></span><b>${Math.round(r.ccyScore)}</b></div></td>
        <td><div class="qbar gold"><span style="width:${clamp(r.overall, 3, 100).toFixed(0)}%"></span><b>${Math.round(r.overall)}</b></div></td>
      </tr>`;
    }).join("");
    $("tbody").querySelectorAll("tr").forEach((tr) => tr.onclick = () => {
      state.view = "inst"; state.ccy = tr.dataset.code; state.cats.clear();
      LS.set("view", "inst"); LS.set("ccy", state.ccy);
      syncToggle(); renderAll();
    });
    $("rowCount").textContent = `${rows.length} currencies ranked — best for fixed income`;
  }

  // ===================================================================== INSTRUMENT VIEW RENDER
  function renderTabs() {
    const wrap = $("ccyTabs");
    const tabs = Object.keys(CCY).map((c) => ({ code: c, name: CCY[c].name, flag: CCY[c].flag }));
    tabs.push({ code: "ALL", name: "All currencies", flag: "🌐" });
    wrap.innerHTML = tabs.map((t) =>
      `<button class="ccy-tab${state.ccy === t.code ? " active" : ""}" data-ccy="${t.code}">
        <span class="fl">${t.flag}</span>${t.code === "ALL" ? "All" : t.code}
      </button>`).join("");
    wrap.querySelectorAll(".ccy-tab").forEach((b) =>
      b.onclick = () => { state.ccy = b.dataset.ccy; state.cats.clear(); LS.set("ccy", state.ccy); renderAll(); });
  }

  function renderChips() {
    const present = [...new Set(baseList().map((i) => i.cat))].sort((a, b) => CAT_ORDER.indexOf(a) - CAT_ORDER.indexOf(b));
    $("catChips").innerHTML =
      `<span class="chip${state.cats.size === 0 ? " active" : ""}" data-cat="__all">All types</span>` +
      present.map((c) => `<span class="chip${state.cats.has(c) ? " active" : ""}" data-cat="${c}">${c}</span>`).join("");
    $("catChips").querySelectorAll(".chip").forEach((ch) => ch.onclick = () => {
      const c = ch.dataset.cat;
      if (c === "__all") state.cats.clear();
      else { state.cats.has(c) ? state.cats.delete(c) : state.cats.add(c); }
      render(); renderChips();
    });

    const RLABEL = { 1: "1 · Safest", 2: "2 · Low", 3: "3 · Moderate", 4: "4 · High", 5: "5 · Highest" };
    $("riskChips").innerHTML =
      `<span class="chip${state.risks.size === 0 ? " active" : ""}" data-risk="0">All risk</span>` +
      [1, 2, 3, 4, 5].map((r) =>
        `<span class="chip${state.risks.has(r) ? " active" : ""}" data-risk="${r}"><span class="dot r${r}"></span>${RLABEL[r]}</span>`).join("");
    $("riskChips").querySelectorAll(".chip").forEach((ch) => ch.onclick = () => {
      const r = +ch.dataset.risk;
      if (r === 0) state.risks.clear();
      else { state.risks.has(r) ? state.risks.delete(r) : state.risks.add(r); }
      render(); renderChips();
    });

    const ALABEL = { "Global": "🌍 Global", "Cross-border": "🛂 Cross-border", "Residents": "🏠 Residents" };
    $("accessChips").innerHTML =
      `<span class="chip${state.access.size === 0 ? " active" : ""}" data-acc="__all">All access</span>` +
      ACCESS_ORDER.map((a) => `<span class="chip${state.access.has(a) ? " active" : ""}" data-acc="${a}">${ALABEL[a]}</span>`).join("");
    $("accessChips").querySelectorAll(".chip").forEach((ch) => ch.onclick = () => {
      const a = ch.dataset.acc;
      if (a === "__all") state.access.clear();
      else { state.access.has(a) ? state.access.delete(a) : state.access.add(a); }
      render(); renderChips();
    });
  }

  function renderMacro() {
    const el = $("macro");
    if (state.ccy === "ALL") {
      el.innerHTML = Object.keys(CCY).map((c) => {
        const m = CCY[c].macro;
        return `<div class="macro-card"><div class="k">${CCY[c].flag} ${c}</div>
          <div class="v">${m.cpi.toFixed(1)}%</div>
          <div class="s">CPI · policy ${m.policyRate.toFixed(2)}% · FX ${fxText(m.fx)}/yr</div></div>`;
      }).join("") + `<div class="macro-note">Showing every instrument across all ${Object.keys(CCY).length} currencies. Income is in each instrument's own currency; "true return" uses each currency's own inflation / FX. Risk grades are most comparable <em>within</em> a single currency — use the <strong>🏆 Best currency</strong> view to rank currencies against each other.</div>`;
      return;
    }
    const m = CCY[state.ccy].macro;
    const fxTxt = m.fx === 0 ? "0% (reference)" : (m.fx > 0 ? "−" + m.fx.toFixed(1) + "%/yr (depreciates)" : "+" + Math.abs(m.fx).toFixed(1) + "%/yr (appreciates)");
    const fxCls = m.fx > 0 ? "down" : m.fx < 0 ? "up" : "";
    el.innerHTML =
      `<div class="macro-card"><div class="k">Policy rate</div><div class="v">${m.policyRate.toFixed(2)}%</div><div class="s">${m.policyRateName}</div></div>
       <div class="macro-card"><div class="k">Inflation (CPI)</div><div class="v gold">${m.cpi.toFixed(2)}%</div><div class="s">as of ${m.cpiAsOf}</div></div>
       <div class="macro-card"><div class="k">Currency vs USD</div><div class="v ${fxCls}">${fxTxt.split(" ")[0]}</div><div class="s">${fxTxt.split(" ").slice(1).join(" ") || "annualised, long-run"}</div></div>
       <div class="macro-card"><div class="k">Instruments</div><div class="v">${CCY[state.ccy].instruments.length}</div><div class="s">surveyed in ${state.ccy}</div></div>
       <div class="macro-note">${m.note}</div>`;
  }

  function renderHighlights(rows) {
    const el = $("highlights");
    if (!rows.length) { el.innerHTML = ""; return; }
    const by = (k) => rows.slice().sort((a, b) => k(b) - k(a))[0];
    const topYield = by((r) => r.it.y);
    const topQ = by((r) => r.q);
    const topNet = by((r) => r.net);
    const safest = rows.slice().sort((a, b) => (a.it.risk - b.it.risk) || (b.it.y - a.it.y))[0];
    const card = (cls, tag, r, line) =>
      `<div class="hl-card ${cls}"><div class="hl-tag">${tag}</div><div class="hl-name">${r.it.name}</div><div class="hl-val">${line(r)}</div></div>`;
    el.innerHTML = [
      card("gold", "Highest yield", topYield, (r) => `<b>${r.it.y.toFixed(2)}%</b> · risk ${r.it.risk}/5 · ${r.it.ccy}`),
      card("", "Best overall (risk-adjusted)", topQ, (r) => `Quality <b>${Math.round(r.q)}</b> · ${r.it.y.toFixed(2)}% · risk ${r.it.risk}/5`),
      card("teal", `Best true return (${state.erosion === "cpi" ? "net of inflation" : state.erosion === "fx" ? "vs " + bmName() : "real, vs " + bmName()})`, topNet, (r) => `<b>${pct(r.net)}</b> · ${r.it.y.toFixed(2)}% gross`),
      card("blue", "Safest pick", safest, (r) => `risk ${r.it.risk}/5 · <b>${r.it.y.toFixed(2)}%</b> · ${r.it.rating}`),
    ].join("");
  }

  const COLS = [
    { key: "rank", label: "#", lft: true, sortable: false },
    { key: "name", label: "Instrument", lft: true },
    { key: "cat", label: "Category", lft: true },
    { key: "y", label: "Yield" },
    { key: "risk", label: "Risk" },
    { key: "rep", label: "Reputation" },
    { key: "q", label: "Quality" },
    { key: "base", label: "Inflation" },
    { key: "net", label: "True net" },
    { key: "annual", label: "Income / yr" },
    { key: "monthly", label: "Income / mo" },
    { key: "liq", label: "Liquidity" },
  ];

  function renderHead() {
    const bn = bmName();
    let baseLabel, netLabel;
    if (state.erosion === "cpi") { baseLabel = "Inflation"; netLabel = "Net real"; }
    else if (state.erosion === "fx") { baseLabel = "FX vs " + bn; netLabel = "Net (" + bn + ")"; }
    else { baseLabel = "Erosion vs " + bn; netLabel = "Real (" + bn + ")"; }
    if (state.erosion !== "cpi" && state.fxBasis === "hedged") netLabel += " ⚓";
    $("thead").innerHTML = "<tr>" + COLS.map((c) => {
      const label = c.key === "base" ? baseLabel : c.key === "net" ? netLabel : c.label;
      const arrow = state.sort.key === c.key ? `<span class="arrow">${state.sort.dir === "asc" ? "▲" : "▼"}</span>` : "";
      return `<th class="${c.lft ? "lft" : ""}" data-key="${c.key}" ${c.sortable === false ? 'data-nosort="1"' : ""}>${label}${arrow}</th>`;
    }).join("") + "</tr>";
    $("thead").querySelectorAll("th").forEach((th) => {
      if (th.dataset.nosort) return;
      th.onclick = () => {
        const k = th.dataset.key;
        if (state.sort.key === k) state.sort.dir = state.sort.dir === "asc" ? "desc" : "asc";
        else state.sort = { key: k, dir: k === "name" || k === "cat" ? "asc" : "desc" };
        $("rankBy").selectedIndex = -1;
        render();
      };
    });
  }

  function stars(n) {
    let s = "";
    for (let i = 1; i <= 5; i++) s += `<span class="${i <= n ? "" : "off"}">★</span>`;
    return `<span class="rep-stars" title="${n}/5 reputation">${s}</span>`;
  }

  function renderTable(rows) {
    const tb = $("tbody");
    $("empty").hidden = rows.length > 0;
    tb.innerHTML = rows.map((r, i) => {
      const it = r.it;
      const tkr = it.ticker ? `<span class="tkr">${it.ticker}</span>` : "";
      const ccyTag = state.ccy === "ALL" ? `<span class="tkr" style="color:var(--teal);background:rgba(45,212,191,.1);border-color:rgba(45,212,191,.3)">${it.ccy}</span>` : "";
      const netCls = r.net >= 0 ? "net-pos" : "net-neg";
      const pk = instKey(it); const inPort = state.portfolio.some((p) => p.key === pk);
      const il = it.il ? `<span class="il-tag" title="Inflation-linked: principal/coupon tracks CPI">CPI-linked</span>` : "";
      const baseShown = state.erosion === "cpi"
        ? r.base.toFixed(2) + "%"
        : (r.base === 0 ? "0%" : (r.base > 0 ? "−" + r.base.toFixed(2) + "%" : "+" + Math.abs(r.base).toFixed(2) + "%"));
      return `<tr data-i="${i}">
        <td class="lft rank">${i + 1}</td>
        <td class="lft"><span class="inst-name">${it.name}</span>${tkr}${ccyTag}<div class="inst-sub">${it.issuer} · <span class="acc ${ACCESS_META[accessOf(it)].c}" title="${ACCESS_META[accessOf(it)].t}">${accessOf(it)}</span> · <button class="port-add${inPort ? " in" : ""}" data-key="${pk}">${inPort ? "✓ Port" : "+ Port"}</button></div></td>
        <td class="lft"><span class="cat-badge">${it.cat}</span></td>
        <td><span class="yield-val">${it.y.toFixed(2)}%</span>${il}${deltaChip(it)}</td>
        <td><span class="risk-pill"><span class="risk-txt">${it.rating}</span><span class="risk-dot r${it.risk}" title="risk ${it.risk}/5"></span></span></td>
        <td>${stars(it.rep)}</td>
        <td><div class="qbar"><span style="width:${Math.max(3, Math.min(100, r.q)).toFixed(0)}%"></span><b>${Math.round(r.q)}</b></div></td>
        <td title="${state.erosion === "cpi" ? "local CPI inflation" : (state.erosion === "fx" ? "currency move vs " + bmName() : "currency move vs " + bmName() + " + " + bmName() + " inflation")}">${baseShown}</td>
        <td class="${netCls}">${pct(r.net)}${(state.erosion === "cpi" && typeof it.realY === "number") ? '<span class="il-tag" title="protected real yield">real</span>' : ""}</td>
        <td><span class="income">${money(r.annual, it.ccy)}</span></td>
        <td><span class="income">${money(r.monthly, it.ccy)}</span><div class="income-sub">/mo</div></td>
        <td><span class="${liqClass(it.liq)}">${it.liq}</span></td>
      </tr>`;
    }).join("");

    tb.querySelectorAll("tr").forEach((tr) => tr.onclick = () => toggleDetail(tr, rows[+tr.dataset.i]));
    tb.querySelectorAll(".port-add").forEach((b) => b.onclick = (e) => { e.stopPropagation(); togglePort(b.dataset.key); });
    $("rowCount").textContent = `${rows.length} instrument${rows.length === 1 ? "" : "s"}` +
      (state.ccy === "ALL" ? ` across ${Object.keys(CCY).length} currencies` : ` in ${state.ccy}`);
  }

  function toggleDetail(tr, r) {
    const next = tr.nextElementSibling;
    if (next && next.classList.contains("detail-row")) { next.remove(); tr.classList.remove("open"); return; }
    document.querySelectorAll(".detail-row").forEach((d) => d.remove());
    document.querySelectorAll("tr.open").forEach((o) => o.classList.remove("open"));
    tr.classList.add("open");
    const it = r.it;
    const bm = bmName(), dep = deprecVsBenchmark(it.ccy), bmCpi = benchMacro(state.benchmark).cpi;
    const nb = `<b class="${r.net >= 0 ? "net-pos" : "net-neg"}">${pct(r.net)}</b>`;
    const depStr = (dep > 0 ? "− " : "+ ") + Math.abs(dep).toFixed(2) + "%";
    const netLine = state.erosion === "cpi"
      ? `Gross ${it.y.toFixed(2)}% − inflation ${CCY[it.ccy].macro.cpi.toFixed(2)}% = ${nb} true real (local purchasing power)`
      : state.erosion === "fx"
      ? `Gross ${it.y.toFixed(2)}% ${depStr} currency move vs ${bm} = ${nb} in ${bm} terms`
      : `Gross ${it.y.toFixed(2)}% ${depStr} move vs ${bm} − ${bmCpi.toFixed(2)}% ${bm} inflation = ${nb} real, in ${bm} purchasing power`;
    const netAnnual = state.amount * r.net / 100;
    const snapNote = (SNAP_Y && typeof SNAP_Y[instKey(it)] === "number")
      ? `<span class="mk">Since ${SNAP.date}</span><span>${pct(it.y - SNAP_Y[instKey(it)]).replace("%", "")} pp yield change</span>` : "";
    const row = document.createElement("tr");
    row.className = "detail-row";
    row.innerHTML = `<td colspan="${COLS.length}"><div class="detail">
      <div class="notes"><strong>${it.name}</strong> — ${it.type}<br>${it.notes}
        <div style="margin-top:10px">${netLine}.</div>
        <div class="muted" style="margin-top:6px">On ${money(state.amount, it.ccy)} → ${money(r.annual, it.ccy)}/yr gross · ${money(r.monthly, it.ccy)}/mo · ≈ ${money(netAnnual, it.ccy)}/yr after ${state.erosion === "fx" ? "FX" : "inflation"}.</div>
      </div>
      <div class="meta">
        <span class="mk">Issuer</span><span>${it.issuer}</span>
        ${it.ticker ? `<span class="mk">Ticker</span><span>${it.ticker}</span>` : ""}
        <span class="mk">Yield range</span><span>${it.yr || "—"}</span>
        <span class="mk">Credit / cover</span><span>${it.rating}</span>
        <span class="mk">Risk</span><span>${it.risk}/5 · Reputation ${it.rep}/5 · Liquidity ${it.liq}</span>
        <span class="mk">Min. investment</span><span>${it.min}</span>
        <span class="mk">Access</span><span>${accessOf(it)} — ${ACCESS_META[accessOf(it)].t}</span>
        <span class="mk">Tax</span><span>${it.tax}</span>
        <span class="mk">As of</span><span>${it.asOf}</span>
        ${snapNote}
        <span class="mk">Source</span><span><a href="${it.src}" target="_blank" rel="noopener">${shortUrl(it.src)}</a></span>
      </div></div></td>`;
    tr.after(row);
  }
  function shortUrl(u) { try { return new URL(u).hostname.replace(/^www\./, ""); } catch (e) { return "source"; } }

  // ---- sliders / methodology ----
  const WLABELS = { yield: "Yield", safety: "Safety", reputation: "Reputation", liquidity: "Liquidity" };
  function renderSliders() {
    $("sliders").innerHTML = Object.keys(WLABELS).map((k) => {
      const pctv = Math.round(normalisedWeights()[k] * 100);
      return `<div class="slider"><div class="slider-top"><span>${WLABELS[k]}</span><b id="w_${k}_v">${pctv}%</b></div>
        <input type="range" min="0" max="100" step="5" value="${Math.round(state.weights[k] * 100)}" data-w="${k}"></div>`;
    }).join("");
    $("sliders").querySelectorAll("input").forEach((sl) => sl.oninput = () => {
      state.weights[sl.dataset.w] = +sl.value / 100;
      LS.set("weights", state.weights);
      Object.keys(WLABELS).forEach((k) => { const e = $("w_" + k + "_v"); if (e) e.textContent = Math.round(normalisedWeights()[k] * 100) + "%"; });
      render();
    });
    const w = normalisedWeights();
    $("weightSum").textContent = `Effective: ${Math.round(w.yield * 100)}/${Math.round(w.safety * 100)}/${Math.round(w.reputation * 100)}/${Math.round(w.liquidity * 100)} (Yield/Safety/Rep/Liq)`;
  }

  function renderAbout() {
    const srcs = [...new Set(Object.values(CCY).flatMap((c) => c.instruments).map((i) => shortUrl(i.src)))].sort();
    $("aboutInner").innerHTML = `<h3>About &amp; sources</h3>
      <p class="muted">${FIA.meta.disclaimer}</p>
      <p style="margin-top:10px"><strong>Method.</strong> "Best overall" = a Quality Score (0–100) weighting yield (normalised within each currency), safety (inverse of the 1–5 risk grade), issuer reputation, and liquidity. "True return" can subtract local CPI inflation, the currency's move vs a chosen <strong>benchmark</strong>, or <em>both combined</em> — the real return in the benchmark currency (default <strong>CHF</strong>, our strongest-scored currency): nominal − depreciation vs benchmark − benchmark inflation. The <strong>Best currency</strong> league scores each currency on its best safe rate (real &amp; benchmark-FX-adjusted) plus a currency-quality blend (sovereign credit, inflation, FX).</p>
      <p style="margin-top:10px"><strong>Coverage.</strong> ${Object.keys(CCY).length} currencies · ${Object.values(CCY).reduce((n, c) => n + c.instruments.length, 0)} instruments — cash &amp; T-bills, govvies, inflation linkers, bank deposits, Islamic sukuk, covered/securitised, IG &amp; HY credit, BDCs/private credit, municipals/tax-free, preferreds &amp; hybrids (incl. STRC and Alphabet's 6.25% mandatory convertible), REIT income and target-maturity funds.</p>
      <p style="margin-top:10px" class="muted">No comparable free, cross-currency, multi-instrument tool exists as a browser extension (sovereign-only sites like World Government Bonds / Trading Economics, single-country rate aggregators, and paywalled terminals are the nearest analogues). Source domains here: ${srcs.length}.</p>`;
  }

  function renderChangelog() {
    const log = FIA.changelog || [];
    const snaps = FIA.snapshots || [];
    let html = `<h3>📈 Data changelog &amp; month-over-month comparison</h3>
      <p class="muted">This dataset is a dated snapshot (currently <strong>v${FIA.version || "1.0"}, ${FIA.meta.asOf}</strong>). A monthly refresh re-researches all ${Object.keys(CCY).length} currencies, records the prior values, and logs what changed — yield moves then appear as ▲/▼ chips beside each instrument's yield and in the detail drawer.</p>`;

    html += `<div class="cl-list">` + log.slice().reverse().map((e) =>
      `<div class="cl-entry"><div class="cl-ver">v${e.version} · ${e.date}</div><div class="cl-title">${e.title}</div><div class="muted">${e.summary}</div></div>`).join("") + `</div>`;

    if (snaps.length === 0) {
      html += `<p class="muted" style="margin-top:12px">Only the <strong>baseline</strong> snapshot exists so far — month-over-month deltas begin from the next monthly refresh.</p>`;
    }

    // current snapshot table (the documented baseline record)
    html += `<h3 style="margin-top:16px;font-size:15px">Current macro snapshot (v${FIA.version || "1.0"})</h3>
      <table class="cl-snap"><thead><tr><th>Currency</th><th>Policy</th><th>Inflation</th><th>FX vs USD/yr</th><th>Sovereign</th></tr></thead><tbody>` +
      Object.keys(CCY).map((code) => {
        const m = CCY[code].macro, sov = SOVEREIGN[code] || { rating: "—" };
        return `<tr><td>${CCY[code].flag} ${code}</td><td>${m.policyRate.toFixed(2)}%</td><td>${m.cpi.toFixed(2)}%</td><td>${fxText(m.fx)}</td><td>${sov.rating}</td></tr>`;
      }).join("") + `</tbody></table>`;
    $("changelogInner").innerHTML = html;
  }

  // ---- CSV export ----
  function csvEscape(v) { v = String(v == null ? "" : v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }
  function buildCSV() {
    let headers, rows, tag;
    if (state.view === "ccy") {
      tag = "currencies";
      headers = ["Rank", "Currency", "Name", "Sovereign", "Policy%", "BestSafeRate%", "BestSafeInstrument", "TopYield%", "Inflation%", "FXvsUSD%/yr", "Real%", "Hard_vs_" + state.benchmark + "%", "CurrencyScore", "Overall"];
      rows = leagueSorted().map((r, i) => [i + 1, r.code, r.c.name, r.sov.rating, r.m.policyRate, r.safeY, r.bestSafe.name, r.topY, r.m.cpi, r.m.fx, r.real.toFixed(2), r.hard.toFixed(2), Math.round(r.ccyScore), Math.round(r.overall)]);
    } else {
      tag = state.ccy === "ALL" ? "all" : state.ccy;
      headers = ["Rank", "Instrument", "Issuer", "Currency", "Category", "Access", "Yield%", "Risk", "Rating", "Reputation", "Quality", "ErosionBase%", "TrueNet%", "AnnualIncome", "MonthlyIncome", "Liquidity", "AsOf", "Source"];
      rows = visibleRows().map((r, i) => { const it = r.it; return [i + 1, it.name, it.issuer, it.ccy, it.cat, accessOf(it), it.y, it.risk, it.rating, it.rep, Math.round(r.q), r.base.toFixed(2), r.net.toFixed(2), Math.round(r.annual), Math.round(r.monthly), it.liq, it.asOf, it.src]; });
    }
    const csv = [headers, ...rows].map((row) => row.map(csvEscape).join(",")).join("\r\n");
    return { filename: `fixed-income-${tag}-${(FIA.meta.asOf || "").replace(/\s/g, "")}.csv`, csv };
  }
  function exportCSV() {
    const { filename, csv } = buildCSV();
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }

  // ---- guided "find my best" wizard ----
  function renderWizard() {
    const sel = (id) => state.benchmark === id ? " selected" : "";
    const benchOpts = '<optgroup label="Currencies">' +
      Object.keys(CCY).map((c) => `<option value="${c}"${sel(c)}>${CCY[c].flag} ${c}${c === "CHF" ? " — strongest" : ""}</option>`).join("") +
      '</optgroup><optgroup label="Hard money (inflation-free)">' +
      `<option value="GOLD"${sel("GOLD")}>🥇 Gold</option><option value="BASKET"${sel("BASKET")}>⚖️ Hard-money basket</option></optgroup>`;
    const ccyOpts = `<option value="ALL">🌐 All currencies</option>` + Object.keys(CCY).map((c) => `<option value="${c}"${state.ccy === c ? " selected" : ""}>${CCY[c].flag} ${c}</option>`).join("");
    $("wizardInner").innerHTML = `<h3>✨ Find my best fixed income</h3>
      <p class="muted">Answer a few questions; we'll filter the universe to what you can actually buy and rank it by <strong>true return</strong> in your chosen yardstick.</p>
      <div class="wiz-grid">
        <label class="ctrl"><span class="ctrl-label">Measure my return in</span><select id="wzBench">${benchOpts}</select></label>
        <label class="ctrl"><span class="ctrl-label">Where can you buy?</span><select id="wzAccess">
          <option value="Global">🌍 Anywhere (global brokers)</option>
          <option value="Cross-border">🛂 + cross-border (specialist access)</option>
          <option value="all">🏠 Include residents-only</option></select></label>
        <label class="ctrl"><span class="ctrl-label">Risk appetite</span><select id="wzRisk">
          <option value="2">Conservative (safest, 1–2)</option>
          <option value="3" selected>Balanced (1–3)</option>
          <option value="9">Adventurous (all)</option></select></label>
        <label class="ctrl"><span class="ctrl-label">Currency focus</span><select id="wzCcy">${ccyOpts}</select></label>
        <label class="ctrl"><span class="ctrl-label">Amount</span><span class="amount-wrap"><span class="amount-sym">${(SYM[state.ccy] || "$").trim() || "$"}</span><input type="text" id="wzAmount" value="${new Intl.NumberFormat("en-US").format(state.amount)}"></span></label>
      </div>
      <div class="panel-actions"><button class="ghost-btn primary" id="wzApply">Show my shortlist →</button><span class="muted">Sets the benchmark, filters, and ranks by true (after-erosion) return.</span></div>`;
    $("wzApply").onclick = () => {
      state.benchmark = $("wzBench").value; LS.set("benchmark", state.benchmark);
      state.erosion = "real"; LS.set("erosion", "real");
      state.access.clear();
      const a = $("wzAccess").value;
      if (a === "Global") state.access.add("Global");
      else if (a === "Cross-border") { state.access.add("Global"); state.access.add("Cross-border"); }
      state.risks.clear();
      const rmax = +$("wzRisk").value;
      if (rmax < 9) for (let r = 1; r <= rmax; r++) state.risks.add(r);
      state.ccy = $("wzCcy").value; LS.set("ccy", state.ccy); state.cats.clear();
      const n = parseFloat($("wzAmount").value.replace(/[^0-9.]/g, "")) || state.amount;
      state.amount = n; LS.set("amount", n);
      state.view = "inst"; LS.set("view", "inst");
      state.rankBy = "net"; LS.set("rankBy", "net"); applyRankPreset();
      $("wizardPanel").hidden = true;
      $("rankBy").value = "net"; $("erosion").value = "real"; $("benchmark").value = state.benchmark;
      $("amount").value = new Intl.NumberFormat("en-US").format(state.amount);
      syncToggle(); renderAll();
    };
  }

  // ---- portfolio blender ----
  function updatePortCount() {
    const b = $("portfolioBtn");
    if (b) b.textContent = state.portfolio.length ? `🧺 Portfolio (${state.portfolio.length})` : "🧺 Portfolio";
  }
  function togglePort(key) {
    const i = state.portfolio.findIndex((p) => p.key === key);
    if (i >= 0) state.portfolio.splice(i, 1); else state.portfolio.push({ key, w: 0 });
    const n = state.portfolio.length;
    state.portfolio.forEach((p) => p.w = n ? Math.round(100 / n) : 0); // equalise on add/remove
    LS.set("portfolio", state.portfolio);
    render();
    if (!$("portfolioPanel").hidden) renderPortfolio();
  }
  function renderPortfolio() {
    const lines = state.portfolio.map((p) => INSTR_BY_KEY[p.key] ? { p, it: INSTR_BY_KEY[p.key] } : null).filter(Boolean);
    if (!lines.length) {
      $("portfolioInner").innerHTML = `<h3>🧺 Portfolio blender</h3><p class="muted">Click <strong>+ Port</strong> on any instrument row to build a blend. You'll see the weighted yield, true return (in your chosen benchmark) and income.</p>`;
      return;
    }
    const sumW = lines.reduce((s, x) => s + (+x.p.w || 0), 0) || 1;
    const erosName = state.erosion === "cpi" ? "after inflation" : state.erosion === "fx" ? "vs " + bmName() : "real, vs " + bmName();
    let gY = 0, net = 0, risk = 0, q = 0;
    lines.forEach((x) => { const w = (+x.p.w || 0) / sumW; gY += w * x.it.y; net += w * netReal(x.it); risk += w * x.it.risk; q += w * quality(x.it); });
    const ccys = [...new Set(lines.map((x) => x.it.ccy))];
    const single = ccys.length === 1 ? ccys[0] : null;
    const rowsHtml = lines.map((x, idx) => {
      const it = x.it, w = +x.p.w || 0, inc = state.amount * (w / sumW) * it.y / 100;
      return `<tr><td class="lft">${it.name}<div class="inst-sub">${it.ccy} · ${it.cat}</div></td>
        <td>${it.y.toFixed(2)}%</td>
        <td><input class="port-w" data-i="${idx}" type="number" min="0" step="5" value="${w}">%</td>
        <td class="${netReal(it) >= 0 ? "net-pos" : "net-neg"}">${pct(netReal(it))}</td>
        <td>${money(inc, it.ccy)}/yr</td>
        <td><button class="port-del" data-key="${x.p.key}" title="remove">✕</button></td></tr>`;
    }).join("");
    const totalIncome = single
      ? `${money(state.amount * gY / 100, single)}/yr · ${money(state.amount * gY / 100 / 12, single)}/mo`
      : `<span class="muted">mixed currencies — see per-line</span>`;
    $("portfolioInner").innerHTML = `<h3>🧺 Portfolio blender <span class="muted" style="font-weight:400">· ${lines.length} holdings · ${money(state.amount, single || state.ccy)} notional</span></h3>
      <table class="port-table"><thead><tr><th class="lft">Instrument</th><th>Yield</th><th>Weight</th><th>True net (${erosName})</th><th>Income</th><th></th></tr></thead><tbody>${rowsHtml}</tbody></table>
      <div class="port-sum">
        <div><div class="k">Blended yield</div><div class="v">${gY.toFixed(2)}%</div></div>
        <div><div class="k">Blended true net</div><div class="v ${net >= 0 ? "net-pos" : "net-neg"}">${pct(net)}</div></div>
        <div><div class="k">Weighted risk</div><div class="v">${risk.toFixed(1)}/5</div></div>
        <div><div class="k">Quality</div><div class="v">${Math.round(q)}</div></div>
        <div><div class="k">Total income</div><div class="v" style="font-size:15px">${totalIncome}</div></div>
        <div><div class="k">Weights sum</div><div class="v ${Math.abs(sumW - 100) < 0.5 ? "" : "net-neg"}">${sumW.toFixed(0)}%</div></div>
      </div>
      <div class="panel-actions"><button class="ghost-btn" id="portEqual">Equalise</button><button class="ghost-btn" id="portClear">Clear all</button><button class="ghost-btn" id="portCsv">⬇ Export portfolio</button><span class="muted">${ccys.length} currenc${ccys.length === 1 ? "y" : "ies"} · metrics use normalised weights &amp; the current benchmark/FX basis.</span></div>`;
    $("portfolioInner").querySelectorAll(".port-w").forEach((inp) => inp.onchange = () => { state.portfolio[+inp.dataset.i].w = +inp.value || 0; LS.set("portfolio", state.portfolio); renderPortfolio(); });
    $("portfolioInner").querySelectorAll(".port-del").forEach((b) => b.onclick = () => togglePort(b.dataset.key));
    $("portEqual").onclick = () => { const n = state.portfolio.length; state.portfolio.forEach((p) => p.w = n ? Math.round(100 / n) : 0); LS.set("portfolio", state.portfolio); renderPortfolio(); render(); };
    $("portClear").onclick = () => { state.portfolio = []; LS.set("portfolio", []); renderPortfolio(); render(); };
    $("portCsv").onclick = exportPortfolioCSV;
  }
  function exportPortfolioCSV() {
    const lines = state.portfolio.map((p) => INSTR_BY_KEY[p.key] ? { it: INSTR_BY_KEY[p.key], w: +p.w || 0 } : null).filter(Boolean);
    if (!lines.length) return;
    const sumW = lines.reduce((s, x) => s + x.w, 0) || 1;
    const headers = ["Instrument", "Currency", "Category", "Weight%", "Yield%", "TrueNet%", "Income/yr"];
    const rows = lines.map((x) => [x.it.name, x.it.ccy, x.it.cat, x.w, x.it.y, netReal(x.it).toFixed(2), Math.round(state.amount * (x.w / sumW) * x.it.y / 100)]);
    const csv = [headers, ...rows].map((r) => r.map(csvEscape).join(",")).join("\r\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = "fixed-income-portfolio.csv"; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }

  // ---- amount input / controls ----
  function syncAmountSym() {
    $("amountSym").textContent = (state.view === "ccy" || state.ccy === "ALL") ? "⨎" : ((SYM[state.ccy] || "$").trim() || "$");
  }
  function syncToggle() {
    $("viewToggle").querySelectorAll("button").forEach((b) => b.classList.toggle("active", b.dataset.view === state.view));
  }
  function updateControlVis() {
    document.body.classList.toggle("erosion-cpi", state.erosion === "cpi");
  }
  function bindControls() {
    const amt = $("amount");
    amt.value = new Intl.NumberFormat("en-US").format(state.amount);
    amt.addEventListener("input", () => {
      const n = parseFloat(amt.value.replace(/[^0-9.]/g, "")) || 0;
      state.amount = n; LS.set("amount", n);
      amt.value = n ? new Intl.NumberFormat("en-US").format(n) : "";
      render();
    });
    $("rankBy").value = state.rankBy;
    $("rankBy").onchange = () => { state.rankBy = $("rankBy").value; LS.set("rankBy", state.rankBy); applyRankPreset(); render(); renderHead(); };
    $("erosion").value = state.erosion;
    $("erosion").onchange = () => {
      state.erosion = $("erosion").value; LS.set("erosion", state.erosion); updateControlVis();
      if (state.view === "ccy") render(); else { renderHead(); render(); }
    };
    const benchSel = $("benchmark");
    benchSel.innerHTML =
      '<optgroup label="Currencies">' +
      Object.keys(CCY).map((c) => `<option value="${c}">${CCY[c].flag} ${c}${c === "CHF" ? " — strongest" : ""}</option>`).join("") +
      '</optgroup><optgroup label="Hard money (inflation-free)">' +
      '<option value="GOLD">🥇 Gold (XAU)</option>' +
      '<option value="BASKET">⚖️ Hard-money basket</option>' +
      '</optgroup>';
    benchSel.value = state.benchmark;
    benchSel.onchange = () => {
      state.benchmark = benchSel.value; LS.set("benchmark", state.benchmark);
      if (state.view === "ccy") render(); else { renderHead(); render(); }
    };
    const fxSel = $("fxBasis");
    fxSel.value = state.fxBasis;
    fxSel.onchange = () => {
      state.fxBasis = fxSel.value; LS.set("fxBasis", state.fxBasis);
      if (state.view === "ccy") render(); else { renderHead(); render(); }
    };
    $("search").oninput = () => { state.search = $("search").value; render(); };

    $("viewToggle").querySelectorAll("button").forEach((b) => b.onclick = () => {
      state.view = b.dataset.view; LS.set("view", state.view); syncToggle(); renderAll();
    });

    const panels = { methodBtn: "methodPanel", aboutBtn: "aboutPanel", changelogBtn: "changelogPanel", findBtn: "wizardPanel", portfolioBtn: "portfolioPanel" };
    const closeAll = (except) => Object.values(panels).forEach((p) => { if (p !== except) $(p).hidden = true; });
    $("methodBtn").onclick = () => { const p = $("methodPanel"); p.hidden = !p.hidden; if (!p.hidden) { closeAll("methodPanel"); renderSliders(); } };
    $("aboutBtn").onclick = () => { const p = $("aboutPanel"); p.hidden = !p.hidden; if (!p.hidden) { closeAll("aboutPanel"); renderAbout(); } };
    $("changelogBtn").onclick = () => { const p = $("changelogPanel"); p.hidden = !p.hidden; if (!p.hidden) { closeAll("changelogPanel"); renderChangelog(); } };
    $("findBtn").onclick = () => { const p = $("wizardPanel"); p.hidden = !p.hidden; if (!p.hidden) { closeAll("wizardPanel"); renderWizard(); } };
    $("exportBtn").onclick = exportCSV;
    $("portfolioBtn").onclick = () => { const p = $("portfolioPanel"); p.hidden = !p.hidden; if (!p.hidden) { closeAll("portfolioPanel"); renderPortfolio(); } };
    $("resetWeights").onclick = () => { state.weights = Object.assign({}, FIA.weights); LS.set("weights", state.weights); renderSliders(); render(); };

    $("disclaimerText").textContent = FIA.meta.disclaimer;
    if (LS.get("discDismissed", false)) $("disclaimer").style.display = "none";
    $("dismissDisc").onclick = () => { $("disclaimer").style.display = "none"; LS.set("discDismissed", true); };
    $("asOfLabel").textContent = "data as of " + FIA.meta.asOf;
  }
  const RANK_MAP = {
    best: { key: "q", dir: "desc" }, yield: { key: "y", dir: "desc" },
    net: { key: "net", dir: "desc" }, monthly: { key: "monthly", dir: "desc" },
    safest: { key: "risk", dir: "asc" },
  };
  function applyRankPreset() { if (RANK_MAP[state.rankBy]) state.sort = Object.assign({}, RANK_MAP[state.rankBy]); }

  // ---- master render ----
  function render() {
    syncAmountSym();
    updatePortCount();
    if (state.view === "ccy") { renderLeague(); return; }
    const rows = visibleRows();
    renderHighlights(rows);
    renderTable(rows);
  }
  function renderAll() {
    document.body.classList.toggle("view-ccy", state.view === "ccy");
    updateControlVis();
    renderTabs(); renderChips();
    if (state.view === "ccy") { render(); }
    else { renderMacro(); renderHead(); render(); }
  }

  // ---- boot ----
  applyRankPreset();
  bindControls();
  syncToggle();
  renderAll();
})();
