import assert from 'node:assert/strict';
import test from 'node:test';
import { builtinAccountFamilyForClient, builtinAccountIdForClient, protocolForClient } from '../dist/index.js';

test('catagent shares anthropic builtin account family', () => {
  assert.equal(builtinAccountFamilyForClient('catagent'), 'anthropic');
  assert.equal(builtinAccountIdForClient('catagent'), 'claude');
});

test('protocolForClient normalizes provider family routing', () => {
  assert.equal(protocolForClient('catagent'), 'anthropic');
  assert.equal(protocolForClient('opencode'), 'anthropic');
  assert.equal(protocolForClient('dare'), 'openai');
  assert.equal(protocolForClient('antigravity'), null);
});

test('grok has its own builtin account family and xAI protocol', () => {
  assert.equal(builtinAccountFamilyForClient('grok'), 'grok');
  assert.equal(builtinAccountIdForClient('grok'), 'grok');
  assert.equal(protocolForClient('grok'), 'xai');
});

test('kiro uses CLI-managed auth and has no builtin account protocol', () => {
  assert.equal(builtinAccountFamilyForClient('kiro'), null);
  assert.equal(builtinAccountIdForClient('kiro'), null);
  assert.equal(protocolForClient('kiro'), null);
});
