import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

test('clowder message progress posts a non-terminal callback payload', async () => {
  let capturedPath = '';
  let capturedBody = {};
  let capturedAuthorization = '';
  const server = createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      capturedPath = request.url ?? '';
      capturedAuthorization = request.headers.authorization ?? '';
      capturedBody = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ status: 'ok', messageId: 'progress-1' }));
    });
  });

  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  try {
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const { stdout } = await execFileAsync(
      process.execPath,
      [
        resolve(repoRoot, 'bin/clowder'),
        'message',
        'progress',
        '--kind',
        'ack',
        '--client-message-id',
        'ack:inv-cli:opus',
        '--text',
        '我先核对消息链路，再跑回归。',
      ],
      {
        env: {
          ...process.env,
          CLOWDER_API_URL: `http://127.0.0.1:${address.port}`,
          CAT_CAFE_INVOCATION_ID: 'inv-cli',
          CAT_CAFE_CALLBACK_TOKEN: 'token-cli',
          CAT_CAFE_THREAD_ID: 'thread-cli',
          CLOWDER_API_BEARER_TOKEN: 'cli-global-secret',
        },
      },
    );

    assert.equal(capturedPath, '/api/callbacks/post-progress');
    assert.deepEqual(capturedBody, {
      invocationId: 'inv-cli',
      callbackToken: 'token-cli',
      content: '我先核对消息链路，再跑回归。',
      kind: 'ack',
      clientMessageId: 'ack:inv-cli:opus',
    });
    assert.equal(capturedAuthorization, 'Bearer cli-global-secret');
    assert.match(stdout, /Progress sent to thread-cli: progress-1/);
  } finally {
    await new Promise((resolveClose, reject) => server.close((error) => (error ? reject(error) : resolveClose())));
  }
});

test('clowder message progress exits non-zero when the invocation is stale', async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ status: 'stale_ignored' }));
  });
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));

  try {
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    await assert.rejects(
      execFileAsync(
        process.execPath,
        [
          resolve(repoRoot, 'bin/clowder'),
          'message',
          'progress',
          '--kind',
          'ack',
          '--client-message-id',
          'ack:inv-stale:opus',
          '--text',
          '我先核对消息链路。',
        ],
        {
          env: {
            ...process.env,
            CLOWDER_API_URL: `http://127.0.0.1:${address.port}`,
            CAT_CAFE_INVOCATION_ID: 'inv-stale',
            CAT_CAFE_CALLBACK_TOKEN: 'token-stale',
          },
        },
      ),
      /superseded/,
    );
  } finally {
    await new Promise((resolveClose, reject) => server.close((error) => (error ? reject(error) : resolveClose())));
  }
});
