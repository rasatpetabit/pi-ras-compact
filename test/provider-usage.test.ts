import { test } from 'node:test';
import assert from 'node:assert/strict';
import { settledProviderTokens } from '../src/core/provider-usage.js';
test('settled pressure uses provider totals/components, never a character estimate', () => {
  const model = { provider: 'p', id: 'm' };
  const message: any = { role: 'assistant', stopReason: 'stop', ...{ provider: 'p', model: 'm' }, content: 'x'.repeat(40000), usage: { totalTokens: 20000 } };
  const read = () => settledProviderTokens([{ type: 'message', id: 'leaf', message }], 'leaf', model);
  assert.equal(read(), 20000);
  message.usage = { input: 1000, output: 30, cacheRead: 700, cacheWrite: 20 }; assert.equal(read(), 1750);
  for (const usage of [undefined, {}, { totalTokens: NaN }, { input: 1 }, { input: 1, output: -1, cacheRead: 0, cacheWrite: 0 }]) { message.usage = usage; assert.equal(read(), null); }
  message.usage = { totalTokens: 20000 }; message.model = 'foreign'; assert.equal(read(), null);
  message.model = 'm'; message.stopReason = 'error'; assert.equal(read(), null);
});
