// 诊断：找「复读」实例——某条猫消息的开头与其前 6 条内任意消息的开头高度相同。
// 用法: node scripts/find-echo-messages.mjs [threadId]
import { Redis } from 'ioredis';

const onlyThread = process.argv[2];
const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6399');
const threadKeys = onlyThread
  ? [`cat-cafe:msg:thread:${onlyThread}`]
  : await redis.keys('cat-cafe:msg:thread:*');

const PREFIX_LEN = 120;
let found = 0;
for (const tk of threadKeys) {
  const threadId = tk.replace('cat-cafe:msg:thread:', '');
  const ids = await redis.zrange(tk, 0, -1);
  const msgs = [];
  for (const id of ids) {
    const m = await redis.hgetall(`cat-cafe:msg:${id}`);
    if (!m || !m.content) continue;
    const content = m.content.trim();
    if (content.length < PREFIX_LEN) continue;
    msgs.push({ id, catId: m.catId ?? '', userId: m.userId ?? '', ts: Number(m.timestamp), content });
  }
  for (let i = 1; i < msgs.length; i++) {
    const b = msgs[i];
    if (!b.catId) continue; // 复读方必须是猫
    for (let j = Math.max(0, i - 6); j < i; j++) {
      const a = msgs[j];
      if (a.content.slice(0, PREFIX_LEN) === b.content.slice(0, PREFIX_LEN)) {
        found++;
        console.log(`\n=== 复读实例 ${found} thread=${threadId} ===`);
        console.log(`  原消息: id=${a.id} cat=${a.catId || `(user:${a.userId})`} ts=${new Date(a.ts).toISOString()} len=${a.content.length}`);
        console.log(`  复读方: id=${b.id} cat=${b.catId} ts=${new Date(b.ts).toISOString()} len=${b.content.length} (相隔 ${Math.round((b.ts - a.ts) / 1000)}s)`);
        console.log(`  开头: ${b.content.slice(0, 100).replace(/\n/g, ' ⏎ ')}`);
        break;
      }
    }
  }
}
console.log(`\n复读实例总数: ${found}（扫描 ${threadKeys.length} 个 thread）`);
await redis.quit();
