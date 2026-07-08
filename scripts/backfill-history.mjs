#!/usr/bin/env node
/**
 * 一次性回填：抓取所有持股（含今年有交易的已清倉部位）自 2025-12-15 起的每日收盤，
 * 連同 ^TWII / VTI / TWD=X 基準，合併進 data/history/prices-<年>.json。
 * 之後網頁的 YTD 圖直接讀這個檔案，不再於瀏覽器端打 API。
 *
 * 可重複執行（按日期 upsert），也可在持股新增後再跑一次補歷史。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(ROOT, 'data');
const YEAR = new Date().getFullYear();
const FROM = `${YEAR - 1}-12-15`;   // 含 12/31 基準價

const UA = { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' };

async function fetchJSON(url, timeout = 20000) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeout);
    const r = await fetch(url, { headers: UA, signal: ctrl.signal });
    clearTimeout(t);
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

async function fetchDaily(ticker) {
  const p1 = Math.floor(new Date(FROM + 'T00:00:00Z').getTime() / 1000);
  const p2 = Math.floor(Date.now() / 1000);
  for (const host of ['query1', 'query2']) {
    const d = await fetchJSON(`https://${host}.finance.yahoo.com/v8/finance/chart/${ticker}?period1=${p1}&period2=${p2}&interval=1d`);
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

async function resolveDaily(code, market) {
  if (market === 'us') return { ticker: code, pts: await fetchDaily(code) };
  const suffixes = market === 'otc' ? ['.TWO', '.TW'] : ['.TW', '.TWO'];
  for (const sfx of suffixes) {
    const pts = await fetchDaily(code.toUpperCase() + sfx);
    if (pts?.length > 20) return { ticker: code.toUpperCase() + sfx, pts };
  }
  return { ticker: null, pts: null };
}

async function main() {
  const holdings = JSON.parse(readFileSync(join(DATA, 'holdings.json'), 'utf8'));
  const positions = holdings.positions || [];

  // 需要歷史的代碼：未清倉，或今年有交易的已清倉（YTD TWR 需要）
  // 排除純中文代碼（CSV 匯入的已實現損益記錄，無法對應 ticker）
  const codes = {};
  positions.forEach(p => {
    if (!p.stockCode || !/^[0-9A-Za-z.]+$/.test(p.stockCode)) return;
    if (p.market === 'gold') return;
    const hasThisYearTx = (p.transactions || []).some(t => t.date >= `${YEAR}-01-01`);
    if (!p.closed || hasThisYearTx) codes[p.stockCode] = p.market || 'tse';
  });

  const histPath = join(DATA, 'history', `prices-${YEAR}.json`);
  const hist = existsSync(histPath) ? JSON.parse(readFileSync(histPath, 'utf8')) : {};
  const upsert = (key, pts) => {
    if (!hist[key]) hist[key] = [];
    for (const pt of pts) {
      const i = hist[key].findIndex(x => x.date === pt.date);
      if (i >= 0) hist[key][i].close = pt.close;
      else hist[key].push(pt);
    }
    hist[key].sort((a, b) => a.date.localeCompare(b.date));
  };

  let ok = 0, fail = [];
  for (const [code, market] of Object.entries(codes)) {
    const { pts } = await resolveDaily(code, market);
    if (pts?.length) { upsert(code, pts); ok++; console.log(`✓ ${code} ${pts.length} 天`); }
    else { fail.push(code); console.log(`✗ ${code} 失敗`); }
  }
  for (const b of ['^TWII', 'VTI', 'TWD=X']) {
    const pts = await fetchDaily(encodeURIComponent(b));
    if (pts?.length) { upsert(b, pts); console.log(`✓ ${b} ${pts.length} 天`); }
    else console.log(`✗ ${b} 失敗`);
  }

  writeFileSync(histPath, JSON.stringify(hist));
  console.log(`\n完成：${ok} 檔回填、${fail.length} 檔失敗${fail.length ? '（' + fail.join(', ') + '）' : ''}`);
}

main().catch(e => { console.error(e); process.exit(1); });
