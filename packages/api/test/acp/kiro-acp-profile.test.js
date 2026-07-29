import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { KIRO_MCP_WHITELIST, createKiroAcpProfile, getKiroAcpIdleTtlMs } = await import(
  '../../dist/domains/cats/services/agents/providers/acp/kiro-acp-profile.js'
);

describe('getKiroAcpIdleTtlMs', () => {
  // 冷启动次数 = kiro-cli 安装包下载次数，所以这个值必须可调、且非法输入不能把
  // TTL 变成 0（那等于每次调用完就杀进程，下载和 session_init 全部翻倍）。
  const ENV = 'CAT_CAFE_KIRO_ACP_IDLE_TTL_MS';

  it('defaults to 30 minutes, reads fresh on every call, and rejects invalid values', () => {
    const saved = process.env[ENV];
    try {
      delete process.env[ENV];
      assert.equal(getKiroAcpIdleTtlMs(), 30 * 60 * 1000, '未设置时默认 30 分钟');

      // 热更新：不重新 import，改完立刻生效
      process.env[ENV] = '3600000';
      assert.equal(getKiroAcpIdleTtlMs(), 3_600_000);
      process.env[ENV] = '60000';
      assert.equal(getKiroAcpIdleTtlMs(), 60_000);

      for (const bad of ['0', '-1', 'abc', '']) {
        process.env[ENV] = bad;
        assert.equal(getKiroAcpIdleTtlMs(), 30 * 60 * 1000, `非法取值 ${JSON.stringify(bad)} 应回退默认值`);
      }
    } finally {
      if (saved === undefined) delete process.env[ENV];
      else process.env[ENV] = saved;
    }
  });
});

describe('kiro-acp-profile', () => {
  it('uses the official kiro-cli acp entrypoint, trusts all tools and disables multiplexing', () => {
    const profile = createKiroAcpProfile({});

    assert.equal(profile.command, 'kiro-cli');
    assert.deepEqual(profile.startupArgs, ['acp', '--trust-all-tools']);
    assert.equal(profile.supportsMultiplexing, false);
    assert.deepEqual(profile.mcpServers, []);
    assert.equal(profile.model, undefined);
  });

  it('appends defaultArgs after the mandatory trust policy and honors a custom command', () => {
    const profile = createKiroAcpProfile({
      cli: { command: 'C:/tools/kiro-cli.exe', defaultArgs: ['--verbose'] },
    });

    assert.equal(profile.command, 'C:/tools/kiro-cli.exe');
    assert.deepEqual(profile.startupArgs, ['acp', '--trust-all-tools', '--verbose']);
  });

  it('deduplicates a leading acp argument', () => {
    const profile = createKiroAcpProfile({ cli: { command: 'kiro-cli', defaultArgs: ['acp', '--verbose'] } });
    assert.deepEqual(profile.startupArgs, ['acp', '--trust-all-tools', '--verbose']);
  });

  it('normalizes trust-all aliases and duplicates to exactly one long-form flag', () => {
    for (const defaultArgs of [
      ['--trust-all-tools', '--verbose'],
      ['-a', '--verbose'],
      ['acp', '-a', '--trust-all-tools', '--trust-all-tools', '--verbose'],
    ]) {
      const profile = createKiroAcpProfile({ cli: { defaultArgs } });
      assert.deepEqual(profile.startupArgs, ['acp', '--trust-all-tools', '--verbose']);
    }
  });

  it('only exposes a non-empty trimmed model override', () => {
    assert.equal(createKiroAcpProfile({ defaultModel: '  gpt-5.6-sol  ' }).model, 'gpt-5.6-sol');
    assert.equal(createKiroAcpProfile({ defaultModel: '   ' }).model, undefined);
  });

  it('whitelists the four builtin Clowder MCP servers plus codegraph', () => {
    // codegraph lets cats answer structural questions from an index instead of reading
    // whole files into context — the main driver of Kiro's ContextWindowOverflow.
    assert.deepEqual(KIRO_MCP_WHITELIST, [
      'cat-cafe',
      'cat-cafe-collab',
      'cat-cafe-memory',
      'cat-cafe-signals',
      'codegraph',
    ]);
  });
});
