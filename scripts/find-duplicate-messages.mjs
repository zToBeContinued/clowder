// 一次性诊断脚本：扫描所有 thread 的猫正文消息，按「前 150 字符前缀」分组，
// 找出疑似整条重复的消息组（内容几乎相同、id 不同）。
// 用法: node scripts/find-duplicate-messages.mjs [threadId]
import { Redis } from 'ioredis';

const onlyThread = process.argv[2];
const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6399');

const threadKeys = onlyThread ? [`cat-cafe:msg:thread:${onlyThread}`] : await redis.keys('cat-cafe:msg:thread:*');

let totalGroups = 0;
for (const tk of threadKeys) {
  const threadId = tk.replace('cat-cafe:msg:thread:', '');
  const ids = await redis.zrange(tk, 0, -1);
  const byPrefix = new Map();
  for (const id of ids) {
    const m = await redis.hgetall(`cat-cafe:msg:${id}`);
    if (!m || !m.content) continue;
    if (!m.catId) continue; // 只看猫正文（assistant 消息）
    const content = m.content.trim();
    if (content.length < 80) continue; // 短 ack 跳过
    const key = `${m.catId}::${content.slice(0, 150)}`;
    if (!byPrefix.has(key)) byPrefix.set(key, []);
    byPrefix.get(key).push({
      id,
      catId: m.catId,
      ts: Number(m.timestamp),
      len: content.length,
      invocationId: m.invocationId ?? '',
      extra: (m.extra ?? '').slice(0, 100),
      head: content.slice(0, 90).replace(/\n/g, ' ⏎ '),
    });
  }
  for (const [, msgs] of byPrefix) {
    if (msgs.length < 2) continue;
    totalGroups++;
    console.log(`\n=== thread=${threadId} 疑似重复（${msgs.length} 条）===`);
    console.log(`  开头: ${msgs[0].head}`);
    for (const m of msgs) {
      console.log(
        `  id=${m.id} cat=${m.catId} ts=${new Date(m.ts).toISOString()} len=${m.len} inv=${m.invocationId} extra=${m.extra}`,
      );
    }
  }
}
console.log(`\n疑似重复组总数: ${totalGroups}（扫描 ${threadKeys.length} 个 thread）`);
await redis.quit();
