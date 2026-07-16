import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { KIRO_MCP_WHITELIST, createKiroAcpProfile } = await import(
  '../../dist/domains/cats/services/agents/providers/acp/kiro-acp-profile.js'
);

describe('kiro-acp-profile', () => {
  it('uses the official kiro-cli acp entrypoint and disables multiplexing', () => {
    const profile = createKiroAcpProfile({});

    assert.equal(profile.command, 'kiro-cli');
    assert.deepEqual(profile.startupArgs, ['acp']);
    assert.equal(profile.supportsMultiplexing, false);
    assert.deepEqual(profile.mcpServers, []);
    assert.equal(profile.model, undefined);
  });

  it('appends defaultArgs after acp and honors a custom command', () => {
    const profile = createKiroAcpProfile({
      cli: { command: 'C:/tools/kiro-cli.exe', defaultArgs: ['--verbose'] },
    });

    assert.equal(profile.command, 'C:/tools/kiro-cli.exe');
    assert.deepEqual(profile.startupArgs, ['acp', '--verbose']);
  });

  it('deduplicates a leading acp argument', () => {
    const profile = createKiroAcpProfile({ cli: { command: 'kiro-cli', defaultArgs: ['acp', '--verbose'] } });
    assert.deepEqual(profile.startupArgs, ['acp', '--verbose']);
  });

  it('only exposes a non-empty trimmed model override', () => {
    assert.equal(createKiroAcpProfile({ defaultModel: '  gpt-5.6-sol  ' }).model, 'gpt-5.6-sol');
    assert.equal(createKiroAcpProfile({ defaultModel: '   ' }).model, undefined);
  });

  it('whitelists only the four builtin Clowder MCP servers', () => {
    assert.deepEqual(KIRO_MCP_WHITELIST, ['cat-cafe', 'cat-cafe-collab', 'cat-cafe-memory', 'cat-cafe-signals']);
  });
});
