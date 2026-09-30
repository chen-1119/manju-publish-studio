import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BaiduBrowser } from './baidu-browser.js';
import { BaiduUserError } from './baidu-web.js';

const root = path.dirname(fileURLToPath(import.meta.url));
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function context({ navigate = async () => {}, foreground = async () => {}, afterClose = async () => {} } = {}) {
  const listeners = new Map();
  const page = { goto: navigate, bringToFront: foreground };
  return {
    page,
    closeCalls: 0,
    pages: () => [page],
    newPage: async () => page,
    request: { get: async () => ({ json: async () => ({ errno: -6 }) }) },
    on: (event, listener) => listeners.set(event, listener),
    emitClose() { listeners.get('close')?.(); },
    async close() { this.closeCalls += 1; this.emitClose(); await afterClose(); },
  };
}

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'manju-browser-lifecycle-'));
  const browser = new BaiduBrowser(root, directory);
  await browser.receiptsReady;
  browser.browserPath = async () => '/mock-only/browser.exe';
  const launches = [];
  const contexts = [];
  browser.require = () => ({ chromium: { launchPersistentContext: async (_profile, options) => {
    launches.push(options.headless);
    const opened = context();
    contexts.push(opened);
    return opened;
  } } });
  t.after(async () => {
    await browser.context?.close();
    const absolute = path.resolve(directory);
    assert.ok(absolute.startsWith(`${path.resolve(os.tmpdir())}${path.sep}`));
    await fs.rm(absolute, { recursive: true, force: true });
  });
  return { browser, launches, contexts, directory };
}

async function until(check) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.fail('mock operation did not reach its expected step');
}

test('foreground login reserves the close gap so status cannot reopen a background browser', async (t) => {
  const { browser, launches } = await fixture(t);
  const closed = deferred();
  const navigation = deferred();
  const background = context({ afterClose: () => closed.promise });
  const headed = context({ navigate: () => navigation.promise });
  browser.require = () => ({ chromium: { launchPersistentContext: async (_profile, options) => {
    launches.push(options.headless);
    return options.headless ? background : headed;
  } } });
  await browser.launch(true);
  await fs.writeFile(browser.marker, '{}');
  const login = browser.startLogin();
  assert.equal(browser.loginStarting, login);
  await until(() => background.closeCalls === 1);
  assert.equal(browser.context, null);
  assert.equal(browser.waiting, false);
  const status = await browser.status();
  assert.equal(status.loginState, 'waiting');
  assert.deepEqual(launches, [true]);
  closed.resolve();
  await until(() => launches.length === 2);
  navigation.resolve();
  assert.deepEqual(await login, {});
  assert.deepEqual(launches, [true, false]);
  assert.equal(browser.context, headed);
});

test('status rechecks the login reservation after awaiting the authorization marker', async (t) => {
  const { browser, launches } = await fixture(t);
  const markerCheck = deferred();
  const navigation = deferred();
  const headed = context({ navigate: () => navigation.promise });
  const originalAccess = fs.access.bind(fs);
  let checkingMarker = false;
  t.mock.method(fs, 'access', async (filename, ...args) => {
    if (filename === browser.marker) { checkingMarker = true; await markerCheck.promise; return; }
    return originalAccess(filename, ...args);
  });
  browser.require = () => ({ chromium: { launchPersistentContext: async (_profile, options) => {
    launches.push(options.headless);
    return headed;
  } } });
  const probe = browser.status();
  await until(() => checkingMarker);
  const login = browser.startLogin();
  markerCheck.resolve();
  assert.equal((await probe).loginState, 'waiting');
  await until(() => launches.length === 1);
  navigation.resolve();
  await login;
  assert.deepEqual(launches, [false]);
});

test('a failed background launch does not prevent a fresh foreground login attempt', async (t) => {
  const { browser, launches } = await fixture(t);
  const failedBackground = deferred();
  const headed = context();
  browser.require = () => ({ chromium: { launchPersistentContext: async (_profile, options) => {
    launches.push(options.headless);
    if (options.headless) return failedBackground.promise;
    return headed;
  } } });
  const background = browser.launch(true);
  background.catch(() => {});
  await until(() => launches.length === 1);
  const login = browser.startLogin();
  failedBackground.reject(new Error('mock background failure with private call log'));
  await assert.rejects(background, BaiduUserError);
  assert.deepEqual(await login, {});
  assert.deepEqual(launches, [true, false]);
  assert.equal(browser.context, headed);
  assert.equal(browser.loginStarting, null);
  assert.equal(browser.waiting, true);
});

test('concurrent login requests return one promise and open only one browser', async (t) => {
  const { browser, launches } = await fixture(t);
  const navigation = deferred();
  let visits = 0;
  const headed = context({ navigate: async () => { visits += 1; await navigation.promise; } });
  browser.require = () => ({ chromium: { launchPersistentContext: async (_profile, options) => {
    launches.push(options.headless);
    return headed;
  } } });
  const first = browser.startLogin();
  const second = browser.startLogin();
  assert.equal(first, second);
  assert.equal(browser.loginStarting, first);
  await until(() => visits === 1);
  navigation.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(launches, [false]);
  assert.equal(visits, 1);
  assert.equal(browser.loginStarting, null);
});

test('navigation failure returns a safe warning and permits retry in the already open window', async (t) => {
  const { browser, launches } = await fixture(t);
  let visits = 0;
  let foregroundCalls = 0;
  const headed = context({
    navigate: async () => { if (++visits === 1) throw new Error('navigation call log BDUSS=private C:/private/profile'); },
    foreground: async () => { foregroundCalls += 1; },
  });
  browser.require = () => ({ chromium: { launchPersistentContext: async (_profile, options) => {
    launches.push(options.headless);
    return headed;
  } } });
  const result = await browser.startLogin();
  assert.match(result.warning, /窗口已打开.*页面加载失败/);
  assert.doesNotMatch(result.warning, /BDUSS|private|call log/);
  assert.equal(browser.waiting, false);
  assert.equal(browser.loginStarting, null);
  assert.equal((await browser.status()).loginState, 'idle');
  assert.deepEqual(await browser.startLogin(), {});
  assert.deepEqual(launches, [false]);
  assert.equal(visits, 2);
  assert.equal(foregroundCalls, 2);
  assert.equal(browser.waiting, true);
});

test('closing a login window clears the context and waiting state', async (t) => {
  const { browser, contexts } = await fixture(t);
  await browser.startLogin();
  assert.equal(browser.waiting, true);
  contexts[0].emitClose();
  assert.equal(browser.context, null);
  assert.equal(browser.waiting, false);
  assert.equal((await browser.status()).loginState, 'idle');
});

test('profile contention becomes a safe Chinese error and leaves login retryable', async (t) => {
  const { browser } = await fixture(t);
  let blocked = true;
  browser.require = () => ({ chromium: { launchPersistentContext: async () => {
    if (blocked) throw new Error('ProcessSingleton: profile in use C:/private/account --cookie=BDUSS=private\nCall log');
    return context();
  } } });
  await assert.rejects(browser.startLogin(), (error) => {
    assert.ok(error instanceof BaiduUserError);
    assert.match(error.message, /占用.*关闭/);
    assert.doesNotMatch(error.message, /BDUSS|private|ProcessSingleton|Call log/);
    return true;
  });
  assert.equal(browser.waiting, false);
  assert.equal(browser.loginStarting, null);
  assert.equal(browser.starting, null);
  blocked = false;
  assert.deepEqual(await browser.startLogin(), {});
});

test('missing browser and missing login components have separate safe errors', async (t) => {
  const { browser } = await fixture(t);
  browser.browserPath = async () => '';
  await assert.rejects(browser.startLogin(), (error) => error instanceof BaiduUserError && /安装.*Edge.*Chrome/.test(error.message));
  browser.browserPath = async () => '/mock-only/browser.exe';
  browser.require = () => { const error = new Error('Cannot find module C:/private/node_modules/playwright-core; Cookie private'); error.code = 'MODULE_NOT_FOUND'; throw error; };
  await assert.rejects(browser.startLogin(), (error) => {
    assert.ok(error instanceof BaiduUserError);
    assert.match(error.message, /组件缺失/);
    assert.doesNotMatch(error.message, /private|node_modules|Cookie/);
    return true;
  });
  assert.equal(browser.waiting, false);
  assert.equal(browser.loginStarting, null);
});

test('closing the instance permanently blocks login and background status launches', async (t) => {
  const { browser, launches } = await fixture(t);
  await fs.mkdir(browser.profileDir, { recursive: true });
  await fs.writeFile(browser.marker, '{}');
  await browser.close();
  assert.equal(browser.closed, true);
  assert.equal((await browser.status()).loginState, 'idle');
  await assert.rejects(browser.startLogin(), (error) => error instanceof BaiduUserError && /正在关闭/.test(error.message));
  await assert.rejects(browser.launch(true), BaiduUserError);
  assert.deepEqual(launches, []);
  // Shutdown must preserve the saved login profile rather than deleting it.
  assert.equal(await fs.readFile(browser.marker, 'utf8'), '{}');
});

test('an in-flight launch arriving during close is disposed and cannot reopen the profile', async (t) => {
  const { browser, launches } = await fixture(t);
  const startup = deferred();
  const opened = context();
  browser.require = () => ({ chromium: { launchPersistentContext: async (_profile, options) => {
    launches.push(options.headless);
    return startup.promise;
  } } });
  const launch = browser.launch(true);
  launch.catch(() => {});
  await until(() => launches.length === 1);
  const closing = browser.close();
  assert.equal(browser.closed, true);
  assert.equal((await browser.status()).loginState, 'idle');
  startup.resolve(opened);
  await assert.rejects(launch, BaiduUserError);
  await closing;
  assert.equal(opened.closeCalls, 1);
  assert.equal(browser.context, null);
  assert.equal(browser.waiting, false);
  assert.equal(browser.starting, null);
  assert.deepEqual(launches, [true]);
});
