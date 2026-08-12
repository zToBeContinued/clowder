// 诊断：同 catId 时间相近的两条消息，内容高度相似（可能是重试后重新生成）。
// 相似度 = 简易 token 重合率（3-gram Jaccard 近似，取前 2000 字）。
// 用法: node scripts/find-similar-messages.mjs [threadId]
import { Redis } from 'ioredis';

const onlyThread = process.argv[2];
const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6399');
const threadKeys = onlyThread
  ? [`cat-cafe:msg:thread:${onlyThread}`]
  : await redis.keys('cat-cafe:msg:thread:*');

function grams(s) {
  const t = s.replace(/\s+/g, '').slice(0, 2000);
  const g = new Set();
  for (let i = 0; i + 3 <= t.length; i++) g.add(t.slice(i, i + 3));
  return g;
}
function jaccard(a, b) {
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter || 1);
}

let found = 0;
for (const tk of threadKeys) {
  const threadId = tk.replace('cat-cafe:msg:thread:', '');
  const ids = await redis.zrange(tk, 0, -1);
  const msgs = [];
  for (const id of ids) {
    const m = await redis.hgetall(`cat-cafe:msg:${id}`);
    if (!m?.content || !m.catId) continue;
    const content = m.content.trim();
    if (content.length < 200) continue; // 只看正文级消息
    msgs.push({ id, catId: m.catId, ts: Number(m.timestamp), content, g: grams(content) });
  }
  for (let i = 1; i < msgs.length; i++) {
    for (let j = Math.max(0, i - 4); j < i; j++) {
      const a = msgs[j];
      const b = msgs[i];
      if (a.catId !== b.catId) continue;
      if (b.ts - a.ts > 30 * 60_000) continue; // 30 分钟内
      const sim = jaccard(a.g, b.g);
      if (sim >= 0.6) {
        found++;
        console.log(`\n=== 相似实例 ${found} thread=${threadId} sim=${sim.toFixed(2)} ===`);
        console.log(`  A: id=${a.id} cat=${a.catId} ts=${new Date(a.ts).toISOString()} len=${a.content.length}`);
        console.log(`     头: ${a.content.slice(0, 80).replace(/\n/g, ' ⏎ ')}`);
        console.log(`  B: id=${b.id} cat=${b.catId} ts=${new Date(b.ts).toISOString()} len=${b.content.length} (相隔 ${Math.round((b.ts - a.ts) / 1000)}s)`);
        console.log(`     头: ${b.content.slice(0, 80).replace(/\n/g, ' ⏎ ')}`);
      }
    }
  }
}
console.log(`\n相似实例总数: ${found}（扫描 ${threadKeys.length} 个 thread）`);
await redis.quit();
