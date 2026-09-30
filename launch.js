import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 4187);
const logDir = path.join(process.env.LOCALAPPDATA || root, 'ManjuPublishStudio');

function ready() {
  return new Promise((resolve) => {
    const req = http.get({ hostname: '127.0.0.1', port, path: '/api/status', timeout: 1000 }, (res) => {
      let body = '';
      res.on('data', (part) => { body += part; });
      res.on('end', () => {
        try { resolve(res.statusCode === 200 && JSON.parse(body).app === 'manju-publish-studio'); }
        catch { resolve(false); }
      });
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

if (!(await ready())) {
  mkdirSync(logDir, { recursive: true });
  const log = openSync(path.join(logDir, 'server.log'), 'a');
  const child = spawn(process.execPath, [path.join(root, 'server.js')], {
    cwd: root,
    detached: true,
    windowsHide: true,
    stdio: ['ignore', log, log],
  });
  child.unref();
  closeSync(log);

  let started = false;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (await ready()) { started = true; break; }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!started) {
    console.error(`启动失败，请查看 ${path.join(logDir, 'server.log')}`);
    process.exitCode = 1;
  }
}

if (!process.exitCode) console.log(`漫剧发布工作台已就绪：http://127.0.0.1:${port}/`);
