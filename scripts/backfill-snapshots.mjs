#!/usr/bin/env node
/**
 * 一次性回推每日資產快照：用 history/prices-<年>.json 的日線 × 各日實際持股數
 * 重建今年每個交易日的投資部位市值，寫入 snapshots/<年>.jsonl。
 *
 * 註：
 * ・持股數由交易記錄回推；沒有交易記錄的部位（多為存股）以目前股數視為全年持有（近似）。
 * ・美股以 TWD=X 當日匯率折算；該日無匯率則用最近一筆。
 * ・已存在的快照日期（Actions 產生的真實快照）不覆寫。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(ROOT, 'data');
const YEAR = new Date().getFullYear();
const JAN1 = `${YEAR}-01-01`;

const holdings = JSON.parse(readFileSync(join(DATA, 'holdings.json'), 'utf8'));
const hist = JSON.parse(readFileSync(join(DATA, 'history', `prices-${YEAR}.json`), 'utf8'));
const positions = holdings.positions || [];
const isUS = p => p.market === 'us' || p.currency === 'USD';
const isGold = p => p.market === 'gold' || p.type === '黃金';

// 官方歷史日線查無資料時（如舊版CSV匯入、stockCode是中文名稱非真實代碼），
// 退回用該部位自己的交易記錄重建價格序列（買賣當下價格是精確已知的）
function getPositionSeries(p) {
  const real = hist[p.stockCode];
  if (real?.length) return real;
  const txs = (p.transactions || []).filter(t => t.price > 0);
  if (!txs.length) return null;
  const byDate = {};
  txs.forEach(t => { byDate[t.date] = t.price; });
  return Object.keys(byDate).sort().map(d => ({ date: d, close: byDate[d] }));
}
const seriesCache = new Map(positions.map(p => [p.id, getPositionSeries(p)]));

const sharesOn = (p, d) => {
  if (!p.transactions?.length) return p.shares;
  let sh = 0;
  for (const t of p.transactions) { if (t.date > d) continue; sh += t.action === 'buy' ? t.shares : -t.shares; }
  return Math.max(0, sh);
};
const avgCostOn = (p, d) => {
  if (!p.transactions?.length) return p.avgCost;
  const txs = [...p.transactions].sort((a, b) => a.date.localeCompare(b.date));
  let sh = 0, ac = 0;
  for (const t of txs) {
    if (t.date > d) break;
    if (t.action === 'buy') { const ns = sh + t.shares; ac = ns > 0 ? (sh * ac + t.shares * t.price) / ns : t.price; sh = ns; }
    else sh = Math.max(0, sh - t.shares);
  }
  return ac;
};
const closeAt = (key, d) => {
  const s = hist[key]; if (!s?.length) return null;
  const e = [...s].reverse().find(x => x.date <= d);
  return e ? e.close : null;
};
const closeAtSeries = (series, d) => {
  if (!series?.length) return null;
  const e = [...series].reverse().find(x => x.date <= d);
  return e ? e.close : null;
};

// 交易日 = ^TWII 有收盤的日子
const dates = (hist['^TWII'] || []).filter(x => x.date >= JAN1).map(x => x.date);
if (!dates.length) { console.error('history 檔缺 ^TWII'); process.exit(1); }

const snapPath = join(DATA, 'snapshots', `${YEAR}.jsonl`);
const existing = existsSync(snapPath)
  ? readFileSync(snapPath, 'utf8').split('\n').filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
  : [];
const existingDates = new Set(existing.map(s => s.date));

const out = [];
for (const d of dates) {
  if (existingDates.has(d)) continue;
  const fx = closeAt('TWD=X', d) || 32;
  const snap = { date: d, totalValue: 0, totalCost: 0, tw: { value: 0, cost: 0 }, us: { value: 0, cost: 0 }, gold: { value: 0, cost: 0 }, usdTwd: +fx.toFixed(3), backfilled: true };
  for (const p of positions) {
    const sh = sharesOn(p, d); if (sh <= 0) continue;
    const c = closeAtSeries(seriesCache.get(p.id), d); if (!c) continue;
    const mult = isUS(p) ? fx : 1;
    const value = sh * c * mult;
    const cost = sh * avgCostOn(p, d) * mult;
    const bucket = isUS(p) ? snap.us : isGold(p) ? snap.gold : snap.tw;
    bucket.value += value; bucket.cost += cost;
    snap.totalValue += value; snap.totalCost += cost;
  }
  ['totalValue', 'totalCost'].forEach(k => snap[k] = Math.round(snap[k]));
  ['tw', 'us', 'gold'].forEach(k => { snap[k].value = Math.round(snap[k].value); snap[k].cost = Math.round(snap[k].cost); });
  if (snap.totalValue > 0) out.push(snap);
}

const all = [...existing, ...out].sort((a, b) => a.date.localeCompare(b.date));
writeFileSync(snapPath, all.map(s => JSON.stringify(s)).join('\n') + '\n');
console.log(`回推 ${out.length} 天、既有 ${existing.length} 天，共 ${all.length} 天`);
console.log('範圍:', all[0]?.date, '→', all[all.length - 1]?.date);
