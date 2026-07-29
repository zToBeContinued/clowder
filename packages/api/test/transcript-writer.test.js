/**
 * TranscriptWriter Tests
 * F24 Phase C: Events JSONL flush + sparse index + extractive digest.
 *
 * Red→Green: Tests written before full implementation.
 */

import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

describe('TranscriptWriter', () => {
  let tmpDir;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'transcript-test-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function loadModules() {
    const { TranscriptWriter } = await import('../dist/domains/cats/services/session/TranscriptWriter.js');
    return { TranscriptWriter };
  }

  const SESSION_INFO = {
    sessionId: 'sess-abc',
    threadId: 'thread-1',
    catId: 'opus',
    cliSessionId: 'cli-123',
    seq: 0,
  };

  describe('appendEvent()', () => {
    test('appends events to in-memory buffer', async () => {
      const { TranscriptWriter } = await loadModules();
      const writer = new TranscriptWriter({ dataDir: tmpDir });

      writer.appendEvent(SESSION_INFO, {
        type: 'assistant',
        content: [{ type: 'text', text: 'Hello world' }],
      });
      writer.appendEvent(SESSION_INFO, {
        type: 'user',
        content: [{ type: 'text', text: 'Hi!' }],
      });

      assert.equal(writer.getEventCount(SESSION_INFO.sessionId), 2);
    });

    test('events have auto-incremented eventNo', async () => {
      const { TranscriptWriter } = await loadModules();
      const writer = new TranscriptWriter({ dataDir: tmpDir });

      writer.appendEvent(SESSION_INFO, { type: 'assistant', content: [{ type: 'text', text: 'A' }] });
      writer.appendEvent(SESSION_INFO, { type: 'user', content: [{ type: 'text', text: 'B' }] });

      const events = writer.getBufferedEvents(SESSION_INFO.sessionId);
      assert.equal(events[0].eventNo, 0);
      assert.equal(events[1].eventNo, 1);
    });
  });

  describe('flush()', () => {
    test('writes events.jsonl to correct directory structure', async () => {
      const { TranscriptWriter } = await loadModules();
      const writer = new TranscriptWriter({ dataDir: tmpDir });

      writer.appendEvent(SESSION_INFO, {
        type: 'assistant',
        content: [{ type: 'text', text: 'test message' }],
      });

      await writer.flush(SESSION_INFO);

      const sessionDir = join(
        tmpDir,
        'threads',
        SESSION_INFO.threadId,
        SESSION_INFO.catId,
        'sessions',
        SESSION_INFO.sessionId,
      );
      const files = await readdir(sessionDir);
      assert.ok(files.includes('events.jsonl'), `Expected events.jsonl in ${files}`);

      // Read and validate JSONL
      const content = await readFile(join(sessionDir, 'events.jsonl'), 'utf-8');
      const lines = content
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l));
      assert.equal(lines.length, 1);
      assert.equal(lines[0].v, 1);
      assert.equal(lines[0].threadId, 'thread-1');
      assert.equal(lines[0].catId, 'opus');
      assert.equal(lines[0].sessionId, 'sess-abc');
      assert.deepEqual(lines[0].event.content, [{ type: 'text', text: 'test message' }]);
    });

    test('writes index.json with sparse offsets', async () => {
      const { TranscriptWriter } = await loadModules();
      const writer = new TranscriptWriter({ dataDir: tmpDir, indexStride: 2 });

      // Write 5 events
      for (let i = 0; i < 5; i++) {
        writer.appendEvent(SESSION_INFO, {
          type: 'assistant',
          content: [{ type: 'text', text: `msg ${i}` }],
        });
      }

      await writer.flush(SESSION_INFO);

      const sessionDir = join(
        tmpDir,
        'threads',
        SESSION_INFO.threadId,
        SESSION_INFO.catId,
        'sessions',
        SESSION_INFO.sessionId,
      );
      const indexContent = await readFile(join(sessionDir, 'index.json'), 'utf-8');
      const index = JSON.parse(indexContent);

      assert.equal(index.v, 1);
      assert.equal(index.eventCount, 5);
      assert.equal(index.stride, 2);
      // With stride 2 and 5 events: offsets at event 0, 2, 4
      assert.ok(index.offsets.length >= 3, `Expected >= 3 offsets, got ${index.offsets.length}`);
      assert.equal(index.offsets[0], 0); // First event always at offset 0
    });

    test('clears buffer after flush', async () => {
      const { TranscriptWriter } = await loadModules();
      const writer = new TranscriptWriter({ dataDir: tmpDir });

      writer.appendEvent(SESSION_INFO, {
        type: 'assistant',
        content: [{ type: 'text', text: 'test' }],
      });

      await writer.flush(SESSION_INFO);
      assert.equal(writer.getEventCount(SESSION_INFO.sessionId), 0);
    });

    test('flush with no events is no-op', async () => {
      const { TranscriptWriter } = await loadModules();
      const writer = new TranscriptWriter({ dataDir: tmpDir });

      // Should not throw
      await writer.flush(SESSION_INFO);
      assert.equal(writer.getEventCount(SESSION_INFO.sessionId), 0);
    });
  });

  describe('generateExtractiveDigest()', () => {
    test('produces digest with basic session info', async () => {
      const { TranscriptWriter } = await loadModules();
      const writer = new TranscriptWriter({ dataDir: tmpDir });

      writer.appendEvent(SESSION_INFO, {
        type: 'assistant',
        content: [{ type: 'text', text: 'I will edit the file' }],
      });

      const digest = writer.generateExtractiveDigest(SESSION_INFO, {
        createdAt: 1000,
        sealedAt: 2000,
      });

      assert.equal(digest.v, 1);
      assert.equal(digest.sessionId, 'sess-abc');
      assert.equal(digest.threadId, 'thread-1');
      assert.equal(digest.catId, 'opus');
      assert.equal(digest.seq, 0);
      assert.equal(digest.time.createdAt, 1000);
      assert.equal(digest.time.sealedAt, 2000);
    });

    test('extracts tool names from tool_use events', async () => {
      const { TranscriptWriter } = await loadModules();
      const writer = new TranscriptWriter({ dataDir: tmpDir });

      writer.appendEvent(SESSION_INFO, {
        type: 'tool_use',
        name: 'Edit',
        input: { file_path: '/src/foo.ts' },
      });
      writer.appendEvent(SESSION_INFO, {
        type: 'tool_use',
        name: 'Write',
        input: { file_path: '/src/bar.ts' },
      });
      writer.appendEvent(SESSION_INFO, {
        type: 'tool_use',
        name: 'Edit',
        input: { file_path: '/src/baz.ts' },
      });

      const digest = writer.generateExtractiveDigest(SESSION_INFO, {
        createdAt: 1000,
        sealedAt: 2000,
      });

      // Invocations section should mention tools
      const allTools = digest.invocations.flatMap((inv) => inv.toolNames ?? []);
      assert.ok(allTools.includes('Edit'));
      assert.ok(allTools.includes('Write'));
    });

    test('extracts file paths from tool_use events', async () => {
      const { TranscriptWriter } = await loadModules();
      const writer = new TranscriptWriter({ dataDir: tmpDir });

      writer.appendEvent(SESSION_INFO, {
        type: 'tool_use',
        name: 'Edit',
        input: { file_path: '/src/foo.ts' },
      });
      writer.appendEvent(SESSION_INFO, {
        type: 'tool_use',
        name: 'Write',
        input: { file_path: '/src/bar.ts' },
      });

      const digest = writer.generateExtractiveDigest(SESSION_INFO, {
        createdAt: 1000,
        sealedAt: 2000,
      });

      assert.ok(digest.filesTouched.length >= 2);
      const paths = digest.filesTouched.map((f) => f.path);
      assert.ok(paths.includes('/src/foo.ts'));
      assert.ok(paths.includes('/src/bar.ts'));
    });

    test('extracts errors from tool_result error events', async () => {
      const { TranscriptWriter } = await loadModules();
      const writer = new TranscriptWriter({ dataDir: tmpDir });

      writer.appendEvent(SESSION_INFO, {
        type: 'tool_result',
        is_error: true,
        content: 'File not found: /src/missing.ts',
      });

      const digest = writer.generateExtractiveDigest(SESSION_INFO, {
        createdAt: 1000,
        sealedAt: 2000,
      });

      assert.ok(digest.errors.length >= 1);
      assert.ok(digest.errors[0].message.includes('File not found'));
    });

    test('R11 P1-2: extracts from AgentMessage fields (toolName/toolInput/error), not raw NDJSON (RED)', async () => {
      // In production, appendEvent receives AgentMessage objects (cast to Record<string,unknown>).
      // AgentMessage uses toolName/toolInput (not name/input) and type:'error'+error (not is_error+content).
      // The digest extractor must read the correct fields.
      const { TranscriptWriter } = await loadModules();
      const writer = new TranscriptWriter({ dataDir: tmpDir });

      // Real AgentMessage shape for tool_use (from ClaudeAgentService)
      writer.appendEvent(SESSION_INFO, {
        type: 'tool_use',
        catId: 'opus',
        toolName: 'Edit',
        toolInput: { file_path: '/src/foo.ts' },
        timestamp: Date.now(),
      });
      writer.appendEvent(SESSION_INFO, {
        type: 'tool_use',
        catId: 'opus',
        toolName: 'Write',
        toolInput: { file_path: '/src/bar.ts' },
        timestamp: Date.now(),
      });

      // Real AgentMessage shape for error (type='error' + error field)
      writer.appendEvent(SESSION_INFO, {
        type: 'error',
        catId: 'opus',
        error: 'File not found: /src/missing.ts',
        timestamp: Date.now(),
      });

      const digest = writer.generateExtractiveDigest(SESSION_INFO, {
        createdAt: 1000,
        sealedAt: 2000,
      });

      // Tool names must be extracted from toolName field
      const allTools = digest.invocations.flatMap((inv) => inv.toolNames ?? []);
      assert.ok(allTools.includes('Edit'), 'digest must extract toolName="Edit" from AgentMessage');
      assert.ok(allTools.includes('Write'), 'digest must extract toolName="Write" from AgentMessage');

      // File paths must be extracted from toolInput field
      const paths = digest.filesTouched.map((f) => f.path);
      assert.ok(paths.includes('/src/foo.ts'), 'digest must extract file_path from toolInput');
      assert.ok(paths.includes('/src/bar.ts'), 'digest must extract file_path from toolInput');

      // Errors must be extracted from type='error' messages
      assert.ok(digest.errors.length >= 1, 'digest must extract errors from AgentMessage error type');
      assert.ok(
        digest.errors[0].message.includes('File not found'),
        'error message must come from AgentMessage.error field',
      );
    });

    test('captures recent visible assistant text for session-continuity bootstrap', async () => {
      const { TranscriptWriter } = await loadModules();
      const writer = new TranscriptWriter({ dataDir: tmpDir });

      writer.appendEvent(SESSION_INFO, {
        type: 'text',
        catId: 'codex',
        content: '我接球继续 review，球在我手上。',
        timestamp: Date.now(),
      });
      writer.appendEvent(SESSION_INFO, {
        type: 'system_info',
        catId: 'codex',
        content: JSON.stringify({ type: 'context_health' }),
        timestamp: Date.now(),
      });
      writer.appendEvent(SESSION_INFO, {
        type: 'assistant',
        content: [{ type: 'text', text: '@opus\n请继续 merge-gate。' }],
      });

      const digest = writer.generateExtractiveDigest(SESSION_INFO, {
        createdAt: 1000,
        sealedAt: 2000,
      });

      assert.ok(Array.isArray(digest.recentMessages), 'digest should expose recent visible messages');
      assert.deepEqual(
        digest.recentMessages.map((msg) => msg.content),
        ['我接球继续 review，球在我手上。', '@opus\n请继续 merge-gate。'],
        'digest should include visible text and exclude system_info noise',
      );
    });

    test('coalesces streamed text chunks before keeping recent messages', async () => {
      const { TranscriptWriter } = await loadModules();
      const writer = new TranscriptWriter({ dataDir: tmpDir });

      writer.appendEvent(
        SESSION_INFO,
        { type: 'text', catId: 'codex', content: 'Hello ', textMode: 'append', timestamp: Date.now() },
        'inv-stream',
      );
      writer.appendEvent(
        SESSION_INFO,
        { type: 'text', catId: 'codex', content: 'world', textMode: 'append', timestamp: Date.now() },
        'inv-stream',
      );
      writer.appendEvent(
        SESSION_INFO,
        { type: 'text', catId: 'codex', content: 'Draft', textMode: 'replace', timestamp: Date.now() },
        'inv-replace',
      );
      writer.appendEvent(
        SESSION_INFO,
        { type: 'text', catId: 'codex', content: 'Final answer', textMode: 'replace', timestamp: Date.now() },
        'inv-replace',
      );

      const digest = writer.generateExtractiveDigest(SESSION_INFO, {
        createdAt: 1000,
        sealedAt: 2000,
      });

      assert.deepEqual(
        digest.recentMessages.map((msg) => msg.content),
        ['Hello world', 'Final answer'],
        'stream chunks should not occupy separate recent message slots',
      );
    });

    test('preserves repeated-cat turn boundaries within one invocation', async () => {
      const { TranscriptWriter } = await loadModules();
      const writer = new TranscriptWriter({ dataDir: tmpDir });

      writer.appendEvent(
        SESSION_INFO,
        { type: 'text', catId: 'codex', content: 'Codex first ', textMode: 'append', timestamp: Date.now() },
        'inv-route',
      );
      writer.appendEvent(
        SESSION_INFO,
        { type: 'text', catId: 'codex', content: 'turn', textMode: 'append', timestamp: Date.now() },
        'inv-route',
      );
      writer.appendEvent(
        SESSION_INFO,
        { type: 'text', catId: 'opus', content: 'Opus middle turn', textMode: 'append', timestamp: Date.now() },
        'inv-route',
      );
      writer.appendEvent(
        SESSION_INFO,
        { type: 'text', catId: 'codex', content: 'Codex second turn', textMode: 'append', timestamp: Date.now() },
        'inv-route',
      );

      const digest = writer.generateExtractiveDigest(SESSION_INFO, {
        createdAt: 1000,
        sealedAt: 2000,
      });

      assert.deepEqual(
        digest.recentMessages.map((msg) => msg.content),
        ['Codex first turn', 'Opus middle turn', 'Codex second turn'],
        'same-cat streams separated by another visible turn must remain distinct recent messages',
      );
    });

    test('excludes leaked tool-call payloads from recent visible messages', async () => {
      const { TranscriptWriter } = await loadModules();
      const writer = new TranscriptWriter({ dataDir: tmpDir });

      writer.appendEvent(
        SESSION_INFO,
        {
          type: 'text',
          catId: 'codex',
          content: `先看实现，再补测试。

{"tool_uses":[{"recipient_name":"functions.exec_command","parameters":{"cmd":"sed -n '1,220p' foo.ts"}}]}`,
          timestamp: Date.now(),
        },
        'inv-leak',
      );

      const digest = writer.generateExtractiveDigest(SESSION_INFO, {
        createdAt: 1000,
        sealedAt: 2000,
      });

      assert.deepEqual(
        digest.recentMessages.map((msg) => msg.content),
        ['先看实现，再补测试。'],
        'digest should match the stripped user-visible assistant text',
      );
      assert.ok(digest.recentMessages.every((msg) => !msg.content.includes('tool_uses')));
      assert.ok(digest.recentMessages.every((msg) => !msg.content.includes('recipient_name')));
    });

    test('excludes leaked tool-call payloads split across streamed text chunks', async () => {
      const { TranscriptWriter } = await loadModules();
      const writer = new TranscriptWriter({ dataDir: tmpDir });

      writer.appendEvent(
        SESSION_INFO,
        {
          type: 'text',
          catId: 'codex',
          content: `先看实现，再补测试。

{`,
          textMode: 'append',
          timestamp: Date.now(),
        },
        'inv-split-leak',
      );
      writer.appendEvent(
        SESSION_INFO,
        {
          type: 'text',
          catId: 'codex',
          content: `"tool_uses":[{"recipient_name":"functions.exec_command","parameters":{"cmd":"echo leaked"}}]}`,
          textMode: 'append',
          timestamp: Date.now(),
        },
        'inv-split-leak',
      );

      const digest = writer.generateExtractiveDigest(SESSION_INFO, {
        createdAt: 1000,
        sealedAt: 2000,
      });

      assert.deepEqual(
        digest.recentMessages.map((msg) => msg.content),
        ['先看实现，再补测试。'],
        'digest should strip payloads that only become detectable after stream coalescing',
      );
      assert.ok(digest.recentMessages.every((msg) => !msg.content.includes('tool_uses')));
      assert.ok(digest.recentMessages.every((msg) => !msg.content.includes('recipient_name')));
    });

    test('captures latest continuity capsule from session seal system_info', async () => {
      const { TranscriptWriter } = await loadModules();
      const writer = new TranscriptWriter({ dataDir: tmpDir });

      const continuityCapsule = {
        v: 1,
        threadId: 'thread-1',
        catId: 'codex',
        mode: 'independent',
        a2aEnabled: true,
        ballState: 'in_progress',
        continuationReason: 'threshold_seal',
        createdAt: 1234,
        invocationId: 'inv-1',
        seal: { sessionId: 'sess-1', sessionSeq: 1, reason: 'threshold' },
      };
      writer.appendEvent(SESSION_INFO, {
        type: 'system_info',
        catId: 'codex',
        content: JSON.stringify({ type: 'session_seal_requested', continuityCapsule }),
        timestamp: Date.now(),
      });

      const digest = writer.generateExtractiveDigest(SESSION_INFO, {
        createdAt: 1000,
        sealedAt: 2000,
      });

      assert.deepEqual(digest.continuityCapsule, continuityCapsule);
    });

    test('writes digest.extractive.json during flush', async () => {
      const { TranscriptWriter } = await loadModules();
      const writer = new TranscriptWriter({ dataDir: tmpDir });

      writer.appendEvent(SESSION_INFO, {
        type: 'assistant',
        content: [{ type: 'text', text: 'done' }],
      });

      await writer.flush(SESSION_INFO, {
        createdAt: 1000,
        sealedAt: 2000,
      });

      const sessionDir = join(
        tmpDir,
        'threads',
        SESSION_INFO.threadId,
        SESSION_INFO.catId,
        'sessions',
        SESSION_INFO.sessionId,
      );
      const digestContent = await readFile(join(sessionDir, 'digest.extractive.json'), 'utf-8');
      const digest = JSON.parse(digestContent);
      assert.equal(digest.v, 1);
      assert.equal(digest.sessionId, 'sess-abc');
    });
  });
});

/**
 * 增量落盘（耐久性）。
 *
 * 原行为：事件只攒在内存，直到 seal 才整文件写一次。API 在 seal 前崩溃 → 整段原始事件流
 * 全丢，而 Redis 消息过期后 IndexBuilder 正是靠这份 JSONL 回填 passage。
 */
describe('TranscriptWriter incremental durability', () => {
  let tmpDir;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'transcript-durability-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function loadWriter() {
    const { TranscriptWriter } = await import('../dist/domains/cats/services/session/TranscriptWriter.js');
    return TranscriptWriter;
  }

  const SESSION = {
    sessionId: 'sess-durable',
    threadId: 'thread-d',
    catId: 'opus',
    cliSessionId: 'cli-d',
    seq: 0,
  };

  function sessionDirOf(dir, session = SESSION) {
    return join(dir, 'threads', session.threadId, session.catId, 'sessions', session.sessionId);
  }

  async function readLines(dir, session = SESSION) {
    const content = await readFile(join(sessionDirOf(dir, session), 'events.jsonl'), 'utf-8');
    return content
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line));
  }

  test('events reach events.jsonl before any seal', async () => {
    const TranscriptWriter = await loadWriter();
    const writer = new TranscriptWriter({ dataDir: tmpDir });

    writer.appendEvent(SESSION, { type: 'text', content: 'first' });
    writer.appendEvent(SESSION, { type: 'text', content: 'second' });
    await writer.drain(SESSION.sessionId);

    const lines = await readLines(tmpDir);
    assert.equal(lines.length, 2, 'both events must already be on disk without a flush');
    assert.deepEqual(
      lines.map((l) => l.event.content),
      ['first', 'second'],
    );
    assert.deepEqual(
      lines.map((l) => l.eventNo),
      [0, 1],
    );
    // 缓冲仍在，因为 seal 时的 digest 依赖它
    assert.equal(writer.getEventCount(SESSION.sessionId), 2);
  });

  test('flush only appends the tail instead of rewriting the file', async () => {
    const TranscriptWriter = await loadWriter();
    const writer = new TranscriptWriter({ dataDir: tmpDir, indexStride: 2 });

    for (let i = 0; i < 3; i++) {
      writer.appendEvent(SESSION, { type: 'text', content: `msg ${i}` });
    }
    await writer.drain(SESSION.sessionId);
    // 这条在增量写之后追加，只能靠 flush 补齐
    writer.appendEvent(SESSION, { type: 'text', content: 'msg 3' });

    await writer.flush(SESSION, { createdAt: 1000, sealedAt: 2000 });

    const lines = await readLines(tmpDir);
    assert.equal(lines.length, 4, '不能有重复行，也不能丢尾部事件');
    assert.deepEqual(
      lines.map((l) => l.eventNo),
      [0, 1, 2, 3],
    );

    const index = JSON.parse(await readFile(join(sessionDirOf(tmpDir), 'index.json'), 'utf-8'));
    assert.equal(index.eventCount, 4);
    assert.equal(index.stride, 2);
    assert.deepEqual(index.offsets.length, 2, 'stride 2 + 4 事件 → eventNo 0 与 2 各一个偏移');
    assert.equal(index.offsets[0], 0);
    // 偏移必须指向对应行的真实起始字节
    const raw = await readFile(join(sessionDirOf(tmpDir), 'events.jsonl'), 'utf-8');
    const buf = Buffer.from(raw, 'utf-8');
    assert.equal(JSON.parse(buf.subarray(index.offsets[1]).toString('utf-8').split('\n')[0]).eventNo, 2);

    assert.equal(writer.getEventCount(SESSION.sessionId), 0, 'flush 后清缓冲');
  });

  test('a new writer continues a transcript left by a crashed process without duplicating eventNo', async () => {
    const TranscriptWriter = await loadWriter();

    // 第一个进程：写了 3 个事件就"崩溃"（不 flush，直接丢弃实例）
    const crashed = new TranscriptWriter({ dataDir: tmpDir, indexStride: 2 });
    for (let i = 0; i < 3; i++) {
      crashed.appendEvent(SESSION, { type: 'text', content: `pre-crash ${i}` });
    }
    await crashed.drain(SESSION.sessionId);
    assert.equal((await readLines(tmpDir)).length, 3, '崩溃前的事件必须已落盘');

    // 重启：session 在 Redis 里仍是 active，同一 session 继续收事件，
    // 但新进程的内存缓冲从 eventNo 0 重新计数。
    const restarted = new TranscriptWriter({ dataDir: tmpDir, indexStride: 2 });
    restarted.appendEvent(SESSION, { type: 'text', content: 'post-restart 0' });
    restarted.appendEvent(SESSION, { type: 'text', content: 'post-restart 1' });
    await restarted.flush(SESSION, { createdAt: 1000, sealedAt: 2000 });

    const lines = await readLines(tmpDir);
    assert.equal(lines.length, 5, '重启前后的事件都要保留');
    assert.deepEqual(
      lines.map((l) => l.eventNo),
      [0, 1, 2, 3, 4],
      'eventNo 必须跨进程连续，不能重复',
    );
    assert.deepEqual(
      lines.map((l) => l.event.content),
      ['pre-crash 0', 'pre-crash 1', 'pre-crash 2', 'post-restart 0', 'post-restart 1'],
    );

    const index = JSON.parse(await readFile(join(sessionDirOf(tmpDir), 'index.json'), 'utf-8'));
    assert.equal(index.eventCount, 5, 'index 要算上崩溃前那批');
    assert.equal(index.offsets[0], 0);
  });

  test('deleteThread drops in-flight appends instead of letting them resurrect the directory', async () => {
    const TranscriptWriter = await loadWriter();
    const writer = new TranscriptWriter({ dataDir: tmpDir });

    writer.appendEvent(SESSION, { type: 'text', content: 'secret' });
    // 故意不 drain：删除时可能还有 append 在途
    const removed = await writer.deleteThread(SESSION.threadId);
    assert.equal(removed, true);
    await writer.drain();

    await assert.rejects(readFile(join(sessionDirOf(tmpDir), 'events.jsonl'), 'utf-8'), /ENOENT/);
    assert.equal(writer.getEventCount(SESSION.sessionId), 0);
  });

  test('a failed append leaves the events buffered so the next pass retries', async () => {
    const TranscriptWriter = await loadWriter();
    // dataDir 指向一个普通文件，任何 mkdir 都会失败 → 落盘必然报错
    const blocked = join(tmpDir, 'not-a-dir');
    await writeFile(blocked, 'x', 'utf-8');
    const writer = new TranscriptWriter({ dataDir: blocked });

    writer.appendEvent(SESSION, { type: 'text', content: 'kept' });
    await writer.drain(SESSION.sessionId);

    // appendEvent 不能抛错，事件也不能丢
    assert.equal(writer.getEventCount(SESSION.sessionId), 1);
  });
});
