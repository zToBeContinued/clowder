// Marker 的项目归属路由
//
// MarkerQueue 本身只认一个目录。在只服务本仓库时这没问题，但 thread 可以挂在任意
// 外部项目上（thread.projectPath），此时 retain-memory 产出的知识 marker 会全部
// 写进 Clowder 自己的 docs/markers/ —— 一个 git 跟踪的目录。结果是外部项目的评审
// 记录混进 Clowder 的知识库，还随时可能被误提交。
//
// 这里按 projectPath 把 marker 路由到它自己的项目：本仓库（含 worktree）走本地
// queue，外部项目落到 <projectPath>/docs/markers/，与 Clowder 自身的知识结构一致。

import { resolve } from 'node:path';
import { isSameRepo } from '../../utils/is-same-repo.js';
import type { IMarkerQueue } from './interfaces.js';
import { MarkerQueue } from './MarkerQueue.js';

/** thread.projectPath 未绑定具体项目时的占位值。 */
const UNBOUND_PROJECT_PATH = 'default';

export class MarkerQueueRouter {
  private readonly cache = new Map<string, IMarkerQueue>();

  constructor(
    private readonly localQueue: IMarkerQueue,
    private readonly repoRoot: string,
    private readonly createQueue: (markersDir: string) => IMarkerQueue = (dir) => new MarkerQueue(dir),
  ) {}

  /**
   * 解析该 projectPath 应该使用的 marker 队列。
   * 未绑定项目、或项目就是本仓库（含 worktree）时返回本地队列。
   */
  resolve(projectPath?: string): IMarkerQueue {
    const trimmed = projectPath?.trim();
    if (!trimmed || trimmed === UNBOUND_PROJECT_PATH) return this.localQueue;

    let sameRepo: boolean;
    try {
      sameRepo = isSameRepo(trimmed, this.repoRoot);
    } catch {
      // 判定不了归属时倒向本地队列：写错目录比在别人项目里凭空建目录更容易发现和回收。
      return this.localQueue;
    }
    if (sameRepo) return this.localQueue;

    const markersDir = resolve(trimmed, 'docs', 'markers');
    const cached = this.cache.get(markersDir);
    if (cached) return cached;

    const queue = this.createQueue(markersDir);
    this.cache.set(markersDir, queue);
    return queue;
  }
}
