/**
 * Summary Store (拍立得照片墙)
 * 内存实现，Map-based，有界 (MAX=200)。
 */

import type { CreateSummaryInput, ThreadSummary } from '@cat-cafe/shared';
import { generateSortableId } from './MessageStore.js';

const MAX_SUMMARIES = 200;

/**
 * Common interface for summary stores (in-memory and future Redis).
 */
export interface ISummaryStore {
  create(input: CreateSummaryInput): ThreadSummary | Promise<ThreadSummary>;
  get(summaryId: string): ThreadSummary | null | Promise<ThreadSummary | null>;
  listByThread(threadId: string): ThreadSummary[] | Promise<ThreadSummary[]>;
  delete(summaryId: string): boolean | Promise<boolean>;
  /** Delete every summary of a thread (cascade on thread purge). Returns the count. */
  deleteByThread(threadId: string): number | Promise<number>;
}

/**
 * In-memory summary store with bounded capacity.
 */
export class SummaryStore implements ISummaryStore {
  private summaries: Map<string, ThreadSummary> = new Map();
  private readonly maxSummaries: number;

  constructor(options?: { maxSummaries?: number }) {
    this.maxSummaries = options?.maxSummaries ?? MAX_SUMMARIES;
  }

  create(input: CreateSummaryInput): ThreadSummary {
    this.evictOldestIfNeeded();

    const summary: ThreadSummary = {
      id: generateSortableId(Date.now()),
      threadId: input.threadId,
      topic: input.topic,
      conclusions: input.conclusions,
      openQuestions: input.openQuestions,
      createdAt: Date.now(),
      createdBy: input.createdBy,
    };

    this.summaries.set(summary.id, summary);
    return summary;
  }

  get(summaryId: string): ThreadSummary | null {
    return this.summaries.get(summaryId) ?? null;
  }

  listByThread(threadId: string): ThreadSummary[] {
    const result: ThreadSummary[] = [];
    for (const summary of this.summaries.values()) {
      if (summary.threadId === threadId) {
        result.push(summary);
      }
    }
    result.sort((a, b) => a.id.localeCompare(b.id));
    return result;
  }

  delete(summaryId: string): boolean {
    return this.summaries.delete(summaryId);
  }

  deleteByThread(threadId: string): number {
    let deleted = 0;
    for (const [id, summary] of this.summaries) {
      if (summary.threadId === threadId) {
        this.summaries.delete(id);
        deleted += 1;
      }
    }
    return deleted;
  }

  /** Current summary count (for testing) */
  get size(): number {
    return this.summaries.size;
  }

  private evictOldestIfNeeded(): void {
    if (this.summaries.size < this.maxSummaries) return;
    const firstKey = this.summaries.keys().next().value;
    if (firstKey) this.summaries.delete(firstKey);
  }
}
