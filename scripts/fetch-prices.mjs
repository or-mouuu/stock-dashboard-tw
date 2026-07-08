#!/usr/bin/env node
/**
 * 每日收盤價抓取腳本（GitHub Actions 執行，伺服器端直打、無 CORS 問題）
 *
 * 讀取  data/holdings.json    → 取得所有未清倉股票代碼
 * 寫入  data/prices.json      → 最新收盤價 + 漲跌幅 + 匯率
 * 寫入  data/history/prices-<年>.json → 逐日收盤序列（含 ^TWII、VTI 基準，按日期去重）
 * 寫入  data/snapshots/<年>.jsonl     → 每日資產快照（一行一天，同日覆寫）
 *
 * 資料來源優先序：
 *   台股 TSE  → TWSE STOCK_DAY → Yahoo <code>.TW
 *   台股 OTC  → TPEX st43 → TPEX OpenAPI ETF 行情 → Yahoo <code>.TWO
 *   美股/基準 → Yahoo Finance v8 chart
 *   黃金      → 台灣銀行黃金牌價（賣出價，元/公克）
 *   匯率      → Yahoo TWD=X
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(ROOT, 'data');
const YEAR = new Date().getFullYear();

const UA = { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' };

function todayStr() {
  // 以台北時間為準
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' });
}

async function fetchJSON(url, timeout = 15000) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeout);
    const r = await fetch(url, { headers: UA, signal: ctrl.signal });
    clearTimeout(t);
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

async function fetchText(url, timeout = 15000) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeout);
    const r = await fetch(url, { headers: UA, signal: ctrl.signal });
    clearTimeout(t);
    if (!r.ok) return null;
    return await r.text();
  } catch { return null; }
}

// ── TWSE 上市月度日成交 ──────────────────────────────
async function fetchTWSEMonthly(code, year, month) {
  const dateStr = `${year}${String(month).padStart(2, '0')}01`;
  const d = await fetchJSON(`https://www.twse.com.tw/exchangeReport/STOCK_DAY?response=json&date=${dateStr}&stockNo=${code}`);
  if (d?.stat !== 'OK' || !d.data?.length) return [];
  return d.data.map(r => {
    const parts = (r[0] || '').split('/');
    const close = parseFloat((r[6] || '').replace(/,/g, ''));
    if (parts.length === 3 && !isNaN(close) && close > 0)
      return { date: `${+parts[0] + 1911}-${parts[1].padStart(2, '0')}-${parts[2].padStart(2, '0')}`, close };
    return null;
  }).filter(Boolean);
}

// ── TPEX 上櫃月度日成交 ──────────────────────────────
async function fetchTPEXMonthly(code, year, month) {
  const rocDate = `${year - 1911}/${String(month).padStart(2, '0')}/01`;
  const d = await fetchJSON(`https://www.tpex.org.tw/web/stock/aftertrading/daily_trading_info/st43_result.php?l=zh-tw&d=${rocDate}&stkno=${code.toUpperCase()}`);
  if (!d?.aaData?.length) return [];
  return d.aaData.map(r => {
    const parts = (r[0] || '').split('/');
    const close = parseFloat((r[6] || '').replace(/,/g, ''));
    if (parts.length === 3 && !isNaN(close) && close > 0)
      return { date: `${+parts[0] + 1911}-${parts[1].padStart(2, '0')}-${parts[2].padStart(2, '0')}`, close };
    return null;
  }).filter(Boolean);
}

// ── Yahoo Finance（美股 / 基準 / 台股備援）─────────────
async function fetchYahoo(ticker, range = '10d') {
  for (const host of ['query1', 'query2']) {
    const d = await fetchJSON(`https://${host}.finance.yahoo.com/v8/finance/chart/${ticker}?range=${range}&interval=1d`);
    const res = d?.chart?.result?.[0];
    const ts = res?.timestamp, closes = res?.indicators?.quote?.[0]?.close;
    if (!ts || !closes) continue;
    const pts = ts.map((t, i) => ({
      date: new Date(t * 1000).toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' }),
      close: closes[i],
    })).filter(x => x.close > 0);
    if (pts.length) return pts;
  }
  return null;
}

async function fetchYahooLatest(ticker) {
  const pts = await fetchYahoo(ticker);
  if (!pts?.length) return null;
  const last = pts[pts.length - 1];
  const prev = pts.length >= 2 ? pts[pts.length - 2] : null;
  return {
    price: last.close,
    change: prev ? (last.close - prev.close) / prev.close * 100 : null,
    date: last.date,
  };
}

// ── 52 週統計：52週高/低點 + 一週前收盤（供週漲跌與距高點指標）──
async function fetchYearStats(ticker) {
  const pts = await fetchYahoo(ticker, '1y');
  if (!pts?.length) return null;
  const high52 = Math.max(...pts.map(x => x.close));
  const low52 = Math.min(...pts.map(x => x.close));
  const weekAgoDate = new Date(Date.now() - 7 * 86400000)
    .toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' });
  const older = pts.filter(x => x.date <= weekAgoDate);
  const weekAgo = older.length ? older[older.length - 1].close : pts[0].close;
  return { high52, low52, weekAgo };
}

// 台股代碼 → Yahoo ticker（實際掛牌可能與標記不符，兩種後綴都試）
async function resolveYearStats(code, market) {
  if (market === 'us') return await fetchYearStats(code);
  if (market === 'gold') return null;
  const suffixes = market === 'otc' ? ['.TWO', '.TW'] : ['.TW', '.TWO'];
  for (const sfx of suffixes) {
    const r = await fetchYearStats(code.toUpperCase() + sfx);
    if (r) return r;
  }
  return null;
}

// ── 台銀黃金牌價（元/公克，取賣出價）────────────────────
async function fetchGoldTWD() {
  const html = await fetchText('https://rate.bot.com.tw/gold?Lang=zh-TW');
  if (!html) return null;
  // 表格第一列第二欄為本行賣出價
  const m = html.match(/<td[^>]*>\s*([\d,]+(?:\.\d+)?)\s*<\/td>/g);
  if (!m) return null;
  for (const cell of m) {
    const v = parseFloat(cell.replace(/<[^>]+>/g, '').replace(/,/g, '').trim());
    if (!isNaN(v) && v > 1000 && v < 100000) return v;
  }
  return null;
}

// ── 個股最新價（依市場走對應來源鏈）────────────────────
async function fetchStock(code, market) {
  if (market === 'us') return await fetchYahooLatest(code);
  if (market === 'gold') {
    const p = await fetchGoldTWD();
    return p ? { price: p, change: null, date: todayStr() } : null;
  }
  // 台股：官方月度資料（本月，不足兩筆補上月）
  const now = new Date();
  const [yr, mo] = [now.getFullYear(), now.getMonth() + 1];
  const fetcher = market === 'otc' ? fetchTPEXMonthly : fetchTWSEMonthly;
  let rows = await fetcher(code, yr, mo);
  if (rows.length < 2) {
    const pmo = mo === 1 ? 12 : mo - 1, pyr = mo === 1 ? yr - 1 : yr;
    rows = [...await fetcher(code, pyr, pmo), ...rows];
  }
  if (rows.length) {
    const last = rows[rows.length - 1];
    const prev = rows.length >= 2 ? rows[rows.length - 2] : null;
    return { price: last.close, change: prev ? (last.close - prev.close) / prev.close * 100 : null, date: last.date };
  }
  // 備援：Yahoo 兩種後綴都試（有些股票的 market 標記與實際掛牌不符，
  // 例如 00981A 標記 otc 但實際為上市 .TW）
  const suffixes = market === 'otc' ? ['.TWO', '.TW'] : ['.TW', '.TWO'];
  for (const sfx of suffixes) {
    const r = await fetchYahooLatest(code.toUpperCase() + sfx);
    if (r?.price > 0) return r;
  }
  return null;
}

// ═══════════════════════════════════════════════════
async function main() {
  const holdings = JSON.parse(readFileSync(join(DATA, 'holdings.json'), 'utf8'));
  const positions = holdings.positions || [];
  if (!positions.length) {
    console.log('holdings.json 尚無持股（未遷移），跳過本次執行。');
    return;
  }

  // 未清倉股票代碼去重
  const codes = {};
  positions.filter(p => !p.closed && p.stockCode)
    .forEach(p => { codes[p.stockCode] = p.market || 'tse'; });

  const failures = [];
  const priceMap = {};

  // 逐檔抓價（序列執行，對官方 API 友善）
  for (const [code, market] of Object.entries(codes)) {
    const r = await fetchStock(code, market);
    if (r?.price > 0) {
      priceMap[code] = { ...r, market };
      // 52 週統計（失敗不影響主價格）
      const ys = await resolveYearStats(code, market);
      if (ys) Object.assign(priceMap[code], ys);
      console.log(`✓ ${code} (${market}) = ${r.price}${ys ? ` [52W高 ${ys.high52.toFixed(1)}]` : ''}`);
    } else {
      failures.push(code);
      console.log(`✗ ${code} (${market}) 抓取失敗`);
    }
  }

  // 匯率 + 基準指數
  const fx = await fetchYahooLatest('TWD=X');
  const usdTwd = fx?.price > 25 && fx.price < 40 ? fx.price : null;
  const benchmarks = {};
  for (const b of ['^TWII', 'VTI']) {
    const pts = await fetchYahoo(b);
    if (pts?.length) benchmarks[b] = pts[pts.length - 1];
  }

  const today = todayStr();

  // ── 寫 prices.json ──
  const prev = existsSync(join(DATA, 'prices.json'))
    ? JSON.parse(readFileSync(join(DATA, 'prices.json'), 'utf8')) : {};
  const out = {
    updatedAt: today,
    usdTwd: usdTwd ?? prev.usdTwd ?? null,
    prices: { ...(prev.prices || {}) },  // 保留舊值，抓到才覆寫（單檔失敗不丟舊價）
    failures,
  };
  for (const [code, r] of Object.entries(priceMap))
    out.prices[code] = {
      price: r.price, change: r.change, date: r.date, market: r.market,
      ...(r.high52 != null ? { high52: r.high52, low52: r.low52, weekAgo: r.weekAgo } : {}),
    };
  writeFileSync(join(DATA, 'prices.json'), JSON.stringify(out, null, 2));

  // ── 寫 history/prices-<年>.json（按日期去重 append）──
  const histPath = join(DATA, 'history', `prices-${YEAR}.json`);
  const hist = existsSync(histPath) ? JSON.parse(readFileSync(histPath, 'utf8')) : {};
  const upsert = (key, date, close) => {
    if (!hist[key]) hist[key] = [];
    const i = hist[key].findIndex(x => x.date === date);
    if (i >= 0) hist[key][i].close = close;
    else { hist[key].push({ date, close }); hist[key].sort((a, b) => a.date.localeCompare(b.date)); }
  };
  for (const [code, r] of Object.entries(priceMap)) upsert(code, r.date, r.price);
  for (const [b, pt] of Object.entries(benchmarks)) upsert(b, pt.date, pt.close);
  if (usdTwd) upsert('TWD=X', today, usdTwd);
  writeFileSync(histPath, JSON.stringify(hist));

  // ── 寫 snapshots/<年>.jsonl（同日覆寫）──
  const rate = out.usdTwd || 32;
  const snap = { date: today, totalValue: 0, totalCost: 0, tw: { value: 0, cost: 0 }, us: { value: 0, cost: 0 }, gold: { value: 0, cost: 0 }, usdTwd: rate };
  for (const p of positions) {
    if (p.closed) continue;
    const info = out.prices[p.stockCode];
    const isUS = p.market === 'us' || p.currency === 'USD';
    const isGold = p.market === 'gold' || p.type === '黃金';
    const mult = isUS ? rate : 1;
    const price = (info?.price ?? p.avgCost) * mult;
    const cost = p.shares * p.avgCost * mult;
    const value = p.shares * price;
    const bucket = isUS ? snap.us : isGold ? snap.gold : snap.tw;
    bucket.value += value; bucket.cost += cost;
    snap.totalValue += value; snap.totalCost += cost;
  }
  ['totalValue', 'totalCost'].forEach(k => snap[k] = Math.round(snap[k]));
  ['tw', 'us', 'gold'].forEach(k => { snap[k].value = Math.round(snap[k].value); snap[k].cost = Math.round(snap[k].cost); });
  // 附上最近一筆現金記錄（若有）
  try {
    const cash = JSON.parse(readFileSync(join(DATA, 'cash.json'), 'utf8'));
    const latest = (cash.snapshots || []).slice().sort((a, b) => b.date.localeCompare(a.date))[0];
    if (latest) snap.cash = latest.accounts
      ? Object.values(latest.accounts).reduce((s, v) => s + (+v || 0), 0)
      : (latest.cash || 0);
  } catch {}

  const snapPath = join(DATA, 'snapshots', `${YEAR}.jsonl`);
  let lines = existsSync(snapPath)
    ? readFileSync(snapPath, 'utf8').split('\n').filter(Boolean) : [];
  lines = lines.filter(l => { try { return JSON.parse(l).date !== today; } catch { return false; } });
  lines.push(JSON.stringify(snap));
  writeFileSync(snapPath, lines.join('\n') + '\n');

  console.log(`\n完成：${Object.keys(priceMap).length} 檔成功、${failures.length} 檔失敗${failures.length ? '（' + failures.join(', ') + '）' : ''}`);
  console.log(`快照：總市值 ${snap.totalValue.toLocaleString()} / 總成本 ${snap.totalCost.toLocaleString()}`);
}

main().catch(e => { console.error(e); process.exit(1); });
