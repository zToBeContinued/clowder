/**
 * 清扫历史测试运行留在系统临时目录的残留。
 *
 * 背景(2026-08-13):%TEMP% 里积了数百个 cat-cafe-test-template-* 目录
 * (7/16、7/26 的测试垃圾,每个 32KB)。setup-cat-registry 的 process exit
 * 钩子在硬杀/崩溃/worker 线程场景不会执行,单靠退出清理永远有漏网。
 * 本清扫在每次测试启动时自愈上一轮的垃圾,让积累不可能发生。
 *
 * 裁决规则(绝不误伤并行中的测试,同时不被 PID 复用骗过):
 * - 年龄 ≥24h:一律删。测试临时目录的寿命是分钟级,隔天必是垃圾;
 *   嵌在名字里的 pid 早被系统回收复用,「pid 活着」不构成保护理由
 *   (首版按 pid 活性保护,142 个 7 月老目录只清掉 5 个——全被复用 pid 挡下)。
 * - 年龄 <24h:仅当解析出 pid 且已死才删;pid 活着或解析不出 → 保留,
 *   保护并行/短暂中断的测试运行。
 * - 其它名字一律不碰。
 */
import { readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const STALE_AGE_MS = 24 * 3600_000;
const TEMPLATE_RE = /^cat-cafe-test-template-(\d+)?/;
const HOME_RE = /^cat-cafe-test-home-/;

function defaultIsPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

/**
 * @param {{ root?: string, now?: number, isPidAlive?: (pid: number) => boolean }} [options]
 * @returns {{ removed: number }}
 */
export function sweepStaleTestTemp(options = {}) {
  const root = options.root ?? tmpdir();
  const now = options.now ?? Date.now();
  const isPidAlive = options.isPidAlive ?? defaultIsPidAlive;

  let names;
  try {
    names = readdirSync(root);
  } catch {
    return { removed: 0 };
  }

  let removed = 0;
  for (const name of names) {
    const templateMatch = name.match(TEMPLATE_RE);
    const isHome = HOME_RE.test(name);
    if (!templateMatch && !isHome) continue;

    const fullPath = join(root, name);
    let ageMs;
    try {
      ageMs = now - statSync(fullPath).mtimeMs;
    } catch {
      continue;
    }

    let shouldRemove = false;
    if (ageMs >= STALE_AGE_MS) {
      shouldRemove = true;
    } else {
      const pid = templateMatch?.[1] ? Number(templateMatch[1]) : null;
      if (pid !== null && Number.isFinite(pid) && pid > 0) {
        shouldRemove = !isPidAlive(pid);
      }
    }

    if (!shouldRemove) continue;
    try {
      rmSync(fullPath, { recursive: true, force: true });
      removed++;
    } catch {
      // 占用中的目录删不掉就留给下一轮;清扫失败绝不影响测试运行
    }
  }
  return { removed };
}
