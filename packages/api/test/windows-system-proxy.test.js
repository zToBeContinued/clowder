import assert from 'node:assert/strict';
import { test } from 'node:test';

const { parseProxyServerValue, injectWindowsSystemProxy } = await import('../dist/config/windows-system-proxy.js');

test('parseProxyServerValue: host:port 形态补 http 前缀', () => {
  assert.equal(parseProxyServerValue('127.0.0.1:7890'), 'http://127.0.0.1:7890');
  assert.equal(parseProxyServerValue('  10.0.0.2:8080  '), 'http://10.0.0.2:8080');
});

test('parseProxyServerValue: 已带 scheme 原样返回', () => {
  assert.equal(parseProxyServerValue('http://127.0.0.1:7890'), 'http://127.0.0.1:7890');
});

test('parseProxyServerValue: 多协议形态取 https 优先、其次 http、最后 socks', () => {
  assert.equal(
    parseProxyServerValue('http=127.0.0.1:7890;https=127.0.0.1:7891;ftp=127.0.0.1:7892'),
    'http://127.0.0.1:7891',
  );
  assert.equal(parseProxyServerValue('http=127.0.0.1:7890;ftp=x'), 'http://127.0.0.1:7890');
  assert.equal(parseProxyServerValue('socks=127.0.0.1:1080'), 'socks5://127.0.0.1:1080');
});

test('parseProxyServerValue: 空值与无效形态返回 null', () => {
  assert.equal(parseProxyServerValue(''), null);
  assert.equal(parseProxyServerValue('   '), null);
  assert.equal(parseProxyServerValue('ftp=127.0.0.1:21'), null);
});

test('injectWindowsSystemProxy: 显式代理配置存在时不注入不覆盖', () => {
  const saved = { ...process.env };
  try {
    for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'NO_PROXY']) {
      delete process.env[k];
    }
    process.env.HTTPS_PROXY = 'http://explicit:1';
    injectWindowsSystemProxy();
    assert.equal(process.env.HTTPS_PROXY, 'http://explicit:1', '显式配置必须原样保留');
    assert.equal(process.env.HTTP_PROXY, undefined, '不得补写其它代理变量');
  } finally {
    for (const k of Object.keys(process.env)) {
      if (!(k in saved)) delete process.env[k];
    }
    Object.assign(process.env, saved);
  }
});
