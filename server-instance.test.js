import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { acquireServerInstance, probeServerInstance, dataDirFingerprint, APP_MARKER } from './server-instance.js';

async function temporary(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'manju-instance-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

async function endpoint(t, identity) {
  const server = http.createServer((request, response) => {
    assert.equal(request.url, '/api/instance');
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(identity()));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

const shortWait = { timeoutMs: 100, retryMs: 10 };

function sourceServer(directory, port = 0) {
  return spawn(process.execPath, ['server.js', '--no-browser'], {
    cwd: path.dirname(fileURLToPath(import.meta.url)),
    env: { ...process.env, LOCALAPPDATA: directory, PORT: String(port) },
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function startupUrl(child) {
  return new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => reject(new Error('isolated server startup timed out')), 10000);
    child.stdout.on('data', (chunk) => {
      output += chunk;
      const matched = /已启动：(http:\/\/127\.0\.0\.1:\d+)/.exec(output);
      if (matched) { clearTimeout(timeout); resolve(matched[1]); }
    });
    child.on('error', (error) => { clearTimeout(timeout); reject(error); });
    child.on('exit', (code) => { clearTimeout(timeout); reject(new Error(`isolated server exited before listening: ${code}`)); });
  });
}

async function stopSource(child) {
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = once(child, 'exit');
    child.kill();
    await exited;
  }
}

test('same-directory simultaneous starts share one owner and the owner URL', async (t) => {
  const directory = await temporary(t);
  let owner;
  const url = await endpoint(t, () => owner.identity);
  const start = () => acquireServerInstance(directory, shortWait).then((result) => {
    if (result.kind === 'owner') { owner = result; result.publish(url); }
    return result;
  });
  const results = await Promise.all([start(), start(), start()]);
  assert.equal(results.filter((result) => result.kind === 'owner').length, 1);
  assert.equal(results.filter((result) => result.kind === 'existing').length, 2);
  assert.ok(results.every((result) => result.identity.instanceId === owner.identity.instanceId));
  assert.ok(results.filter((result) => result.kind === 'existing').every((result) => result.url === url));
  owner.release();
});

test('a second start waits for the same instance to begin listening', async (t) => {
  const directory = await temporary(t);
  const owner = await acquireServerInstance(directory);
  const url = await endpoint(t, () => owner.identity);
  const waiting = acquireServerInstance(directory, { timeoutMs: 500, retryMs: 10 });
  await new Promise((resolve) => setTimeout(resolve, 30));
  owner.publish(url);
  const existing = await waiting;
  assert.equal(existing.kind, 'existing');
  assert.equal(existing.url, url);
  owner.release();
});

test('a dead PID lock can be reclaimed without allowing an earlier owner to remove the new lock', async (t) => {
  const directory = await temporary(t);
  const old = await acquireServerInstance(directory, { pid: 987654321 });
  const current = await acquireServerInstance(directory, { ...shortWait, isProcessAlive: () => false });
  assert.equal(current.kind, 'owner');
  assert.notEqual(current.identity.instanceId, old.identity.instanceId);
  old.release();
  const stored = JSON.parse(await fs.readFile(path.join(directory, 'server-instance.json'), 'utf8'));
  assert.equal(stored.instanceId, current.identity.instanceId);
  current.release();
});

test('an interrupted stale-lock recovery guard can be reclaimed after its PID has exited', async (t) => {
  const directory = await temporary(t);
  const old = await acquireServerInstance(directory, { pid: 987654321 });
  const recoveryPath = path.join(directory, `server-instance-recovery-${old.identity.instanceId}.json`);
  await fs.writeFile(recoveryPath, JSON.stringify({ pid: 987654322, guardId: 'interrupted-recovery' }));
  const current = await acquireServerInstance(directory, { ...shortWait, isProcessAlive: () => false });
  assert.equal(current.kind, 'owner');
  await assert.rejects(fs.access(recoveryPath), { code: 'ENOENT' });
  current.release();
});

test('identity probing rejects unrelated app, other data directory, and an incorrect instance ID', async (t) => {
  const directory = await temporary(t);
  const fingerprint = dataDirFingerprint(directory);
  let identity = { app: 'unrelated-server', dataDirFingerprint: fingerprint, instanceId: 'first' };
  const url = await endpoint(t, () => identity);
  assert.equal(await probeServerInstance(url, { fingerprint }), null);
  identity = { app: APP_MARKER, dataDirFingerprint: 'another-directory', instanceId: 'first' };
  assert.equal(await probeServerInstance(url, { fingerprint }), null);
  identity = { app: APP_MARKER, dataDirFingerprint: fingerprint, instanceId: 'first' };
  assert.equal(await probeServerInstance(url, { fingerprint, instanceId: 'other' }), null);
  assert.equal((await probeServerInstance(url, { fingerprint, instanceId: 'first' })).url, url);
  assert.equal(await probeServerInstance('http://example.com:1234', { fingerprint }), null);
});

test('a preferred port occupied by an unrelated service does not count as the existing tool', async (t) => {
  const directory = await temporary(t);
  const url = await endpoint(t, () => ({ app: 'unrelated-server' }));
  const current = await acquireServerInstance(directory, { preferredUrl: url });
  assert.equal(current.kind, 'owner');
  current.release();
});

test('different data directories may each own an instance even with the same preferred URL', async (t) => {
  const firstDir = await temporary(t);
  const secondDir = await temporary(t);
  const first = await acquireServerInstance(firstDir);
  const url = await endpoint(t, () => first.identity);
  first.publish(url);
  const second = await acquireServerInstance(secondDir, { preferredUrl: url });
  assert.equal(second.kind, 'owner');
  assert.notEqual(first.identity.dataDirFingerprint, second.identity.dataDirFingerprint);
  first.release();
  second.release();
});

test('an alive same-directory PID with an unverifiable service blocks a duplicate start', async (t) => {
  const directory = await temporary(t);
  const owner = await acquireServerInstance(directory);
  const url = await endpoint(t, () => ({ app: 'unrelated-server' }));
  owner.publish(url);
  await assert.rejects(acquireServerInstance(directory, shortWait), /没有启动第二个实例/);
  assert.equal(JSON.parse(await fs.readFile(path.join(directory, 'server-instance.json'), 'utf8')).instanceId, owner.identity.instanceId);
  owner.release();
});

test('a verified instance on the preferred URL is reused without claiming another lock', async (t) => {
  const directory = await temporary(t);
  const owner = await acquireServerInstance(directory);
  const url = await endpoint(t, () => owner.identity);
  owner.publish(url);
  const existing = await acquireServerInstance(directory, { preferredUrl: url });
  assert.equal(existing.kind, 'existing');
  assert.equal(existing.identity.instanceId, owner.identity.instanceId);
  owner.release();
});

test('the integrated server exits a duplicate process and preserves the first instance', async (t) => {
  const directory = await temporary(t);
  const first = sourceServer(directory);
  let second;
  try {
    const url = await startupUrl(first);
    const identity = await (await fetch(`${url}/api/instance`)).json();
    assert.equal(identity.app, APP_MARKER);
    assert.equal(identity.dataDirFingerprint, dataDirFingerprint(path.join(directory, 'ManjuPublishStudio')));
    second = sourceServer(directory);
    let output = '';
    second.stdout.on('data', (chunk) => { output += chunk; });
    const [code] = await once(second, 'exit');
    assert.equal(code, 0);
    assert.ok(output.includes(`已在运行：${url}`));
    assert.deepEqual(await (await fetch(`${url}/api/instance`)).json(), identity);
  } finally { await stopSource(second); await stopSource(first); }
});

test('the integrated server uses an available port when another service occupies its preferred port', async (t) => {
  const directory = await temporary(t);
  const occupied = await endpoint(t, () => ({ app: 'unrelated-server' }));
  const child = sourceServer(directory, Number(new URL(occupied).port));
  try {
    const url = await startupUrl(child);
    assert.notEqual(url, occupied);
    const identity = await (await fetch(`${url}/api/instance`)).json();
    assert.equal(identity.app, APP_MARKER);
  } finally { await stopSource(child); }
});
