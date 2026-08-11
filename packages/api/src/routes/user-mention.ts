/**
 * F057-C2: Detect co-creator (@co-creator / @铲屎官 / configured) mention at line start.
 *
 * Same convention as cat @mentions: line-start only, code blocks stripped.
 * OQ-1 + R2-P2: Token boundary — reject ASCII letter/digit/underscore continuation
 * (e.g. @co-creator123, @co-creator123) but allow CJK text (e.g. @co-creator请看, @铲屎官请看).
 *
 * F067 co-creator config: patterns read from the resolved cat config coCreator.mentionPatterns,
 * with @co-creator/@铲屎官 always included as fallback defaults.
 */

import { getCoCreatorMentionPatterns } from '../config/cat-config-loader.js';

/** Reject if followed by ASCII word character (letter/digit/underscore) */
const CONTINUATION_RE = /^[a-zA-Z0-9_]/;

export function detectUserMention(text: string): boolean {
  const patterns = getCoCreatorMentionPatterns();
  // Strip fenced code blocks; 2026-08-11 起与 A2A 规则对齐：任意位置 @ 都算呼叫用户
  const stripped = text.replace(/```[\s\S]*?```/g, '').toLowerCase();
  for (const pattern of patterns) {
    let from = 0;
    while (from < stripped.length) {
      const idx = stripped.indexOf(pattern, from);
      if (idx < 0) break;
      from = idx + 1;
      // 左边界：@ 紧跟在 handle 字符后是 email/路径形态（user@host），不算呼叫
      const prev = idx > 0 ? stripped[idx - 1]! : '';
      if (prev && /[a-z0-9_.-]/.test(prev)) continue;
      const rest = stripped.slice(idx + pattern.length);
      if (!CONTINUATION_RE.test(rest)) return true;
    }
  }
  return false;
}
