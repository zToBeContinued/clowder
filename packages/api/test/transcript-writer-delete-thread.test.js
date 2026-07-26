/**
 * TranscriptWriter.deleteThread — F24 Phase C cascade on thread purge.
 *
 * Transcripts hold the raw session events on disk, so a permanent delete that only
 * clears Redis leaves the whole conversation readable in <dataDir>/threads/<threadId>/.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

describe('TranscriptWriter.deleteThread', () => {
  let dataDir;
  let writer;

  const session = (threadId, sessionId) => ({
    sessionId,
    threadId,
    catId: 'opus',
    cliSessionId: `cli-${sessionId}`,
    seq: 0,
  });

  beforeEach(async () => {
    const { TranscriptWriter } = await import('../dist/domains/cats/services/session/TranscriptWriter.js');
    dataDir = await mkdtemp(join(tmpdir(), 'transcript-delete-'));
    writer = new TranscriptWriter({ dataDir });
  });

  afterEach(async () => {
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  });

  it('removes the whole thread directory from disk', async () => {
    const info = session('thread-A', 'sess-1');
    writer.appendEvent(info, { type: 'text', text: 'hello' });
    await writer.flush(info);
    assert.ok(await exists(join(dataDir, 'threads', 'thread-A')));

    assert.equal(await writer.deleteThread('thread-A'), true);
    assert.equal(await exists(join(dataDir, 'threads', 'thread-A')), false);
  });

  it('drops pending buffers so a later flush cannot recreate the directory', async () => {
    const info = session('thread-A', 'sess-1');
    writer.appendEvent(info, { type: 'text', text: 'not flushed yet' });

    await writer.deleteThread('thread-A');
    assert.equal(writer.getEventCount('sess-1'), 0);

    await writer.flush(info);
    assert.equal(await exists(join(dataDir, 'threads', 'thread-A')), false);
  });

  it('leaves other threads on disk and in the buffer', async () => {
    const doomed = session('thread-A', 'sess-1');
    const survivor = session('thread-B', 'sess-2');
    writer.appendEvent(doomed, { type: 'text', text: 'a' });
    writer.appendEvent(survivor, { type: 'text', text: 'b' });
    await writer.flush(survivor);

    await writer.deleteThread('thread-A');

    assert.ok(await exists(join(dataDir, 'threads', 'thread-B')));
    assert.equal(writer.getEventCount('sess-1'), 0);
  });

  it('is a no-op for a thread that never wrote anything', async () => {
    assert.equal(await writer.deleteThread('thread-never-existed'), true);
  });
});
