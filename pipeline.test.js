import test from 'node:test';
import assert from 'node:assert/strict';
import { PipelineManager } from './pipeline.js';

const input = (overrides = {}) => ({ keyword: 'AI漫剧合集', resource: {
  title: '测试作品', shareUrl: 'https://pan.baidu.com/s/1source', accessCode: 'abcd', platform: 'baidu', direct: true,
  ...overrides,
} });
const saved = () => ({ kind: 'saved', confirmed: true, receiptId: 'receipt-1', folder: '/', files: [
  { name: '第01集.mp4', path: '/第01集.mp4', fsId: '101', isdir: 0 },
  { name: '第02集.mp4', path: '/第02集.mp4', fsId: '102', isdir: 0 },
] });
const own = () => ({ url: 'https://pan.baidu.com/s/1own', accessCode: 'wxyz', verified: true });
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
const tick = () => new Promise((resolve) => setImmediate(resolve));
async function finished(manager, id) {
  for (let i = 0; i < 100; i += 1) {
    const job = manager.get(id);
    if (!job.active) return job;
    await tick();
  }
  assert.fail('pipeline did not settle');
}
function adapter(overrides = {}) {
  return { save: async () => saved(), waitForTransfer: async () => saved(), createShare: async () => own(), ...overrides };
}

test('runs transfer, own share, generation in order using actual saved files and title', async () => {
  const calls = [];
  const manager = new PipelineManager({ adapter: adapter({
    save: async (share) => { calls.push('save'); assert.deepEqual(share, { url: 'https://pan.baidu.com/s/1source', code: 'abcd' }); return saved(); },
    waitForTransfer: async () => assert.fail('already confirmed transfer must not wait'),
    createShare: async (receipt) => { calls.push('share'); assert.deepEqual(receipt, saved()); return own(); },
  }) });
  const job = await manager.start(input());
  const result = await finished(manager, job.id);
  assert.equal(result.status, 'completed');
  assert.deepEqual(calls, ['save', 'share']);
  assert.equal(result.result.input.title, '测试作品');
  assert.equal(result.result.input.synopsis, '');
  assert.equal(result.result.input.resources, '第01集.mp4\n第02集.mp4');
  assert.equal(result.result.input.ownShareUrl, own().url);
  assert.equal(result.result.input.ownAccessCode, 'wxyz');
  assert.equal(result.result.input.targetBar, 'AI漫剧吧');
  assert.equal(result.result.input.completion, 'unknown');
  assert.equal(result.stages.length, 4);
  assert.ok(result.stages.every((stage) => stage.status === 'completed'));
  assert.ok(!result.result.pack.body.includes('1source'));
});

test('start returns while save is pending and does not share before confirmed wait', async () => {
  const saveGate = deferred();
  const waitGate = deferred();
  let shares = 0;
  const manager = new PipelineManager({ adapter: adapter({
    save: () => saveGate.promise,
    waitForTransfer: (receipt) => { assert.equal(receipt.taskId, 'task-1'); return waitGate.promise; },
    createShare: async () => { shares += 1; return own(); },
  }) });
  const job = await manager.start(input());
  assert.equal(job.status, 'transferring');
  assert.equal(shares, 0);
  saveGate.resolve({ kind: 'submitted', taskId: 'task-1', folder: '/' });
  await tick();
  assert.equal(manager.get(job.id).status, 'waiting');
  assert.equal(shares, 0);
  waitGate.resolve(saved());
  assert.equal((await finished(manager, job.id)).status, 'completed');
  assert.equal(shares, 1);
});

test('rejects quark, metadata-only and non-official links before adapter calls', async () => {
  let saves = 0;
  const manager = new PipelineManager({ adapter: adapter({ save: async () => { saves += 1; return saved(); } }) });
  for (const bad of [
    { platform: 'quark', shareUrl: 'https://pan.quark.cn/s/one' },
    { direct: false },
    { shareUrl: 'https://example.com/article' },
    { shareUrl: 'https://pan.baidu.com.evil.example/s/1source' },
    { shareUrl: 'https://pan.baidu.com/' },
    { shareUrl: '' },
    { accessCode: 'invalid' },
  ]) await assert.rejects(manager.start(input(bad)));
  assert.equal(saves, 0);
});

test('rejects original canonical source URL even if query, pwd and path style differ', async () => {
  for (const url of ['https://pan.baidu.com/s/1source?pwd=wxyz', 'http://pan.baidu.com/share/init?surl=source&pwd=wxyz']) {
    const manager = new PipelineManager({ adapter: adapter({ createShare: async () => ({ url, accessCode: 'wxyz', verified: true }) }) });
    const job = await manager.start(input());
    const result = await finished(manager, job.id);
    assert.equal(result.status, 'failed');
    assert.match(result.error, /原资源/);
    assert.equal(result.ownShare, null);
    assert.equal(result.result, null);
  }
});

test('share failure retries share only, never saves the original again', async () => {
  let saves = 0; let shares = 0;
  const manager = new PipelineManager({ adapter: adapter({
    save: async () => { saves += 1; return saved(); },
    createShare: async () => { shares += 1; if (shares === 1) throw new Error('分享暂时失败'); return own(); },
  }) });
  const job = await manager.start(input());
  const failed = await finished(manager, job.id);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.canRetry, true);
  assert.equal(failed.files.length, 2);
  await manager.retry(job.id);
  assert.equal((await finished(manager, job.id)).status, 'completed');
  assert.equal(saves, 1);
  assert.equal(shares, 2);
});

test('deduplicates active and completed canonical shares regardless of extraction code', async () => {
  const gate = deferred(); let saves = 0;
  const manager = new PipelineManager({ adapter: adapter({ save: () => { saves += 1; return gate.promise; } }) });
  const job = await manager.start(input());
  const duplicate = await manager.start(input({ shareUrl: 'https://pan.baidu.com/share/init?surl=source&pwd=efgh', accessCode: 'efgh' }));
  assert.equal(duplicate.id, job.id);
  assert.equal(duplicate.existing, true);
  gate.resolve(saved());
  await finished(manager, job.id);
  const completed = await manager.start(input());
  assert.equal(completed.id, job.id);
  assert.equal(completed.status, 'completed');
  await manager.retry(job.id);
  assert.equal(saves, 1);
});

test('pending timeout remains waiting and retry waits without saving or sharing early', async () => {
  let saves = 0; let waits = 0; let shares = 0;
  const manager = new PipelineManager({ adapter: adapter({
    save: async () => { saves += 1; return { kind: 'submitted', taskId: 't1' }; },
    waitForTransfer: async () => { waits += 1; return waits === 1 ? { kind: 'pending', taskId: 't1' } : saved(); },
    createShare: async () => { shares += 1; return own(); },
  }) });
  const job = await manager.start(input());
  const pending = await finished(manager, job.id);
  assert.equal(pending.status, 'waiting');
  assert.equal(pending.canRetry, true);
  assert.equal(shares, 0);
  await manager.resume(job.id);
  assert.equal((await finished(manager, job.id)).status, 'completed');
  assert.equal(saves, 1);
  assert.equal(waits, 2);
  assert.equal(shares, 1);
});

test('save outcome unknown fails closed and retry cannot duplicate transfer', async () => {
  let saves = 0; let shares = 0;
  const manager = new PipelineManager({ adapter: adapter({
    save: async () => { saves += 1; throw new Error('网络中断，转存结果未知'); },
    createShare: async () => { shares += 1; return own(); },
  }) });
  const job = await manager.start(input());
  const result = await finished(manager, job.id);
  assert.equal(result.status, 'failed');
  assert.equal(result.transfer.kind, 'unknown');
  assert.equal(result.canRetry, false);
  await assert.rejects(manager.retry(job.id));
  assert.equal((await manager.start(input())).id, job.id);
  assert.equal(saves, 1);
  assert.equal(shares, 0);
});

test('confirmed flag and complete file paths are required before creating a share', async () => {
  for (const result of [{ ...saved(), confirmed: false }, { ...saved(), files: [{ name: 'fake.mp4' }] }, { kind: 'saved', confirmed: true, files: [] }]) {
    let shares = 0;
    const manager = new PipelineManager({ adapter: adapter({ save: async () => result, createShare: async () => { shares += 1; return own(); } }) });
    const job = await manager.start(input());
    const failed = await finished(manager, job.id);
    assert.equal(failed.status, 'failed');
    assert.equal(failed.canRetry, false);
    assert.equal(shares, 0);
  }
});

test('state checkpoints restore completed task without redoing transfer or own share', async () => {
  let state;
  const manager = new PipelineManager({ adapter: adapter(), saveState: async (value) => { state = structuredClone(value); } });
  const job = await manager.start(input());
  await finished(manager, job.id);
  assert.equal(state.version, 1);
  assert.equal(state.jobs[0].transfer.receiptId, 'receipt-1');
  const restored = new PipelineManager({ loadState: async () => state, adapter: adapter({
    save: async () => assert.fail('restored task must not save again'),
    createShare: async () => assert.fail('restored task must not share again'),
  }) });
  const duplicate = await restored.start(input());
  assert.equal(duplicate.id, job.id);
  assert.equal(duplicate.status, 'completed');
  assert.equal(duplicate.result.input.ownShareUrl, own().url);
  await restored.retry(job.id);
});

test('saved receipt survives restart after sharing failure and retries only own share', async () => {
  let state;
  const manager = new PipelineManager({ adapter: adapter({ createShare: async () => { throw new Error('分享失败'); } }), saveState: async (value) => { state = structuredClone(value); } });
  const job = await manager.start(input());
  await finished(manager, job.id);
  const restored = new PipelineManager({ loadState: async () => state, adapter: adapter({
    save: async () => assert.fail('must retain completed transfer'),
    createShare: async (receipt) => { assert.equal(receipt.receiptId, 'receipt-1'); return own(); },
  }) });
  await restored.retry(job.id);
  assert.equal((await finished(restored, job.id)).status, 'completed');
});

test('interrupted transfer is checkpointed before adapter save and blocked after restart', async () => {
  let state; const gate = deferred();
  const manager = new PipelineManager({ saveState: async (value) => { state = structuredClone(value); }, adapter: adapter({
    save: () => { assert.equal(state.jobs[0].saveAttempted, true); return gate.promise; },
  }) });
  const job = await manager.start(input());
  await tick();
  const interrupted = structuredClone(state);
  const restored = new PipelineManager({ loadState: async () => interrupted, adapter: adapter({ save: async () => assert.fail('unknown transfer must not be repeated') }) });
  const result = await restored.start(input());
  assert.equal(result.id, job.id);
  assert.equal(result.status, 'failed');
  assert.equal(result.canRetry, false);
  await assert.rejects(restored.retry(job.id));
  gate.resolve(saved());
  await finished(manager, job.id);
});

test('storage failure prevents any transfer network operation', async () => {
  let saves = 0;
  const manager = new PipelineManager({ saveState: async () => { throw new Error('disk unavailable'); }, adapter: adapter({ save: async () => { saves += 1; return saved(); } }) });
  await assert.rejects(manager.start(input()), /保存失败/);
  assert.equal(saves, 0);
});

test('failed side-effect fence rolls back attempted marker and safely retries after storage recovers', async () => {
  let writes = 0; let state; let saves = 0; let shares = 0;
  const manager = new PipelineManager({
    saveState: async (value) => {
      writes += 1;
      if (writes === 3) throw new Error('temporary disk failure');
      state = structuredClone(value);
    },
    adapter: adapter({ save: async () => { saves += 1; return saved(); }, createShare: async () => { shares += 1; return own(); } }),
  });
  const job = await manager.start(input());
  const failed = await finished(manager, job.id);
  assert.equal(failed.status, 'failed');
  assert.match(failed.error, /尚未发起转存/);
  assert.equal(failed.canRetry, true);
  assert.equal(state.jobs[0].saveAttempted, false);
  assert.equal(state.jobs[0].transfer, null);
  assert.equal(saves, 0);
  assert.equal(shares, 0);
  await manager.retry(job.id);
  assert.equal((await finished(manager, job.id)).status, 'completed');
  assert.equal(saves, 1);
  assert.equal(shares, 1);
});

test('initial persistence reserves the job so concurrent resume cannot launch a second transfer', async () => {
  const gate = deferred(); let writes = 0; let createdId; let saves = 0;
  const manager = new PipelineManager({
    saveState: async (value) => {
      writes += 1;
      if (writes === 1) { createdId = value.jobs[0].id; await gate.promise; }
    },
    adapter: adapter({ save: async () => { saves += 1; return saved(); } }),
  });
  const starting = manager.start(input());
  await tick();
  assert.equal(manager.get(createdId).active, true);
  assert.equal(manager.get(createdId).canRetry, false);
  const concurrent = await manager.resume(createdId);
  assert.equal(concurrent.active, true);
  gate.resolve();
  const job = await starting;
  assert.equal((await finished(manager, job.id)).status, 'completed');
  assert.equal(saves, 1);
});

test('unverified share response cannot become a publishing link', async () => {
  const manager = new PipelineManager({ adapter: adapter({ createShare: async () => ({ ...own(), verified: false }) }) });
  const job = await manager.start(input());
  const failed = await finished(manager, job.id);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.ownShare, null);
  assert.equal(failed.result, null);
  assert.equal(failed.canRetry, true);
});

test('unknown sharing POST outcome is retained and cannot create another public share on retry or restart', async () => {
  let state; let shares = 0;
  const manager = new PipelineManager({
    saveState: async (value) => { state = structuredClone(value); },
    adapter: adapter({ createShare: async () => {
      shares += 1;
      throw Object.assign(new Error('share response was lost'), { shareOutcomeUnknown: true });
    } }),
  });
  const job = await manager.start(input());
  const failed = await finished(manager, job.id);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.sharingUnknown, true);
  assert.equal(failed.canRetry, false);
  assert.match(failed.error, /不会再次创建分享/);
  await assert.rejects(manager.retry(job.id));
  const restored = new PipelineManager({ loadState: async () => state, adapter: adapter({
    createShare: async () => assert.fail('unknown share POST must not be repeated'),
  }) });
  const duplicate = await restored.start(input());
  assert.equal(duplicate.id, job.id);
  assert.equal(duplicate.sharingUnknown, true);
  assert.equal(duplicate.canRetry, false);
  await assert.rejects(restored.retry(job.id));
  assert.equal(shares, 1);
});

test('queued receipt survives restart and resumes waiting without starting another transfer', async () => {
  let state;
  const pending = { kind: 'pending', taskId: 't1', receiptId: 'pending-receipt', folder: '/' };
  const manager = new PipelineManager({ adapter: adapter({ save: async () => pending, waitForTransfer: async () => pending }), saveState: async (value) => { state = structuredClone(value); } });
  const job = await manager.start(input());
  assert.equal((await finished(manager, job.id)).status, 'waiting');
  const restored = new PipelineManager({ loadState: async () => state, adapter: adapter({
    save: async () => assert.fail('queued transfer must not be submitted twice'),
    waitForTransfer: async (receipt) => { assert.equal(receipt.receiptId, 'pending-receipt'); assert.equal(receipt.taskId, 't1'); return saved(); },
  }) });
  await restored.resume(job.id);
  assert.equal((await finished(restored, job.id)).status, 'completed');
});

test('adapter-confirmed preflight failures allow safe save retry', async () => {
  let saves = 0;
  const manager = new PipelineManager({ adapter: adapter({ save: async () => {
    saves += 1;
    if (saves === 1) throw Object.assign(new Error('请先登录自己的网盘'), { transferStarted: false });
    return saved();
  } }) });
  const job = await manager.start(input());
  assert.equal((await finished(manager, job.id)).canRetry, true);
  await manager.retry(job.id);
  assert.equal((await finished(manager, job.id)).status, 'completed');
  assert.equal(saves, 2);
});

test('returned snapshots cannot mutate a job or its own sharing receipt', async () => {
  const manager = new PipelineManager({ adapter: adapter() });
  const job = await manager.start(input());
  const result = await finished(manager, job.id);
  result.files[0].name = 'unrelated-file.mp4';
  result.ownShare.url = 'https://pan.baidu.com/s/1source';
  assert.equal(manager.get(job.id).files[0].name, '第01集.mp4');
  assert.equal(manager.get(job.id).ownShare.url, own().url);
});
