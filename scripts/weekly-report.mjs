#!/usr/bin/env node
/**
 * 週報產生器（GitHub Actions 每週五台北 15:00 執行）
 *
 * 讀取 data/*.json（holdings/prices/history/snapshots/cash/settings/realized），
 * 組出詳細文字週報並寄送 email。
 *
 * 寄送：Resend API（環境變數 RESEND_API_KEY）。未設定時印出報告內容（dry run）。
 * 券商分點：選配。settings.report.brokerMonitorRaw 有設定時才抓取並產生該節。
 * 語言邊界：所有內容皆為數據呈現與「使用者自訂規則」的觸發通知，不構成投資建議。
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(ROOT, 'data');
const YEAR = new Date().getFullYear();
const JAN1 = `${YEAR}-01-01`;

const readJSON = f => JSON.parse(readFileSync(join(DATA, f), 'utf8'));
const todayStr = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' });
const fmt = n => Math.round(n).toLocaleString('en-US');
const pct = (n, d = 1) => `${n >= 0 ? '+' : ''}${n.toFixed(d)}%`;

// ── 載入資料 ──
const settings = readJSON('settings.json');
// 券商分點監控（選配整合）：設定 report.brokerMonitorRaw（raw JSON base URL）才啟用
const BROKER_RAW = settings.report?.brokerMonitorRaw || null;
const BROKER_SITE = settings.report?.brokerMonitorUrl || null;
const DASHBOARD_URL = settings.report?.dashboardUrl || null;
const holdings = readJSON('holdings.json');
const pricesFile = readJSON('prices.json');
const misc = readJSON('misc.json');
const cash = readJSON('cash.json');
const realized = existsSync(join(DATA, 'realized.json')) ? readJSON('realized.json') : null;
const hist = existsSync(join(DATA, 'history', `prices-${YEAR}.json`))
  ? JSON.parse(readFileSync(join(DATA, 'history', `prices-${YEAR}.json`), 'utf8')) : {};
const snaps = existsSync(join(DATA, 'snapshots', `${YEAR}.jsonl`))
  ? readFileSync(join(DATA, 'snapshots', `${YEAR}.jsonl`), 'utf8').split('\n').filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
      .sort((a, b) => a.date.localeCompare(b.date))
  : [];

const positions = holdings.positions || [];
const prices = pricesFile.prices || {};
const fx = pricesFile.usdTwd || 32;
const isUS = p => p.market === 'us' || p.currency === 'USD';
const rawPrice = p => prices[p.stockCode]?.price ?? p.currentPrice ?? p.avgCost;
const valTWD = p => p.shares * rawPrice(p) * (isUS(p) ? fx : 1);
const costTWD = p => p.shares * p.avgCost * (isUS(p) ? fx : 1);
const retPct = p => p.avgCost > 0 ? (rawPrice(p) - p.avgCost) / p.avgCost * 100 : 0;
const open = positions.filter(p => !p.closed);
const firstBuy = p => (p.transactions || []).filter(t => t.action === 'buy').map(t => t.date).sort()[0] || null;
const sharesOn = (p, d) => {
  if (!p.transactions?.length) return p.shares;
  let sh = 0;
  for (const t of p.transactions) { if (t.date > d) continue; sh += t.action === 'buy' ? t.shares : -t.shares; }
  return Math.max(0, sh);
};

// ── TWR ──
function buildTWR(posList, benchDates) {
  const dec31 = `${YEAR - 1}-12-31`;
  const txDates = new Set();
  posList.forEach(p => (p.transactions || []).forEach(t => { if (t.date >= JAN1) txDates.add(t.date); }));
  const bounds = [dec31, ...[...txDates].sort()];
  const priceAt = (p, d) => {
    const s = hist[p.stockCode]; if (!s?.length) return null;
    const e = [...s].reverse().find(x => x.date <= d);
    return e ? e.close : null;
  };
  const subs = bounds.map(sd => {
    let sv = 0; const shm = {};
    posList.forEach(p => { const sh = sharesOn(p, sd); shm[p.id] = sh; if (sh > 0) { const pr = priceAt(p, sd); if (pr) sv += sh * pr; } });
    return { sd, sv, shm };
  });
  if (!subs.some(s => s.sv > 0)) return null;
  const endVal = k => {
    if (k >= bounds.length - 1) return null;
    let v = 0;
    posList.forEach(p => { const sh = subs[k].shm[p.id]; if (!sh) return; const pr = priceAt(p, bounds[k + 1]) ?? priceAt(p, subs[k].sd); if (pr) v += sh * pr; });
    return v;
  };
  return benchDates.map(d => {
    let pi = bounds.length - 1;
    for (let k = 0; k < bounds.length - 1; k++) if (d <= bounds[k + 1]) { pi = k; break; }
    let chain = 1;
    for (let k = 0; k < pi; k++) { if (subs[k].sv <= 0) continue; const ev = endVal(k); if (ev > 0) chain *= ev / subs[k].sv; }
    const cur = subs[pi];
    if (cur.sv <= 0) return (chain - 1) * 100;
    let v = 0;
    posList.forEach(p => { const sh = cur.shm[p.id]; if (!sh) return; const pr = priceAt(p, d) ?? priceAt(p, cur.sd); if (pr > 0) v += sh * pr; });
    return v > 0 ? (chain * (v / cur.sv) - 1) * 100 : (chain - 1) * 100;
  });
}
const ytdOf = (posList, benchKey) => {
  const bench = (hist[benchKey] || []).filter(x => x.date >= JAN1);
  if (!bench.length) return null;
  const s = buildTWR(posList, bench.map(x => x.date));
  return s ? s.filter(v => v != null).pop() : null;
};
const benchYTD = key => {
  const all = hist[key] || [];
  const base = [...all].reverse().find(x => x.date < JAN1)?.close;
  const last = all[all.length - 1]?.close;
  return base && last ? (last - base) / base * 100 : null;
};

// ══════════ 1. 本週摘要 ══════════
const investNow = open.reduce((s, p) => s + valTWD(p), 0);
const sortedCash = [...(cash.snapshots || [])].sort((a, b) => b.date.localeCompare(a.date));
const latestCash = sortedCash[0];
const cashNow = latestCash ? (latestCash.accounts ? Object.values(latestCash.accounts).reduce((s, v) => s + (+v || 0), 0) : latestCash.cash || 0) : 0;
const totalNow = investNow + cashNow;
const weekAgo = new Date(Date.now() - 7 * 86400000).toLocaleDateString('sv-SE');
const baseSnap = [...snaps].reverse().find(s => s.date <= weekAgo) ||
  (snaps.length && snaps[0].date < todayStr() ? snaps[0] : null);   // 基準必須早於今天，避免 +$0 假變化
const weekDiff = baseSnap ? investNow - baseSnap.totalValue : null;
const weekPct = baseSnap?.totalValue > 0 ? weekDiff / baseSnap.totalValue * 100 : null;

const twPos = positions.filter(p => !isUS(p) && p.market !== 'gold' && /^[0-9A-Za-z.]+$/.test(p.stockCode || ''));
const usPos = positions.filter(p => isUS(p));
const twYTD = ytdOf(twPos, '^TWII'), taiexYTD = benchYTD('^TWII');
const usYTD = ytdOf(usPos, 'VTI'), vtiYTD = benchYTD('VTI');

// ══════════ 2. 需要注意（L2 規則）══════════
const rules = settings.swingRules || {};
const alerts = [];
const investTotal = investNow;
open.forEach(p => {
  const ret = retPct(p), v = valTWD(p), price = rawPrice(p);
  const isSwing = p.type === '短期';
  const series = hist[p.stockCode] || [];
  const info = prices[p.stockCode] || {};
  if (isSwing && ret <= (rules.stopLossPct ?? -20))
    alerts.push({ sev: '🔴', text: `${p.stockName}：報酬 ${pct(ret)}，觸發你設定的停損線 ${rules.stopLossPct}%。` });
  else if (isSwing && ret >= (rules.takeProfitPct ?? 20))
    alerts.push({ sev: '🟡', text: `${p.stockName}：報酬 ${pct(ret)}，已達你設定的停利線 +${rules.takeProfitPct}%。` });
  if (isSwing) {
    const fb = firstBuy(p);
    if (fb) {
      const months = (Date.now() - new Date(fb + 'T00:00:00')) / (30.44 * 86400000);
      if (months >= (rules.timeStopMonths ?? 6) && Math.abs(ret) <= 5)
        alerts.push({ sev: '🟡', text: `${p.stockName}：持有 ${Math.floor(months)} 個月、報酬 ${pct(ret)}，超過 ${rules.timeStopMonths} 個月時間停損檢視點。` });
    }
  }
  if (investTotal > 0 && v / investTotal * 100 > (settings.concentrationAlert ?? 20))
    alerts.push({ sev: '🟡', text: `${p.stockName} 佔投資部位 ${(v / investTotal * 100).toFixed(1)}%，超過集中度上限 ${settings.concentrationAlert}%。` });
  if (info.low52 > 0 && price <= info.low52 * 1.005)
    alerts.push({ sev: '🟡', text: `${p.stockName} 貼近 52 週低點（現價 ${price.toFixed(2)} / 低點 ${info.low52.toFixed(2)}）。` });
  if (!isSwing && series.length) {
    const byWeek = {};
    for (const pt of series) {
      const d = new Date(pt.date + 'T00:00:00');
      const th = new Date(d); th.setDate(d.getDate() + (4 - (d.getDay() || 7)));
      const wk = Math.ceil((((th - new Date(th.getFullYear(), 0, 1)) / 86400000) + 1) / 7);
      byWeek[`${th.getFullYear()}-${String(wk).padStart(2, '0')}`] = pt.close;
    }
    const closes = Object.keys(byWeek).sort().map(k => byWeek[k]);
    if (closes.length >= 20) {
      const ma = closes.slice(-20).reduce((s, v2) => s + v2, 0) / 20;
      if (price < ma * 0.995)
        alerts.push({ sev: '🟡', text: `${p.stockName} 跌破 20 週均線（現價 ${price.toFixed(2)} < 均線 ${ma.toFixed(2)}），長線趨勢轉弱參考訊號。` });
    }
  }
});
// 配置偏離（現金分為保留金/機動現金；機動現金才拿來跟目標比較）
const tgt = settings.targetAllocation;
const reserveTarget = Math.max(0, (settings.reserve?.emergencyFund ?? 0) + (misc.monthlyExpense ?? 0) * 6);
const reserveNow = Math.min(cashNow, reserveTarget);
const investableCash = Math.max(0, cashNow - reserveNow);
let core = 0, swing = 0;
open.forEach(p => { const v = valTWD(p); p.type === '短期' ? swing += v : core += v; });
const allocTotal = core + swing + cashNow;   // 保留金仍算在總資產內，百分比才會加總=100%
const allocRows = tgt && allocTotal > 0 ? [
  { label: tgt.core.label, act: core / allocTotal * 100, tgt: tgt.core.pct },
  { label: tgt.swing.label, act: swing / allocTotal * 100, tgt: tgt.swing.pct },
  { label: tgt.cash.label, act: investableCash / allocTotal * 100, tgt: tgt.cash.pct },
  { label: '保留金（備用金）', act: reserveNow / allocTotal * 100, tgt: null },
] : [];
const drifted = allocRows.filter(r => r.tgt != null && Math.abs(r.act - r.tgt) > (settings.allocationDriftAlert ?? 10));
if (drifted.length)
  alerts.push({ sev: '🟡', text: `資產配置偏離目標超過 ±${settings.allocationDriftAlert}pp：${drifted.map(r => `${r.label} ${pct(r.act - r.tgt, 1).replace('%', 'pp')}`).join('、')}——可考慮再平衡。` });
alerts.sort((a, b) => (a.sev === '🔴' ? 0 : 1) - (b.sev === '🔴' ? 0 : 1));

// ══════════ 4. 績效歸因 ══════════
const byName = {};
(realized?.trades || []).filter(t => t.sellDate >= JAN1).forEach(t => { byName[t.name] = (byName[t.name] || 0) + (t.pnlTWD ?? t.pnl); });
open.forEach(p => { byName[p.stockName] = (byName[p.stockName] || 0) + (valTWD(p) - costTWD(p)); });
const perPos = Object.entries(byName).map(([name, pnl]) => ({ name, pnl: Math.round(pnl) })).sort((a, b) => b.pnl - a.pnl);
const top3 = perPos.slice(0, 3), bot3 = perPos.slice(-3).reverse().filter(x => x.pnl < 0);

const trades = (realized?.trades || []).filter(t => t.sellDate >= JAN1)
  .map(t => ({ ...t, pnl: t.pnlTWD ?? t.pnl }));   // 統一以 TWD 計
const wins = trades.filter(t => t.pnl > 0), losses = trades.filter(t => t.pnl <= 0);
const winRate = trades.length ? wins.length / trades.length * 100 : null;
const avgWin = wins.length ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0;
const avgLoss = losses.length ? Math.abs(losses.reduce((s, t) => s + t.pnl, 0) / losses.length) : 0;
const pf = losses.length && avgLoss > 0 ? wins.reduce((s, t) => s + t.pnl, 0) / Math.abs(losses.reduce((s, t) => s + t.pnl, 0)) : null;
// 本週已實現
const weekTrades = trades.filter(t => t.sellDate > weekAgo);
const weekRealized = weekTrades.reduce((s, t) => s + t.pnl, 0);
// 最大回撤
let mdd = null, curDD = null;
{
  const dates = (hist['^TWII'] || []).filter(x => x.date >= JAN1).map(x => x.date);
  const closeAt = (c, d) => { const s = hist[c]; if (!s) return null; const e = [...s].reverse().find(x => x.date <= d); return e ? e.close : null; };
  const series = dates.map(d => {
    let v = 0;
    positions.forEach(p => {
      if (!/^[0-9A-Za-z.]+$/.test(p.stockCode || '')) return;
      const sh = sharesOn(p, d); if (sh <= 0) return;
      const c = closeAt(p.stockCode, d); if (c) v += sh * c * (isUS(p) ? fx : 1);
    });
    return v;
  }).filter(v => v > 0);
  if (series.length > 10) {
    let peak = series[0]; mdd = 0;
    for (const v of series) { if (v > peak) peak = v; const dd = (v - peak) / peak * 100; if (dd < mdd) mdd = dd; curDD = dd; }
  }
}
// 短線 vs 大盤
const swingPos = twPos.filter(p => p.type !== '長期' && p.type !== 'ETF');
const swingYTD = ytdOf(swingPos, '^TWII');

// ══════════ 5. 券商分點觀察 ══════════
// 金額單位：broker-monitor 的 buy/sell/net 為千元
const fmtWan = qianYuan => {
  const yi = qianYuan / 100000;   // 千元 → 億
  if (Math.abs(yi) >= 1) return `${yi.toFixed(1)} 億`;
  return `${fmt(qianYuan / 10)} 萬`;  // 千元 → 萬
};

async function brokerSection() {
  if (!BROKER_RAW) return null;   // 未設定券商分點來源 → 整節略過
  try {
    // 抓最近 7 個日曆日內的檔案（約 5 個交易日）
    const files = [];
    for (let i = 0; i < 8; i++) {
      const d = new Date(Date.now() - i * 86400000);
      files.push(d.toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' }).replace(/-/g, ''));
    }
    const days = [];
    for (const f of files) {
      try {
        const r = await fetch(`${BROKER_RAW}/${f}.json`);
        if (r.ok) days.push(await r.json());
      } catch {}
    }
    if (!days.length) return { html: '<p style="color:#888;">本週無分點資料。</p>', hits: 0 };
    // 按 ticker 彙總各分點淨買超（千元）+ 建立 ticker→名稱對照
    const agg = {};   // ticker → {name, net, branches:{branch:net}}
    days.forEach(day => {
      Object.entries(day.branches || {}).forEach(([branch, rows]) => {
        rows.forEach(r => {
          if (!agg[r.ticker]) agg[r.ticker] = { name: r.name, net: 0, branches: {} };
          agg[r.ticker].net += r.net;
          agg[r.ticker].branches[branch] = (agg[r.ticker].branches[branch] || 0) + r.net;
        });
      });
    });
    const heldCodes = new Set(open.map(p => (p.stockCode || '').toUpperCase()));

    // ── A. 持股動向 ──
    const heldHits = Object.entries(agg)
      .filter(([tk]) => heldCodes.has(tk.toUpperCase()))
      .map(([tk, a]) => {
        const top = Object.entries(a.branches).sort((x, y) => Math.abs(y[1]) - Math.abs(x[1])).slice(0, 3)
          .map(([b, n]) => `${b} ${n >= 0 ? '買超' : '賣超'} ${fmtWan(Math.abs(n))}`).join('、');
        return `<li><strong>${a.name}（${tk}）</strong>：合計${a.net >= 0 ? '買超' : '賣超'} <strong>${fmtWan(Math.abs(a.net))}</strong>。${top}。</li>`;
      });

    // ── B. 囤貨追蹤：未建倉但分點正在吸籌的標的（來自 hoard_scores.json，囤貨分數引擎）──
    // 分數為 broker-monitor 的 14 日囤貨分數（持續性/逆勢買/隱蔽性/吸籌力/成本乖離，0~100）
    let hoardHtml = '';
    try {
      const r = await fetch(`${BROKER_RAW}/hoard_scores.json`);
      if (r.ok) {
        const hs = await r.json();
        const dates = Object.keys(hs).sort();
        const latestKey = dates[dates.length - 1];
        const prevKey = dates.length > 1 ? dates[dates.length - 2] : null;
        const latest = hs[latestKey] || [];
        const prevSet = new Set((prevKey ? hs[prevKey] : []).map(x => `${x.branch}|${x.ticker}`));
        // 按 ticker 分組：共囤分點數、最高分、是否新進榜、近週分點合計買超
        const byTicker = {};
        latest.forEach(x => {
          if (!byTicker[x.ticker]) byTicker[x.ticker] = { branches: [], maxScore: 0, isNew: false };
          const t = byTicker[x.ticker];
          t.branches.push({ branch: x.branch, score: x.score });
          t.maxScore = Math.max(t.maxScore, x.score);
          // 只有存在前一日資料時才判斷新進榜（避免首日全部誤標 NEW）
          if (prevKey && !prevSet.has(`${x.branch}|${x.ticker}`)) t.isNew = true;
        });
        const rows = Object.entries(byTicker)
          .map(([tk, t]) => ({
            tk, ...t,
            held: heldCodes.has(tk.toUpperCase()),
            name: agg[tk]?.name || tk,
            weekNet: agg[tk]?.net ?? null,
          }))
          .sort((a, b) => (b.branches.length - a.branches.length) || (b.maxScore - a.maxScore));

        const notHeld = rows.filter(r2 => !r2.held);
        const heldToo = rows.filter(r2 => r2.held);

        const rowHtml = r2 => {
          const pills = [];
          if (r2.isNew) pills.push('<span style="background:#dc2626;color:#fff;border-radius:4px;padding:1px 6px;font-size:11px;font-weight:700;">NEW</span>');
          if (r2.branches.length >= 2) pills.push(`<span style="background:#2563eb;color:#fff;border-radius:4px;padding:1px 6px;font-size:11px;font-weight:700;">${r2.branches.length}點共囤</span>`);
          const brs = r2.branches.sort((a, b) => b.score - a.score)
            .map(b => `${b.branch}（${Math.round(b.score)}分）`).join('、');
          return `<li style="margin-bottom:6px;"><strong>${r2.name}（${r2.tk}）</strong> ${pills.join(' ')}<br>
            <span style="font-size:13px;">囤貨分點：${brs}${r2.weekNet != null ? `；本週監控分點合計${r2.weekNet >= 0 ? '買超' : '賣超'} ${fmtWan(Math.abs(r2.weekNet))}` : ''}</span></li>`;
        };

        if (notHeld.length) {
          hoardHtml += `<p style="font-weight:700;margin:14px 0 4px;">🎯 未建倉囤貨標的（分點吸籌中、你目前未持有）</p>
            <ul style="margin:6px 0;padding-left:20px;line-height:1.7;">${notHeld.slice(0, 8).map(rowHtml).join('')}</ul>`;
        }
        if (heldToo.length) {
          hoardHtml += `<p style="font-weight:700;margin:14px 0 4px;">📌 持股中亦在囤貨榜</p>
            <ul style="margin:6px 0;padding-left:20px;line-height:1.7;">${heldToo.map(rowHtml).join('')}</ul>`;
        }
        if (!notHeld.length && !heldToo.length) hoardHtml = '<p style="color:#888;">囤貨榜目前無達標配對。</p>';
        hoardHtml += `<p style="font-size:11px;color:#94a3b8;">囤貨分數（0-100）＝券商分點監控系統以 14 個交易日的買超持續性、逆勢買進、隱蔽性、吸籌力、成本乖離計算；資料僅含各分點「買超榜」，吃貨量為上限估計。NEW＝最近一個交易日新進榜。</p>`;
      }
    } catch (e) { hoardHtml = `<p style="color:#888;">囤貨資料讀取失敗（${e.message}）。</p>`; }

    return {
      html: `<p style="font-weight:700;margin:4px 0;">📊 持股動向（近 ${days.length} 個交易日）</p>` +
        (heldHits.length
          ? `<ul style="margin:6px 0;padding-left:20px;line-height:1.8;">${heldHits.join('')}</ul>`
          : '<p style="color:#888;">目前持股在監控分點中本週無顯著進出。</p>') +
        hoardHtml +
        `<p style="font-size:12px;color:#888;">資料來源：${BROKER_SITE ? `<a href="${BROKER_SITE}">券商分點監控</a>` : '券商分點監控'}。以上為籌碼事實陳述，非買賣建議。</p>`,
      hits: heldHits.length,
    };
  } catch (e) { return { html: `<p style="color:#888;">分點資料讀取失敗（${e.message}）。</p>`, hits: 0 }; }
}

// ══════════ 6. 待辦 ══════════
const cashDays = latestCash ? Math.floor((Date.now() - new Date(latestCash.date + 'T00:00:00')) / 86400000) : null;
const todos = [];
if (cashDays === null || cashDays > 7) todos.push(`現金記錄已 ${cashDays ?? '—'} 天未更新（上次 ${latestCash?.date ?? '無'}），本週記得記一筆。`);
if ((pricesFile.failures || []).length) todos.push(`以下股票連續抓價失敗，請檢查代碼：${pricesFile.failures.join('、')}`);

// ══════════ 組報告 ══════════
const html = async () => {
  const broker = await brokerSection();
  const sec = (title, body) => `<h2 style="font-size:16px;border-bottom:2px solid #e2e8f0;padding-bottom:6px;margin:24px 0 10px;">${title}</h2>${body}`;
  const kv = (k, v) => `<tr><td style="padding:4px 12px 4px 0;color:#64748b;">${k}</td><td style="padding:4px 0;font-weight:700;">${v}</td></tr>`;
  const money = n => `${n >= 0 ? '+' : '−'}$${fmt(Math.abs(n))}`;

  return `<div style="font-family:-apple-system,'PingFang TC','Microsoft JhengHei',sans-serif;max-width:640px;margin:0 auto;color:#0f172a;font-size:14px;line-height:1.7;">
  <h1 style="font-size:20px;">📊 投資週報 — ${todayStr()}</h1>

  ${sec('一、本週摘要', `<table style="border-collapse:collapse;">
    ${kv('總資產（投資＋現金）', `$${fmt(totalNow)}`)}
    ${kv('投資部位', `$${fmt(investNow)}`)}
    ${kv('現金總額', `$${fmt(cashNow)}（${latestCash?.date ?? '無記錄'}）`)}
    ${kv('　├ 機動現金（可投資）', `$${fmt(investableCash)}`)}
    ${kv('　└ 保留金（備用金）', `$${fmt(reserveNow)}`)}
    ${weekDiff != null ? kv(`本週投資變化（vs ${baseSnap.date}）`, `${money(weekDiff)}（${pct(weekPct)}）`) : ''}
    ${weekTrades.length ? kv('本週已實現損益', `${money(weekRealized)}（${weekTrades.length} 筆）`) : ''}
    ${twYTD != null ? kv('台股持倉 YTD（TWR）', `${pct(twYTD)}，加權指數 ${pct(taiexYTD ?? 0)}，超額 ${pct(twYTD - (taiexYTD ?? 0))}`) : ''}
    ${usYTD != null ? kv('美股持倉 YTD（TWR）', `${pct(usYTD)}，VTI ${pct(vtiYTD ?? 0)}，超額 ${pct(usYTD - (vtiYTD ?? 0))}`) : ''}
  </table>`)}

  ${sec('二、需要注意（你設定的規則）', alerts.length
    ? `<ul style="margin:6px 0;padding-left:20px;line-height:1.9;">${alerts.map(a => `<li>${a.sev} ${a.text}</li>`).join('')}</ul>`
    : '<p style="color:#16a34a;font-weight:700;">✓ 本週沒有觸發任何規則，不需要做任何操作。</p>')}

  ${sec('三、組合健康度', `<table style="border-collapse:collapse;">
    ${allocRows.map(r => kv(r.label, r.tgt != null ? `${r.act.toFixed(1)}%（目標 ${r.tgt}%，偏離 ${pct(r.act - r.tgt, 1).replace('%', 'pp')}）` : `${r.act.toFixed(1)}%`)).join('')}
  </table>`)}

  ${sec('四、績效歸因（今年）', `
    <p><strong>獲利貢獻 Top 3：</strong>${top3.map(x => `${x.name} ${money(x.pnl)}`).join('、') || '—'}<br>
    <strong>拖累 Top 3：</strong>${bot3.map(x => `${x.name} ${money(x.pnl)}`).join('、') || '無虧損部位'}</p>
    <table style="border-collapse:collapse;">
    ${winRate != null ? kv(`已實現交易（${trades.length} 筆）`, `勝率 ${winRate.toFixed(0)}%、賺賠比 ${avgLoss > 0 ? (avgWin / avgLoss).toFixed(2) : '—'}、獲利因子 ${pf?.toFixed(2) ?? '—'}`) : ''}
    ${kv('累計已實現損益（台股）', money(realized?.totalPnlTW ?? misc.realizedPnlTW ?? 0))}
    ${realized?.totalPnlUS_TWD != null ? kv('累計已實現損益（美股）', `${money(realized.totalPnlUS_TWD)}（USD ${realized.totalPnlUS_USD >= 0 ? '+' : ''}${realized.totalPnlUS_USD}）`) : ''}
    ${mdd != null ? kv('今年最大回撤', `${mdd.toFixed(1)}%（目前回撤 ${curDD.toFixed(1)}%）`) : ''}
    ${swingYTD != null && taiexYTD != null ? kv('短線部位 vs 加權', `${pct(swingYTD)} vs ${pct(taiexYTD)}（${pct(swingYTD - taiexYTD, 1).replace('%', 'pp')}）`) : ''}
    </table>`)}

  ${broker ? sec('五、券商分點觀察（持股動向＋囤貨追蹤）', broker.html) : ''}

  ${sec(broker ? '六、本週待辦' : '五、本週待辦', todos.length
    ? `<ul style="margin:6px 0;padding-left:20px;">${todos.map(t => `<li>${t}</li>`).join('')}</ul>`
    : '<p style="color:#16a34a;">無待辦事項。</p>')}

  <p style="font-size:11px;color:#94a3b8;margin-top:28px;border-top:1px solid #e2e8f0;padding-top:10px;">
    本報告由 GitHub Actions 自動產生，內容為數據呈現與你自訂規則的觸發通知，不構成投資建議。${DASHBOARD_URL ? `<br>儀表板：<a href="${DASHBOARD_URL}">${DASHBOARD_URL.replace(/^https?:\/\//, '')}</a>` : ''}
  </p></div>`;
};

// ══════════ 寄送 ══════════
async function main() {
  const body = await html();
  const to = settings.report?.email;
  const key = process.env.RESEND_API_KEY;
  const subject = `📊 投資週報 ${todayStr()}｜總資產 $${fmt(totalNow)}${weekDiff != null ? `（本週 ${weekDiff >= 0 ? '+' : '−'}${fmt(Math.abs(weekDiff))}）` : ''}${alerts.some(a => a.sev === '🔴') ? '｜🔴 有規則觸發' : ''}`;

  if (!key) {
    console.log('=== DRY RUN（未設定 RESEND_API_KEY）===');
    console.log('收件人:', to, '\n主旨:', subject, '\n---\n');
    console.log(body.replace(/<[^>]+>/g, '').replace(/\n{3,}/g, '\n\n'));
    return;
  }
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: 'Weekly Report <onboarding@resend.dev>', to: [to], subject, html: body }),
  });
  const res = await r.json().catch(() => ({}));
  if (!r.ok) { console.error('寄送失敗:', r.status, JSON.stringify(res)); process.exit(1); }
  console.log('已寄送:', res.id ?? JSON.stringify(res));
}

main().catch(e => { console.error(e); process.exit(1); });
