/**
 * 系统代理读取测试
 *
 * 背景（2026-08-17 实测）：grok 只认 HTTP_PROXY 环境变量、不读 Windows 系统代理，
 * 而 kiro-cli / cursor-agent 相反（完全无视该变量）。因此把「Clash 已开系统代理」
 * 翻译成环境变量注给子进程，对 grok 是必需的，对另两个无副作用。
 *
 * 硬约束：只读注册表。本测试全程注入假 runner，不触碰真实注册表。
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

const MODULE_PATH = '../dist/utils/system-proxy.js';

function makeRunner(values) {
  return (args) => {
    // args 形如 ['query', '<key>', '/v', 'ProxyEnable']
    const name = args[args.length - 1];
    if (!(name in values)) throw new Error(`ERROR: 系统找不到指定的注册表项或值 (${name})`);
    const v = values[name];
    const type = typeof v === 'number' ? 'REG_DWORD' : 'REG_SZ';
    const shown = typeof v === 'number' ? `0x${v.toString(16)}` : v;
    return `\r\n${args[1]}\r\n    ${name}    ${type}    ${shown}\r\n\r\n`;
  };
}

describe('getSystemProxyEnv', () => {
  beforeEach(async () => {
    const { resetSystemProxyCacheForTests } = await import(MODULE_PATH);
    resetSystemProxyCacheForTests();
  });

  it('系统代理开启时给出 HTTP/HTTPS/ALL_PROXY', async () => {
    const { getSystemProxyEnv } = await import(MODULE_PATH);
    const result = getSystemProxyEnv({
      platform: 'win32',
      env: {},
      useCache: false,
      runner: makeRunner({ ProxyEnable: 1, ProxyServer: '127.0.0.1:7890' }),
    });
    assert.equal(result.HTTP_PROXY, 'http://127.0.0.1:7890');
    assert.equal(result.HTTPS_PROXY, 'http://127.0.0.1:7890');
    assert.equal(result.ALL_PROXY, 'http://127.0.0.1:7890');
  });

  it('ProxyEnable=0 时不注入任何东西', async () => {
    const { getSystemProxyEnv } = await import(MODULE_PATH);
    const result = getSystemProxyEnv({
      platform: 'win32',
      env: {},
      useCache: false,
      runner: makeRunner({ ProxyEnable: 0, ProxyServer: '127.0.0.1:7890' }),
    });
    assert.deepEqual(result, {});
  });

  it('父进程已显式配代理时一律不覆盖', async () => {
    const { getSystemProxyEnv } = await import(MODULE_PATH);
    for (const env of [
      { HTTP_PROXY: 'http://explicit:1' },
      { HTTPS_PROXY: 'http://explicit:1' },
      { ALL_PROXY: 'socks5://explicit:1' },
      { http_proxy: 'http://explicit:1' },
    ]) {
      const result = getSystemProxyEnv({
        platform: 'win32',
        env,
        useCache: false,
        runner: makeRunner({ ProxyEnable: 1, ProxyServer: '127.0.0.1:7890' }),
      });
      assert.deepEqual(result, {}, `不应覆盖 ${Object.keys(env)[0]}`);
    }
  });

  it('非 Windows 且无注入 runner 时返回空', async () => {
    const { getSystemProxyEnv } = await import(MODULE_PATH);
    assert.deepEqual(getSystemProxyEnv({ platform: 'darwin', env: {}, useCache: false }), {});
  });

  it('注册表读不到时安静返回空，不抛错', async () => {
    const { getSystemProxyEnv } = await import(MODULE_PATH);
    const result = getSystemProxyEnv({
      platform: 'win32',
      env: {},
      useCache: false,
      runner: () => {
        throw new Error('ERROR: 系统找不到指定的注册表项或值');
      },
    });
    assert.deepEqual(result, {});
  });

  it('ProxyOverride 转成 NO_PROXY，<local> 展开为 localhost/127.0.0.1', async () => {
    const { getSystemProxyEnv } = await import(MODULE_PATH);
    const result = getSystemProxyEnv({
      platform: 'win32',
      env: {},
      useCache: false,
      runner: makeRunner({
        ProxyEnable: 1,
        ProxyServer: '127.0.0.1:7890',
        ProxyOverride: '<local>;*.corp.com',
      }),
    });
    assert.equal(result.NO_PROXY, '*.corp.com,localhost,127.0.0.1');
  });
});

describe('parseProxyServerValue', () => {
  it('裸 host:port 原样返回', async () => {
    const { parseProxyServerValue } = await import(MODULE_PATH);
    assert.equal(parseProxyServerValue('127.0.0.1:7890'), '127.0.0.1:7890');
  });

  it('分协议形式优先取 https', async () => {
    const { parseProxyServerValue } = await import(MODULE_PATH);
    assert.equal(parseProxyServerValue('http=h:1;https=s:2;ftp=f:3'), 's:2');
  });

  it('只有 http= 时退回 http', async () => {
    const { parseProxyServerValue } = await import(MODULE_PATH);
    assert.equal(parseProxyServerValue('http=h:1;ftp=f:3'), 'h:1');
  });

  it('空值返回 null', async () => {
    const { parseProxyServerValue } = await import(MODULE_PATH);
    assert.equal(parseProxyServerValue('   '), null);
  });
});
