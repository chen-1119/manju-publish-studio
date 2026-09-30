import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SearchConfig } from './search-config.js';

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'manju-search-config-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dir).startsWith('manju-search-config-'));
    await fs.rm(dir, { recursive: true, force: true });
  });
  return path.join(dir, 'config.local.json');
}

test('migrates old Brave configuration and preserves both providers through simultaneous updates and restart', async (t) => {
  const file = await fixture(t);
  await fs.writeFile(file, JSON.stringify({ braveApiKey: 'old-fixture-brave-key' }));
  const config = new SearchConfig(file, {});
  assert.equal(config.key('brave'), 'old-fixture-brave-key');
  await Promise.all([
    config.update({ provider: 'qiniu', apiKey: 'fixture-qiniu-key' }),
    config.update({ braveApiKey: 'updated-fixture-brave-key' }),
  ]);
  const restarted = new SearchConfig(file, {});
  assert.equal(restarted.key('qiniu'), 'fixture-qiniu-key');
  assert.equal(restarted.key('brave'), 'updated-fixture-brave-key');
  const status = JSON.stringify(restarted.status());
  assert.doesNotMatch(status, /fixture|ApiKey/);
  await restarted.update({ provider: 'qiniu', clear: true });
  assert.equal(restarted.key('qiniu'), '');
  assert.equal(restarted.key('brave'), 'updated-fixture-brave-key');
});

test('environment keys override local settings and remain private after clearing local keys', async (t) => {
  const config = new SearchConfig(await fixture(t), { QINIU_AI_API_KEY: 'environment-fixture-key' });
  await config.update({ provider: 'qiniu', apiKey: 'local-fixture-key' });
  assert.equal(config.key('qiniu'), 'environment-fixture-key');
  await config.update({ provider: 'qiniu', clear: true });
  assert.equal(config.status().providers.qiniu.configured, true);
  assert.equal(config.status().providers.qiniu.locallyConfigured, false);
  assert.doesNotMatch(JSON.stringify(config.status()), /fixture-key/);
});

test('rejects unknown providers and malformed keys without overwriting a valid setting', async (t) => {
  const config = new SearchConfig(await fixture(t), {});
  await config.update({ provider: 'qiniu', apiKey: 'valid-fixture-key' });
  for (const body of [null, [], { provider: '__proto__', apiKey: 'valid-fixture-key' }, { provider: 'qiniu', apiKey: 'short' }, { provider: 'qiniu', apiKey: 'not a valid key' }]) {
    await assert.rejects(config.update(body));
  }
  assert.equal(config.key('qiniu'), 'valid-fixture-key');
});
