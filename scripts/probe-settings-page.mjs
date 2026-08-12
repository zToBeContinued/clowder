// 诊断：无头浏览器打开 settings 页面，收集 console 错误 / 页面异常 / 渲染结果。
import puppeteer from 'puppeteer';

const url = process.argv[2] ?? 'http://localhost:3003/settings?from=thread_msofdas4ijjjp16k&s=ops';
const browser = await puppeteer.launch({
  headless: 'new',
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
});
const page = await browser.newPage();

const consoleMsgs = [];
page.on('console', (msg) => {
  if (msg.type() === 'error' || msg.type() === 'warning') {
    consoleMsgs.push(`[${msg.type()}] ${msg.text().slice(0, 300)}`);
  }
});
page.on('pageerror', (err) => consoleMsgs.push(`[pageerror] ${String(err).slice(0, 400)}`));
page.on('requestfailed', (req) =>
  consoleMsgs.push(`[requestfailed] ${req.url().slice(0, 120)} — ${req.failure()?.errorText}`),
);

await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
await new Promise((r) => setTimeout(r, 3000));

const summary = await page.evaluate(() => {
  const body = document.body;
  const text = (body?.innerText ?? '').trim();
  return {
    bodyTextLength: text.length,
    bodyTextHead: text.slice(0, 300),
    hasSettingsNav: !!document.querySelector('[data-console-panel="settings-nav"]'),
    visibleButtons: [...document.querySelectorAll('button')].slice(0, 12).map((b) => b.textContent?.trim() ?? ''),
  };
});

console.log('=== 页面渲染摘要 ===');
console.log(JSON.stringify(summary, null, 2));
console.log('\n=== console/network 异常 ===');
for (const m of consoleMsgs) console.log(m);
if (consoleMsgs.length === 0) console.log('(无)');

await browser.close();
