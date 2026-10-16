// Runs under the installed DSH Electron binary in Node mode. Account protocol,
// PKCE, credential locking and cancellation remain owned by DSH's own modules.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [asar, home, optionsJson = '{}'] = process.argv.slice(2);
const load = (name) => import(pathToFileURL(path.join(asar, 'dsh', 'node_modules', '@deepseek-ai', name, 'lib', 'index.js')).href);
let ctx;
let account;
let profile = null;
let profileTime = 0;
let profileRead;
// Production passes no override. The loopback override permits isolated tests
// of the installed provider against a mock platform without touching real grants.
const options = JSON.parse(optionsJson);
let platformOrigin = 'https://platform.deepseek.com';
if (options.platformOrigin) {
  const testOrigin = new URL(options.platformOrigin);
  if (testOrigin.protocol !== 'http:' || testOrigin.hostname !== '127.0.0.1' || testOrigin.pathname !== '/' || testOrigin.search || testOrigin.hash || testOrigin.username || testOrigin.password) throw new Error('Invalid test platform origin');
  platformOrigin = testOrigin.origin;
}
const metadata = { version: '0.0.0', locale: 'zh-CN', timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60 };
try { metadata.version = JSON.parse(fs.readFileSync(path.join(asar, 'package.json'), 'utf8')).version || '0.0.0'; } catch { }
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const send = (value) => { if (process.connected) process.send(value); };

function safeState(state) {
  const attempt = state.attempt;
  const displayProfile = profile?.status === 'ready' ? { status: 'ready', value: {
    name: typeof profile.value?.name === 'string' ? profile.value.name : null,
    contact: typeof profile.value?.contact === 'string' ? profile.value.contact : null,
    avatarUrl: typeof profile.value?.avatarUrl === 'string' ? profile.value.avatarUrl : null,
  } } : profile ? { status: 'failed' } : null;
  return {
    status: state.status,
    profile: state.status === 'credential-stored' ? displayProfile : null,
    attempt: attempt ? { id: attempt.id, phase: attempt.phase, errorCode: attempt.errorCode,
      authorizeUrl: attempt.authorizeUrl, expiresAt: attempt.expiresAt } : null,
  };
}

async function snapshot(refreshProfile = false) {
  await ctx.credentials.refresh();
  let state = await account.getState();
  if (state.status === 'credential-stored') {
    if (refreshProfile || Date.now() - profileTime > 30000) {
      profileRead ??= account.getProfile(metadata).then(value => {
        profile = value;
        profileTime = Date.now();
      }).finally(() => { profileRead = undefined; });
      await profileRead;
      state = await account.getState();
    }
  } else { profile = null; profileTime = 0; }
  return safeState(state);
}

async function initialize() {
  const [{ Context }, credentials, authorization, webserver, provider] = await Promise.all([
    load('cordis'), load('dsh-credentials-local'), load('dsh-authorization'), load('dsh-host-webserver'), load('dsh-deepseek-account-platform'),
  ]);
  ctx = new Context();
  await ctx.plugin(credentials.default, { dshHome: home, watch: true });
  const existing = await ctx.credentials.readRecord('deepseek-account-platform/default');
  // Do not mount a provider whose init hook would discard a different issuer.
  if (existing && existing.payload?.issuer !== platformOrigin) throw new Error('issuer-mismatch');
  await ctx.plugin(authorization.default);
  await ctx.plugin(webserver.default, { host: '127.0.0.1', port: 0 });
  await ctx.plugin(provider.default, { platformOrigin, desktopPlatform: process.platform === 'win32' ? 'win32' : null,
    allowLoopbackHttp: Boolean(options.platformOrigin), requestTimeoutMs: 10000, balanceTimeoutMs: 10000 });
  account = ctx.deepseekAccount;
  ctx.on('credentials/record-updated', (key) => {
    if (key === 'deepseek-account-platform/default') { profile = null; profileTime = 0; }
  });
}

let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  const timeout = setTimeout(() => process.exit(0), 2000);
  try { await ctx?.fiber.dispose(); } finally { clearTimeout(timeout); process.exit(0); }
}
process.on('disconnect', close);
process.on('SIGTERM', close);

try {
  await initialize();
  process.on('message', async ({ id, method, body = {} }) => {
    try {
      if (body.locale) metadata.locale = String(body.locale).slice(0, 20);
      if (Number.isFinite(body.timezoneOffsetSeconds)) metadata.timezoneOffsetSeconds = Math.max(-86400, Math.min(86400, body.timezoneOffsetSeconds));
      let value;
      if (method === 'state') value = await snapshot(Boolean(body.refresh));
      else if (method === 'login') {
        await account.startSignIn({ ...metadata }, `http://127.0.0.1:${ctx.webServer.port}`, 'web');
        const deadline = Date.now() + 12000;
        while ((await account.getState()).attempt?.phase === 'initializing' && Date.now() < deadline) await sleep(100);
        value = safeState(await account.getState());
      } else if (method === 'cancel') {
        if (typeof body.attemptId !== 'string') throw new Error('invalid-attempt');
        value = safeState(await account.cancelSignIn(body.attemptId));
      } else if (method === 'logout') {
        await account.signOut({ ...metadata });
        profile = null;
        value = safeState(await account.getState());
      } else throw new Error('unsupported-command');
      send({ id, value });
    } catch {
      send({ id, error: 'DSH 账号操作失败，请重试或在 DSH 本体中查看登录状态。' });
    }
  });
  send({ ready: true });
} catch (error) {
  send({ ready: false, error: error.message === 'issuer-mismatch'
    ? '本机 DSH 使用了不同的账号平台，请在 DSH 本体中管理该账号。'
    : '无法加载 DSH 登录组件，请检查桌面版安装和本机凭据文件。' });
  await close();
}
