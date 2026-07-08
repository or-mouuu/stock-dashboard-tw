#!/usr/bin/env node
/**
 * 互動式初始化精靈（本機執行，不需要任何帳號或網路）
 *
 * 用途：問幾個問題（收件信箱、目標配置、備用金），產生 data/settings.json；
 * 並在 data/ 不存在時，從 data.example/ 複製一份示範資料讓網頁一開就能看。
 *
 * 用法：
 *   node scripts/setup.mjs
 *
 * 這一步不是必要的——網頁本身也會在 data/ 缺檔時直接顯示示範資料，
 * 之後隨時可以在網頁的設定精靈或直接編輯 data/settings.json 調整。
 * 這個腳本只是提供一個「一開始就把幾個關鍵數字填對」的捷徑。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, cpSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DATA_DIR = join(ROOT, 'data');
const EXAMPLE_DIR = join(ROOT, 'data.example');

const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = async (question, fallback) => {
  const suffix = fallback !== undefined && fallback !== '' ? `（預設：${fallback}）` : '';
  const answer = (await rl.question(`${question}${suffix} > `)).trim();
  return answer || fallback;
};
const askNumber = async (question, fallback) => {
  const raw = await ask(question, String(fallback));
  const n = parseFloat(raw);
  return Number.isFinite(n) ? n : fallback;
};

function copyExampleDataIfMissing() {
  if (existsSync(DATA_DIR)) {
    console.log('ℹ️  data/ 已存在，跳過複製示範資料（不會覆蓋你現有的資料）。');
    return;
  }
  mkdirSync(DATA_DIR, { recursive: true });
  cpSync(EXAMPLE_DIR, DATA_DIR, { recursive: true });
  console.log('✓ 已從 data.example/ 複製示範資料到 data/。');
}

async function askTargetAllocation() {
  console.log('\n目標配置：長線／短線／機動現金三者的比例，總和須為 100。');
  console.log('（不確定的話直接按 Enter 用預設值 60/30/10 即可，之後隨時能在網頁的設定精靈調整）');
  while (true) {
    const core = await askNumber('長線部位 %', 60);
    const swing = await askNumber('短線交易 %', 30);
    const cash = await askNumber('機動現金 %', 10);
    if (Math.round(core + swing + cash) === 100) {
      return { core, swing, cash };
    }
    console.log(`⚠️  加總是 ${core + swing + cash}，不是 100，請重新輸入一次。`);
  }
}

async function main() {
  console.log('=== 股票投資儀表板 · 初始化精靈 ===');
  console.log('接下來的問題都可以直接按 Enter 用預設值，之後也能再改。\n');

  copyExampleDataIfMissing();

  const settingsPath = join(DATA_DIR, 'settings.json');
  const existing = existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, 'utf8')) : {};

  const email = await ask('週報收件信箱（沒有就先留空，之後在 settings.json 補）', existing.report?.email || '');
  const { core, swing, cash } = await askTargetAllocation();
  const emergencyFund = await askNumber('緊急預備金金額', existing.reserve?.emergencyFund ?? 300000);
  const monthlyExpenseMultiple = await askNumber('保留金＝月支出的幾倍', existing.reserve?.monthlyExpenseMultiple ?? 6);

  const settings = {
    ...existing,
    targetAllocation: {
      core:  { label: '長線部位', pct: core },
      swing: { label: '短線交易', pct: swing },
      cash:  { label: '機動現金', pct: cash },
    },
    allocationDriftAlert: existing.allocationDriftAlert ?? 10,
    concentrationAlert: existing.concentrationAlert ?? 20,
    swingRules: existing.swingRules ?? {
      stopLossPct: -20,
      takeProfitPct: 20,
      trailingStopPct: null,
      stagedTakeProfit: false,
      timeStopMonths: 6,
    },
    reserve: { emergencyFund, monthlyExpenseMultiple },
    report: {
      ...(existing.report || {}),
      email,
      dashboardUrl: existing.report?.dashboardUrl ?? '',
      brokerMonitorRaw: existing.report?.brokerMonitorRaw ?? '',
      brokerMonitorUrl: existing.report?.brokerMonitorUrl ?? '',
    },
  };

  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  console.log(`\n✓ 已寫入 ${settingsPath}`);
  console.log('\n接下來：');
  console.log('1. 本機預覽：python3 -m http.server 8000，開 http://localhost:8000');
  console.log('2. 確認沒問題後 commit + push；照 docs/SETUP.md 部署到 Vercel');
  console.log('3. 到網頁上匯入你的券商 CSV 或手動新增持股，取代示範資料\n');

  rl.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
