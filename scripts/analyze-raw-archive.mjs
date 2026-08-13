// 诊断：分析 cursor 原始事件归档中目标句子的出现情况。
// 用法: node scripts/analyze-raw-archive.mjs <ndjson文件> <目标子串>

import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

const [file, needle] = [process.argv[2], process.argv[3] ?? 're-prove the hardened'];
const rl = createInterface({ input: createReadStream(file, 'utf8') });

let lineNo = 0;
const hits = [];
const typeCounts = new Map();
let fullTextConcat = '';

for await (const line of rl) {
  lineNo++;
  if (!line.trim()) continue;
  let evt;
  try {
    evt = JSON.parse(line);
  } catch {
    continue;
  }
  if (evt && typeof evt === 'object' && 'payload' in evt) evt = evt.payload; // CliRawArchive wrapper
  const raw = JSON.stringify(evt);
  const t = evt?.type ?? evt?.event ?? 'unknown';
  typeCounts.set(t, (typeCounts.get(t) ?? 0) + 1);

  // cursor stream-json: assistant delta 在 message.content[].text
  const texts = [];
  if (typeof evt?.text === 'string') texts.push(evt.text);
  const content = evt?.message?.content;
  if (Array.isArray(content)) {
    for (const c of content) if (typeof c?.text === 'string') texts.push(c.text);
  }
  for (const tx of texts) {
    if (t === 'assistant' || t === 'text' || evt?.subtype === 'assistant') fullTextConcat += tx;
  }
  if (raw.includes(needle)) {
    hits.push({ lineNo, type: t, subtype: evt?.subtype, preview: raw.slice(0, 260) });
  }
}

console.log(`file=${file}`);
console.log(`事件类型统计:`, Object.fromEntries(typeCounts));
console.log(`\n目标句 "${needle}" 命中 ${hits.length} 行:`);
for (const h of hits) console.log(`  line ${h.lineNo} [${h.type}${h.subtype ? '/' + h.subtype : ''}] ${h.preview}`);
console.log(`\nassistant 正文拼接后目标句出现次数: ${fullTextConcat.split(needle).length - 1}`);
const idx = fullTextConcat.indexOf(needle);
if (idx >= 0) console.log(`拼接正文片段: ...${fullTextConcat.slice(Math.max(0, idx - 150), idx + 250)}...`);
