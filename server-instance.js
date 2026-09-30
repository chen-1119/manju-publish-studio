import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export const APP_MARKER = 'manju-publish-studio';
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function writeAtomic(file, record, exclusive = false) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(record), { flag: 'wx', mode: 0o600 });
    if (exclusive) fs.linkSync(temporary, file);
    else fs.renameSync(temporary, file);
  } finally {
    try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

export function dataDirFingerprint(dataDir) {
  let resolved = path.resolve(dataDir);
  try { resolved = fs.realpathSync(resolved); } catch { /* The directory is created before claiming an instance. */ }
  if (process.platform === 'win32') resolved = resolved.toLowerCase();
  return createHash('sha256').update(resolved).digest('hex');
}

function localUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password || url.search || url.hash || url.pathname !== '/') return null;
    return url.origin;
  } catch { return null; }
}

export function probeServerInstance(value, { fingerprint, instanceId, timeoutMs = 1000 } = {}) {
  const origin = localUrl(value);
  if (!origin) return Promise.resolve(null);
  return new Promise((resolve) => {
    let settled = false;
    let timer;
    const finish = (result) => { if (!settled) { settled = true; clearTimeout(timer); resolve(result); } };
    const request = http.get(`${origin}/api/instance`, { timeout: timeoutMs }, (response) => {
      if (response.statusCode !== 200) { response.resume(); finish(null); return; }
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        body += chunk;
        if (body.length > 4096) { request.destroy(); finish(null); }
      });
      response.on('end', () => {
        try {
          const info = JSON.parse(body);
          if (info.app === APP_MARKER && info.dataDirFingerprint === fingerprint && typeof info.instanceId === 'string' && info.instanceId && (!instanceId || info.instanceId === instanceId)) finish({ ...info, url: origin });
          else finish(null);
        } catch { finish(null); }
      });
      response.on('error', () => finish(null));
    });
    request.on('timeout', () => { request.destroy(); finish(null); });
    request.on('error', () => finish(null));
    timer = setTimeout(() => { request.destroy(); finish(null); }, timeoutMs);
  });
}

function processAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}

export async function acquireServerInstance(dataDir, {
  preferredUrl = '', pid = process.pid, isProcessAlive = processAlive,
  probe = probeServerInstance, timeoutMs = 8000, retryMs = 150,
} = {}) {
  fs.mkdirSync(dataDir, { recursive: true });
  const fingerprint = dataDirFingerprint(dataDir);
  const lockPath = path.join(dataDir, 'server-instance.json');
  const identity = { app: APP_MARKER, version: 1, dataDirFingerprint: fingerprint, instanceId: randomUUID(), pid, url: '' };
  const readRecord = () => {
    const record = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    if (record.app !== APP_MARKER || record.version !== 1 || record.dataDirFingerprint !== fingerprint || !/^[a-f0-9-]{36}$/i.test(record.instanceId || '') || !Number.isSafeInteger(record.pid) || record.pid <= 0) throw new Error('启动记录与当前工具不匹配');
    return record;
  };
  const ownsRecord = () => {
    try { return readRecord().instanceId === identity.instanceId; } catch { return false; }
  };
  // Only a verified app and data directory may be reused; unrelated services are ignored.
  if (preferredUrl) {
    const running = await probe(preferredUrl, { fingerprint });
    if (running) return { kind: 'existing', url: running.url, identity: running };
  }
  const deadline = Date.now() + timeoutMs;
  do {
    try {
      writeAtomic(lockPath, identity, true);
      return {
        kind: 'owner', identity,
        publish(url) {
          const origin = localUrl(url);
          if (!origin || !ownsRecord()) throw new Error('本机工具启动记录失效，请关闭重复窗口后重试');
          identity.url = origin;
          writeAtomic(lockPath, identity);
        },
        release() { if (ownsRecord()) fs.unlinkSync(lockPath); },
      };
    } catch (error) { if (error.code !== 'EEXIST') throw error; }
    let existing;
    try { existing = readRecord(); }
    catch { await pause(retryMs); continue; }
    if (!isProcessAlive(existing.pid)) {
      // A guard tied to the stale identity stops simultaneous restarts from deleting a new owner's lock.
      const recoveryPath = path.join(dataDir, `server-instance-recovery-${existing.instanceId}.json`);
      const recovery = { pid, guardId: randomUUID() };
      try { writeAtomic(recoveryPath, recovery, true); }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        try {
          const oldGuard = JSON.parse(fs.readFileSync(recoveryPath, 'utf8'));
          const currentGuard = JSON.parse(fs.readFileSync(recoveryPath, 'utf8'));
          if (Number.isSafeInteger(oldGuard.pid) && oldGuard.pid > 0 && !isProcessAlive(oldGuard.pid) && currentGuard.guardId === oldGuard.guardId && currentGuard.pid === oldGuard.pid) fs.unlinkSync(recoveryPath);
        } catch (guardError) { if (guardError.code !== 'ENOENT') throw new Error('本机工具启动恢复记录无法读取，请保留该文件并检查数据目录'); }
        await pause(retryMs); continue;
      }
      try {
        const current = readRecord();
        if (current.instanceId === existing.instanceId && !isProcessAlive(current.pid)) fs.unlinkSync(lockPath);
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      finally { fs.unlinkSync(recoveryPath); }
      continue;
    }
    if (existing.url) {
      const running = await probe(existing.url, { fingerprint, instanceId: existing.instanceId });
      if (running) return { kind: 'existing', url: running.url, identity: running };
    }
    await pause(retryMs);
  } while (Date.now() < deadline);
  throw new Error('另一个漫剧发布工作台正在启动或仍在运行。请使用原工具窗口，或关闭它后重新打开；为保护登录状态，本次没有启动第二个实例。');
}
