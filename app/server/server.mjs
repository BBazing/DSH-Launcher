/**
 * server.mjs — DSH Launcher 后端
 *
 * 零第三方依赖：只用 node: 内置模块 + 全局 fetch。
 * 职责：环境探测 / profile 管理 / 插件装卸与开关 / 版本管理 / 实例启动 / 日志。
 */
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseTree, setPluginDisabled, resetPluginDisabled } from './cordis.mjs';
import { reconcileBundles } from './bundles.mjs';
import { accountBridge } from './account.mjs';
import { compareVersions as cmpVersion } from './versions.mjs';
import { desktopWindow, spawnDesktop } from './desktop.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_ROOT = path.resolve(process.env.DSH_LAUNCHER_DATA || ROOT);
const WEB_ROOT = path.join(ROOT, 'web');
const BACKUP_ROOT = path.join(DATA_ROOT, 'backups');
const LOG_ROOT = path.join(DATA_ROOT, 'logs');
const CONFIG_PATH = process.env.DSH_LAUNCHER_CONFIG || path.join(DATA_ROOT, 'launcher.config.json');
const OS_HOME = os.homedir();
const APP_VERSION = '0.3.0';
fs.mkdirSync(DATA_ROOT, { recursive: true });

/* ------------------------------------------------------------------ 配置 */

const DEFAULT_CONFIG = {
  homeMode: 'real', // 'real' -> ~/.dsh ; 'sandbox' -> ./.dsh-home
  sandboxHome: '.dsh-home',
  registry: 'https://registry.npmmirror.com',
  port: 19392,
  activeProfile: 'desktop',
  runtimeVersion: '',
  desktopExe: process.env.DSH_DESKTOP_EXE || '',
  instancePort: 3080,
  memoryMode: 'auto',
  memoryMB: 4096,
};

function loadConfig() {
  try {
    return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

async function saveConfig(patch) {
  const next = { ...loadConfig(), ...patch };
  await fsp.writeFile(CONFIG_PATH, JSON.stringify(next, null, 2) + '\n', 'utf8');
  return next;
}

let config = loadConfig();

function dshHome() {
  if (process.env.DSH_LAUNCHER_HOME) return path.resolve(process.env.DSH_LAUNCHER_HOME);
  if (config.homeMode === 'sandbox') return path.resolve(DATA_ROOT, config.sandboxHome);
  return path.join(OS_HOME, '.dsh');
}

/* ------------------------------------------------------- 运行时工具链定位 */

const exists = (p) => { try { fs.accessSync(p); return true; } catch { return false; } };

function findNodeExe() {
  const candidates = [
    process.env.DSH_LAUNCHER_NODE,
    path.resolve(ROOT, '..', 'vendor', 'node', 'node.exe'),
    path.join(OS_HOME, '.dsh', 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'node', 'bin', 'node.exe'),
    path.join(OS_HOME, '.dsh', 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'node', 'bin', 'node'),
  ];
  for (const c of candidates) if (c && exists(c)) return c;
  return process.execPath;
}

function findPnpmCjs() {
  const candidates = [
    process.env.DSH_LAUNCHER_PNPM,
    path.resolve(ROOT, '..', 'vendor', 'pnpm', 'bin', 'pnpm.cjs'),
    config.desktopExe ? path.join(path.dirname(config.desktopExe), 'resources', 'runtime', 'pnpm', 'bin', 'pnpm.cjs') : null,
    path.join(OS_HOME, '.dsh', 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'pnpm', 'bin', 'pnpm.cjs'),
  ];
  for (const c of candidates) if (c && exists(c)) return c;
  return null;
}

/** 扫描所有已知 runtime 根目录下的 dsh 安装。 */
function discoverRuntimes() {
  const found = [];
  const roots = [
    path.join(DATA_ROOT, 'runtimes'),
    path.join(OS_HOME, '.dsh', 'dsh-launcher', 'runtimes'),
  ];
  for (const root of roots) {
    let versions = [];
    try { versions = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const d of versions) {
      if (!d.isDirectory()) continue;
      if (exists(path.join(root, d.name, '.installing'))) continue;
      const binJs = path.join(root, d.name, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
      if (!exists(binJs)) continue;
      let pkgVersion = d.name;
      try {
        const pj = JSON.parse(fs.readFileSync(
          path.join(root, d.name, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'utf8'));
        pkgVersion = pj.version || d.name;
      } catch { /* 用目录名兜底 */ }
      found.push({ version: pkgVersion, dir: path.join(root, d.name), binJs, root, builtin: root.startsWith(DATA_ROOT) });
    }
  }
  // 按版本号粗排序（语义化）
  found.sort((a, b) => cmpVersion(b.version, a.version));
  return found;
}

function activeRuntime() {
  const list = discoverRuntimes();
  return list.find((r) => r.version === config.runtimeVersion) ?? list[0] ?? null;
}

/* -------------------------------------------------------------- 子进程封装 */

/**
 * 以**文件句柄**作为子进程 stdio 启动进程，并把新增内容增量回吐给 onData。
 *
 * 刻意不用 stdio:'pipe'：带管道的 spawn 在受限环境下会直接 EPERM，而且日志落盘
 * 本来就更适合启动器（进程被强杀后仍可回看）。stdout / stderr 分文件保存，
 * 以保留错误流的区分。
 *
 * @returns {{child: import('node:child_process').ChildProcess, done: Promise<number>, files: {out:string,err:string}}}
 */
function spawnLogged(cmd, args, { cwd, env, base, onData, windowsHide = true }) {
  fs.mkdirSync(path.dirname(base), { recursive: true });
  const outFile = `${base}.out.log`;
  const errFile = `${base}.err.log`;
  fs.writeFileSync(outFile, '');
  fs.writeFileSync(errFile, '');
  const outFd = fs.openSync(outFile, 'a');
  const errFd = fs.openSync(errFile, 'a');

  const child = (windowsHide ? spawn : spawnDesktop)(cmd, args, {
    cwd, env, windowsHide,
    stdio: ['ignore', outFd, errFd],
  });

  const offsets = { out: 0, err: 0 };
  const files = { out: outFile, err: errFile };

  const pump = (stream) => {
    const file = files[stream];
    try {
      const size = fs.statSync(file).size;
      if (size <= offsets[stream]) return;
      const len = size - offsets[stream];
      const buf = Buffer.alloc(len);
      const rf = fs.openSync(file, 'r');
      fs.readSync(rf, buf, 0, len, offsets[stream]);
      fs.closeSync(rf);
      offsets[stream] = size;
      if (buf.length) onData?.(stream, buf.toString('utf8'));
    } catch { /* 文件暂不可读，下一轮再试 */ }
  };
  const pumpAll = () => { pump('out'); pump('err'); };

  const timer = setInterval(pumpAll, 350);

  const done = new Promise((resolve) => {
    child.on('error', (e) => {
      onData?.('err', `\n[spawn 失败] ${e.code || e.message}\n`);
      resolve(-1);
    });
    child.on('close', (code) => resolve(code ?? 0));
  }).finally(() => {
    clearInterval(timer);
    pumpAll();
    try { fs.closeSync(outFd); } catch { /* 已关闭 */ }
    try { fs.closeSync(errFd); } catch { /* 已关闭 */ }
  });

  return { child, done, files };
}

/* --------------------------------------------------------------- 后台任务 */

const jobs = new Map();
const profileJobs = new Set();
let jobSeq = 0;

function startJob(kind, title, fn) {
  const id = `job-${++jobSeq}-${Date.now().toString(36)}`;
  const job = { id, kind, title, status: 'running', log: [], startedAt: Date.now(), finishedAt: null, result: null };
  jobs.set(id, job);
  const push = (line) => {
    job.log.push(line);
    if (job.log.length > 2000) job.log.splice(0, job.log.length - 2000);
  };
  push(`$ ${title}`);
  Promise.resolve()
    .then(() => fn(push))
    .then((result) => {
      job.status = 'ok'; job.result = result ?? null; push('✔ 完成');
    })
    .catch((e) => {
      job.status = 'error'; job.result = { error: String(e?.message ?? e) }; push(`✖ ${job.result.error}`);
    })
    .finally(() => { job.finishedAt = Date.now(); });
  return job;
}

/* ------------------------------------------------------------------ 文件工具 */

function startProfileJob(profile, kind, title, fn) {
  if (profileJobs.has(profile)) throw Object.assign(new Error('该实例有安装任务正在运行'), { statusCode: 409 });
  profileJobs.add(profile);
  return startJob(kind, title, async (log) => {
    try { return await fn(log); }
    finally { profileJobs.delete(profile); }
  });
}

async function backupFile(absPath, profile, label) {
  if (!exists(absPath)) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(BACKUP_ROOT, profile);
  await fsp.mkdir(dir, { recursive: true });
  const dest = path.join(dir, `${stamp}__${label}`);
  await fsp.copyFile(absPath, dest);
  return dest;
}

async function readTextSafe(p) {
  try { return await fsp.readFile(p, 'utf8'); } catch { return null; }
}

/* ------------------------------------------------------------------ Profile */

function profileDir(name) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(name) || /[. ]$/.test(name) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) {
    throw Object.assign(new Error('实例名称非法'), { statusCode: 400 });
  }
  return path.join(dshHome(), 'profiles', name);
}

async function listProfiles() {
  const base = path.join(dshHome(), 'profiles');
  let dirs = [];
  try { dirs = await fsp.readdir(base, { withFileTypes: true }); } catch { /* DSH has not created profiles yet. */ }
  const out = [];
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    if (!exists(path.join(base, d.name, 'package.json'))) continue;
    const dir = path.join(base, d.name);
    const pkgRaw = await readTextSafe(path.join(dir, 'package.json'));
    const cordisRaw = await readTextSafe(path.join(dir, 'cordis.yml'));
    const patchRaw = await readTextSafe(path.join(dir, 'cordis.patch.yml'));
    let deps = {}, bundles = [], validManifest = false;
    if (pkgRaw) {
      try {
        const pj = JSON.parse(pkgRaw);
        validManifest = pj !== null && typeof pj === 'object' && !Array.isArray(pj);
        deps = pj.dependencies ?? {};
        bundles = pj.dsh?.profile?.bundles ?? [];
      } catch { /* 忽略损坏的 package.json */ }
    }
    const tree = cordisRaw ? parseTree(cordisRaw) : [];
    const patch = patchRaw ? parseTree(patchRaw) : [];
    out.push({
      name: d.name,
      dir,
      healthy: validManifest,
      configurationPending: !cordisRaw && !patchRaw,
      depCount: Object.keys(deps).length,
      deps,
      bundles,
      pluginCount: tree.length,
      disabledCount: tree.filter((p) => (patch.find((x) => x.id === p.id && x.disabledRaw !== null)?.disabled ?? p.disabled) === true).length,
      patchCount: patch.length,
      hasNodeModules: exists(path.join(dir, 'node_modules')),
    });
  }
  if (config.homeMode === 'real' && config.desktopExe && exists(config.desktopExe) && !out.some(p => p.name === 'desktop')) {
    out.push({ name: 'desktop', dir: profileDir('desktop'), healthy: true, needsFirstLaunch: true,
      configurationPending: true, depCount: 0, deps: {}, bundles: [], pluginCount: 0, disabledCount: 0, patchCount: 0, hasNodeModules: false });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/** 合并 base 插件树与用户补丁层，得到最终生效状态。 */
async function profilePlugins(name) {
  const dir = profileDir(name);
  const cordisRaw = await readTextSafe(path.join(dir, 'cordis.yml'));
  const patchRaw = await readTextSafe(path.join(dir, 'cordis.patch.yml'));
  if (cordisRaw === null && patchRaw === null && !exists(path.join(dir, 'package.json')) && !(name === 'desktop' && config.desktopExe && exists(config.desktopExe))) return null;

  const base = cordisRaw ? parseTree(cordisRaw) : [];
  const patch = patchRaw ? parseTree(patchRaw) : [];
  const patchById = new Map();
  for (const p of patch) if (p.id) patchById.set(p.id, p);

  const merged = [];
  const seen = new Set();
  for (const p of base) {
    const patchEntry = p.id ? patchById.get(p.id) : null;
    const effective = patchEntry?.disabledRaw != null ? patchEntry.disabled : p.disabled;
    merged.push({
      id: p.id,
      name: p.name,
      baseDisabled: p.disabled,
      effectiveDisabled: effective,
      patched: Boolean(patchEntry),
      switchPatched: patchEntry?.disabledRaw != null,
      hasConfig: p.hasConfig,
      kind: p.name?.startsWith('cordis:') ? 'group' : 'plugin',
    });
    if (p.id) seen.add(p.id);
  }
  for (const p of patch) {
    if (p.id && seen.has(p.id)) continue;
    merged.push({
      id: p.id,
      name: p.name,
      baseDisabled: null,
      effectiveDisabled: p.disabled,
      patched: true,
      switchPatched: p.disabledRaw != null,
      hasConfig: p.hasConfig,
      kind: 'patch-only',
    });
  }

  return {
    profile: name,
    dir,
    plugins: merged,
    configurationPending: cordisRaw === null && patchRaw === null,
    total: merged.length,
    enabled: merged.filter((p) => p.effectiveDisabled === false).length,
    disabled: merged.filter((p) => p.effectiveDisabled === true).length,
    conditional: merged.filter((p) => p.effectiveDisabled === 'conditional').length,
  };
}

/* ------------------------------------------------------------------- HTTP */

function json(res, code, body) {
  const buf = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': buf.length });
  res.end(buf);
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.json': 'application/json; charset=utf-8', '.ico': 'image/x-icon',
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0, settled = false;
    const fail = (message, statusCode = 400) => { if (!settled) { settled = true; reject(Object.assign(new Error(message), { statusCode })); } };
    req.on('data', (data) => {
      if (settled) return;
      size += data.length;
      if (size > 2e6) return fail('请求正文过大', 413);
      chunks.push(data);
    });
    req.on('end', () => {
      if (settled) return;
      try {
        const value = size ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
        if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('请求正文必须为 JSON 对象');
        settled = true; resolve(value);
      } catch { fail('请求正文不是有效的 JSON'); }
    });
    req.on('aborted', () => fail('请求已中断'));
    req.on('error', () => fail('无法读取请求正文'));
  });
}

/* ------------------------------------------------------------- 实例管理 */

const instances = new Map(); // profileName -> {child, port, startedAt, log:[], seq}

function instanceLog(profile) {
  const inst = instances.get(profile);
  if (!inst) return { running: false, lines: [], seq: 0 };
  return { running: inst.running, lines: inst.log, seq: inst.seq, port: inst.port, startedAt: inst.startedAt, status: inst.status, exitCode: inst.exitCode, url: inst.url };
}

function pushLog(inst, stream, text) {
  for (const line of String(text).split(/\r?\n/)) {
    if (!line) continue;
    inst.log.push({ seq: ++inst.seq, stream, text: line, at: Date.now() });
  }
  if (inst.log.length > 3000) inst.log.splice(0, inst.log.length - 3000);
}

async function launchInstance(profile, extraArgs = []) {
  const dir = profileDir(profile);
  const desktop = profile.toLowerCase() === 'desktop';
  if (!desktop && !exists(path.join(dir, 'package.json'))) throw new Error('实例不存在');
  const existing = instances.get(profile);
  if (existing?.running) throw new Error(`profile "${profile}" 已在运行`);

  const rt = activeRuntime();
  if (!desktop && !rt) throw new Error('未找到任何 dsh 运行时，请先在「版本」页安装');
  if (desktop && !exists(config.desktopExe)) throw new Error('未找到 DSH 桌面程序，请在设置中填写 exe 路径');
  if (desktop && (config.homeMode !== 'real' || process.env.DSH_LAUNCHER_HOME)) throw new Error('桌面版使用真实 DSH 环境，请先切换真实环境；沙盒中请选择 Web 实例');

  // A prior launcher session or the official shortcut may already own the GUI.
  // Restore that window without spawning a duplicate or taking over its lifetime.
  if (desktop) {
    const window = await desktopWindow(config.desktopExe, { show: true });
    if (window) {
      if (!window.visible || window.minimized) throw new Error('DSH 已运行，但窗口未能显示，请检查任务栏');
      return { profile, pid: window.pid, desktop: true, external: true, status: 'ready', windowVisible: true };
    }
  }

  const nodeExe = findNodeExe();
  let port = desktop ? null : Number(config.instancePort || 3080);
  if (!desktop) {
    while ([...instances.values()].some((i) => i.running && i.port === port) || !(await portAvailable(port))) {
      if (++port > 65535) throw new Error('没有可用端口');
    }
  }
  const env = { ...process.env, DSH_HOME: dshHome() };
  if (!desktop && config.memoryMode === 'custom') {
    env.NODE_OPTIONS = `${env.NODE_OPTIONS ?? ''} --max-old-space-size=${config.memoryMB}`.trim();
  }
  delete env.ELECTRON_RUN_AS_NODE;

  const args = desktop ? [] : ['--require', path.join(ROOT, 'server', 'windows-realpath.cjs'), fs.realpathSync.native(rt.binJs), '--profile', profile, '--host', '127.0.0.1', '--port', String(port), '--no-open', ...extraArgs];
  const command = desktop ? config.desktopExe : nodeExe;
  const base = path.join(LOG_ROOT, `instance-${profile}-${Date.now().toString(36)}`);
  const inst = {
    running: true, status: 'starting', port, startedAt: Date.now(), log: [], seq: 0,
    runtime: desktop ? '桌面版' : rt.version, command: `${command} ${args.join(' ')}`, pending: { out: '', err: '' }, logBase: base,
  };

  const { child, done, files } = spawnLogged(command, args, {
    cwd: desktop ? path.dirname(config.desktopExe) : dshHome(),
    windowsHide: !desktop,
    env,
    base,
    onData: (stream, text) => {
      inst.pending[stream] += text;
      const parts = inst.pending[stream].split(/\r?\n/);
      inst.pending[stream] = parts.pop() ?? '';
      for (const line of parts) {
        const match = line.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+/);
        if (match && new URL(match[0]).port === String(port)) inst.url = match[0];
        if (line) inst.log.push({ seq: ++inst.seq, stream, text: line, at: Date.now() });
      }
      if (inst.log.length > 3000) inst.log.splice(0, inst.log.length - 3000);
    },
  });

  inst.child = child;
  inst.logFiles = files;
  instances.set(profile, inst);
  pushLog(inst, 'system', `启动: ${inst.command}\nDSH_HOME=${dshHome()}`);
  pushLog(inst, 'system', `日志文件: ${files.out}`);

  done.then((code) => {
    for (const stream of ['out', 'err']) if (inst.pending[stream]) pushLog(inst, stream, inst.pending[stream]);
    pushLog(inst, 'system', `进程退出 code=${code}`);
    inst.running = false;
    inst.status = code === 0 ? 'stopped' : 'error';
    inst.exitCode = code;
  });

  if (desktop) {
    const window = await desktopWindow(config.desktopExe, { wait: 20000, show: true });
    if (!window?.visible || window.minimized) {
      pushLog(inst, 'system', '未检测到可见桌面窗口，请查看 DSH 日志与任务栏');
      throw new Error('DSH 桌面窗口未能显示，请查看运行日志');
    }
    if (inst.running) inst.status = 'ready';
    return { profile, pid: window.pid, port, status: 'ready', desktop, windowVisible: true, command: inst.command, logFiles: files };
  }

  const deadline = Date.now() + 20000;
  while (inst.running && Date.now() < deadline) {
    if (!desktop && await portResponding(inst.url ?? `http://127.0.0.1:${port}/`)) { inst.status = 'ready'; break; }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!inst.running && inst.exitCode !== 0) throw new Error(`启动失败（退出码 ${inst.exitCode}），请查看日志`);

  if (!desktop && inst.running && inst.status === 'starting') {
    const probe = setInterval(async () => {
      if (!inst.running || await portResponding(inst.url ?? `http://127.0.0.1:${port}/`)) { if (inst.running) inst.status = 'ready'; clearInterval(probe); }
    }, 2000);
    probe.unref();
  }
  return { profile, pid: child.pid, port, url: inst.url, status: inst.status, desktop, command: inst.command, logFiles: files };
}

function portAvailable(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
  });
}

async function portResponding(url) {
  try { const r = await fetch(url, { signal: AbortSignal.timeout(500), redirect: 'manual' }); return r.status >= 200 && r.status < 400; }
  catch { return false; }
}

function stopInstance(profile) {
  const inst = instances.get(profile);
  if (!inst?.running) return false;
  pushLog(inst, 'system', '正在停止…');
  try { inst.child.kill(); } catch { /* 已退出 */ }
  inst.running = false;
  return true;
}

/* --------------------------------------------------------------- 路由分发 */

async function handleApi(req, res, url) {
  const seg = url.pathname.replace(/^\/api\/?/, '').split('/').filter(Boolean);
  const q = url.searchParams;
  const method = req.method;

  if (seg[0] === 'health' && method === 'GET') return json(res, 200, { app: 'dsh-launcher', version: APP_VERSION, root: ROOT });
  if (seg[0] === 'launcher' && seg[1] === 'exit' && method === 'POST') {
    if ([...instances.values()].some(i => i.running) || profileJobs.size || [...jobs.values()].some(j => j.status === 'running')) return json(res, 409, { error: '请先停止实例并等待下载任务结束，再完全退出启动器。' });
    json(res, 200, { ok: true });
    setTimeout(() => process.exit(0), 250);
    return;
  }
  // Credentials stay inside the official DSH account worker. These routes return
  // only DSH's display-safe state and profile, and use the existing Origin guard.
  if (seg[0] === 'account') {
    res.setHeader('cache-control', 'no-store');
    const action = seg[1];
    if (method === 'GET' && !action) {
      if (!exists(config.desktopExe)) return json(res, 200, { status: 'desktop-missing', profile: null, attempt: null });
      return json(res, 200, await accountBridge(config.desktopExe, dshHome()).call('state', { refresh: q.get('refresh') === '1' }));
    }
    if (method === 'POST' && ['login', 'cancel', 'logout'].includes(action)) {
      const body = await readBody(req);
      if (action === 'cancel' && (typeof body.attemptId !== 'string' || body.attemptId.length > 100)) return json(res, 400, { error: '无效的登录请求编号' });
      if (body.home !== undefined && body.home !== dshHome()) return json(res, 409, { error: 'DSH 环境已切换，请刷新账号状态后重试。' });
      return json(res, 200, await accountBridge(config.desktopExe, dshHome()).call(action, {
        attemptId: body.attemptId, locale: typeof body.locale === 'string' ? body.locale.slice(0, 20) : undefined,
        timezoneOffsetSeconds: body.timezoneOffsetSeconds,
      }));
    }
    return json(res, 404, { error: '未知账号操作' });
  }
  if (seg[0] === 'profiles' && seg[1]) profileDir(decodeURIComponent(seg[1]));
  if (seg[0] === 'profiles' && seg[1] && method !== 'GET' && profileJobs.has(seg[1])) return json(res, 409, { error: '该实例有安装任务正在运行，请稍后再试' });

  // POST /api/profiles/:name/prepare：给克隆的实例安装其声明的依赖。
  if (seg[0] === 'profiles' && seg[2] === 'prepare' && method === 'POST') {
    const job = startProfileJob(seg[1], 'prepare', `安装 ${seg[1]} 的依赖`, (log) => pnpmInProfile(seg[1], ['install'], log));
    return json(res, 200, { ok: true, jobId: job.id });
  }

  // GET /api/state
  if (seg[0] === 'state' && method === 'GET') {
    const rts = discoverRuntimes();
    const profiles = await listProfiles();
    return json(res, 200, {
      config,
      dshHome: dshHome(),
      osHome: OS_HOME,
      root: ROOT,
      runtimes: rts.map((r) => ({ version: r.version, dir: r.dir, builtin: r.builtin })),
      activeRuntime: activeRuntime()?.version ?? null,
      profiles,
      tools: {
        node: findNodeExe(),
        pnpm: findPnpmCjs(),
        nodeVersion: process.version,
        platform: process.platform,
      },
      instances: [...instances.entries()].map(([name, i]) => ({
        profile: name, running: i.running, port: i.port, url: i.url, startedAt: i.startedAt, runtime: i.runtime, status: i.status, exitCode: i.exitCode,
      })),
      backupRoot: BACKUP_ROOT,
      dataRoot: DATA_ROOT,
      appVersion: APP_VERSION,
      desktopInstalled: !!config.desktopExe && exists(config.desktopExe),
      system: { totalMemory: os.totalmem(), freeMemory: os.freemem() },
    });
  }

  // POST /api/config
  if (seg[0] === 'config' && method === 'POST') {
    const body = await readBody(req);
    const patch = {};
    if (body.homeMode !== undefined) {
      if (!['real', 'sandbox'].includes(body.homeMode)) return json(res, 400, { error: '环境非法' });
      if (body.homeMode !== config.homeMode && ([...instances.values()].some((i) => i.running) || profileJobs.size)) return json(res, 409, { error: '请先停止实例并等待安装任务结束，再切换环境' });
      patch.homeMode = body.homeMode;
    }
    if (body.registry !== undefined) {
      const registry = new URL(body.registry);
      if (!['https:', 'http:'].includes(registry.protocol)) return json(res, 400, { error: '镜像源需要 HTTP(S) 地址' });
      patch.registry = registry.href.replace(/\/$/, '');
    }
    if (body.activeProfile !== undefined) { profileDir(body.activeProfile); patch.activeProfile = body.activeProfile; }
    if (body.runtimeVersion !== undefined) {
      if (body.runtimeVersion && !discoverRuntimes().some((r) => r.version === body.runtimeVersion)) return json(res, 400, { error: '运行时未安装' });
      patch.runtimeVersion = body.runtimeVersion;
    }
    if (body.desktopExe !== undefined) patch.desktopExe = String(body.desktopExe);
    if (body.memoryMode !== undefined) {
      if (!['auto', 'custom'].includes(body.memoryMode)) return json(res, 400, { error: '内存模式非法' });
      patch.memoryMode = body.memoryMode;
    }
    if (body.memoryMB !== undefined) {
      if (!Number.isInteger(body.memoryMB) || body.memoryMB < 512 || body.memoryMB > 1048576) return json(res, 400, { error: '内存上限应为 512–1048576 MB 的整数' });
      patch.memoryMB = body.memoryMB;
    }
    if (body.instancePort !== undefined) {
      if (!Number.isInteger(body.instancePort) || body.instancePort < 1024 || body.instancePort > 65535) return json(res, 400, { error: '端口应为 1024–65535 的整数' });
      patch.instancePort = body.instancePort;
    }
    config = await saveConfig(patch);
    return json(res, 200, { ok: true, config, dshHome: dshHome() });
  }

  // GET /api/profiles
  if (seg[0] === 'profiles' && seg.length === 1 && method === 'GET') {
    return json(res, 200, { profiles: await listProfiles(), dshHome: dshHome() });
  }

  // POST /api/profiles  {name, cloneFrom}
  if (seg[0] === 'profiles' && seg.length === 1 && method === 'POST') {
    const body = await readBody(req);
    const name = String(body.name ?? '').trim();
    const dest = profileDir(name);
    if (name.toLowerCase() === 'desktop') return json(res, 400, { error: 'desktop 由 DSH 桌面程序创建和管理' });
    const src = body.cloneFrom ? profileDir(String(body.cloneFrom)) : null;
    if (src && !exists(path.join(src, 'package.json'))) return json(res, 400, { error: '来源实例不存在' });
    if (exists(dest)) return json(res, 409, { error: `profile "${name}" 已存在` });
    await fsp.mkdir(dest, { recursive: true });

    const copied = [];
    if (src && exists(src)) {
      for (const f of ['package.json', 'pnpm-workspace.yaml', 'cordis.patch.yml', 'cordis.yml']) {
        const from = path.join(src, f);
        if (exists(from)) { await fsp.copyFile(from, path.join(dest, f)); copied.push(f); }
      }
    }
    if (!exists(path.join(dest, 'package.json'))) {
      await fsp.writeFile(path.join(dest, 'package.json'), JSON.stringify({
        name: `dsh-profile-${name}`, private: true, dependencies: {},
        dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'], patchReload: 'startup' } },
      }, null, 2) + '\n', 'utf8');
      copied.push('package.json (新建)');
    }
    if (!exists(path.join(dest, 'pnpm-workspace.yaml'))) {
      await fsp.writeFile(path.join(dest, 'pnpm-workspace.yaml'),
        'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n' + DSH_BUILD_POLICY, 'utf8');
      copied.push('pnpm-workspace.yaml (新建)');
    }
    return json(res, 200, { ok: true, profile: name, copied });
  }

  // DELETE /api/profiles/:name
  if (seg[0] === 'profiles' && seg.length === 2 && method === 'DELETE') {
    const name = seg[1];
    const dir = profileDir(name);
    if (instances.get(name)?.running) return json(res, 409, { error: '请先停止实例' });
    if (!exists(dir)) return json(res, 404, { error: 'profile 不存在' });
    const jobs2 = path.join(dshHome(), 'launcher-backups', `deleted-profile-${name}-${Date.now()}`);
    await fsp.mkdir(path.dirname(jobs2), { recursive: true });
    await fsp.rename(dir, jobs2);
    return json(res, 200, { ok: true, movedTo: jobs2 });
  }

  // GET /api/profiles/:name/plugins
  if (seg[0] === 'profiles' && seg[2] === 'plugins' && seg.length === 3 && method === 'GET') {
    const data = await profilePlugins(seg[1]);
    if (!data) return json(res, 404, { error: 'profile 不存在或缺少 cordis.yml' });
    return json(res, 200, data);
  }

  // POST /api/profiles/:name/plugins/toggle  {id, name, disabled}
  if (seg[0] === 'profiles' && seg[2] === 'plugins' && seg[3] === 'toggle' && method === 'POST') {
    const name = seg[1];
    const body = await readBody(req);
    const dir = profileDir(name);
    const file = path.join(dir, 'cordis.patch.yml');
    const current = (await readTextSafe(file)) ?? '';
    // base 层默认状态决定这次改动是"写覆盖"还是"撤覆盖"
    const cordisRaw = (await readTextSafe(path.join(dir, 'cordis.yml'))) ?? '';
    const baseEntry = parseTree(cordisRaw).find((e) => body.id ? e.id === body.id : body.name && e.name === body.name);
    const patchEntry = parseTree(current).find((e) => body.id ? e.id === body.id : e.name === body.name);
    if (!baseEntry && !patchEntry) return json(res, 404, { error: '插件不存在' });
    if (typeof body.disabled !== 'boolean') return json(res, 400, { error: '开关值必须为布尔值' });
    if ((patchEntry?.disabledRaw != null ? patchEntry.disabled : baseEntry?.disabled) === 'conditional') return json(res, 409, { error: '条件启用项由 DSH 表达式控制' });
    const result = setPluginDisabled(
      current,
      { id: (baseEntry ?? patchEntry).id, name: (baseEntry ?? patchEntry).name },
      Boolean(body.disabled),
      { baseDisabled: baseEntry ? baseEntry.disabled : undefined },
    );
    if (result.action === 'noop') return json(res, 200, { ok: true, ...result, backup: null, text: undefined });
    const backup = await backupFile(file, name, 'cordis.patch.yml');
    await fsp.writeFile(file, result.text, 'utf8');
    return json(res, 200, { ok: true, ...result, backup, text: undefined });
  }

  // POST /api/profiles/:name/plugins/reset  {id, name}
  if (seg[0] === 'profiles' && seg[2] === 'plugins' && seg[3] === 'reset' && method === 'POST') {
    const name = seg[1];
    const body = await readBody(req);
    const file = path.join(profileDir(name), 'cordis.patch.yml');
    const current = (await readTextSafe(file)) ?? '';
    const result = resetPluginDisabled(current, { id: body.id, name: body.name });
    if (result.action === 'noop') return json(res, 200, { ok: true, ...result });
    const backup = await backupFile(file, name, 'cordis.patch.yml');
    await fsp.writeFile(file, result.text, 'utf8');
    return json(res, 200, { ok: true, ...result, backup });
  }

  // POST /api/profiles/:name/plugins/install  {spec}
  if (seg[0] === 'profiles' && seg[2] === 'plugins' && seg[3] === 'install' && method === 'POST') {
    const name = seg[1];
    const body = await readBody(req);
    const spec = String(body.spec ?? '').trim();
    if (!/^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(?:@[a-z0-9^~.*+<>=| -]+)?$/i.test(spec)) {
      return json(res, 400, { error: '包名格式非法' });
    }
    const job = startProfileJob(name, 'install', `pnpm add ${spec} (profile=${name})`, async (log) => {
      return await pnpmInProfile(name, ['add', spec], log);
    });
    return json(res, 200, { ok: true, jobId: job.id });
  }

  // POST /api/profiles/:name/plugins/uninstall  {pkg}
  if (seg[0] === 'profiles' && seg[2] === 'plugins' && seg[3] === 'uninstall' && method === 'POST') {
    const name = seg[1];
    const body = await readBody(req);
    const pkg = String(body.pkg ?? '').trim();
    if (!/^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i.test(pkg)) return json(res, 400, { error: '包名格式非法' });
    const job = startProfileJob(name, 'uninstall', `pnpm remove ${pkg} (profile=${name})`, async (log) => {
      return await pnpmInProfile(name, ['remove', pkg], log);
    });
    return json(res, 200, { ok: true, jobId: job.id });
  }

  // GET /api/market?q=...
  if (seg[0] === 'market' && method === 'GET') {
    const text = String(q.get('q') ?? '').trim() || 'dsh';
    try {
      const r = await fetch(`${config.registry.replace(/\/$/, '')}/-/v1/search?text=${encodeURIComponent(text)}&size=25`, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(20000),
      });
      if (!r.ok) throw new Error(`npm HTTP ${r.status}`);
      const data = await r.json();
      const items = (data.objects ?? []).map((o) => ({
        name: o.package?.name,
        version: o.package?.version,
        description: o.package?.description ?? '',
        author: o.package?.author?.name ?? o.package?.publisher?.username ?? '',
        date: o.package?.date ?? '',
        links: o.package?.links ?? {},
        score: o.score?.final ?? 0,
      })).filter((x) => x.name);
      return json(res, 200, { ok: true, query: text, count: items.length, items, registry: config.registry });
    } catch (e) {
      return json(res, 502, { error: `市场检索失败: ${e.message}` });
    }
  }

  // GET /api/runtimes
  if (seg[0] === 'runtimes' && seg.length === 1 && method === 'GET') {
    return json(res, 200, {
      runtimes: discoverRuntimes().map((r) => ({ ...r, binJs: undefined })),
      active: activeRuntime()?.version ?? null,
    });
  }

  // POST /api/runtimes/install  {version}
  if (seg[0] === 'runtimes' && seg[1] === 'install' && method === 'POST') {
    const body = await readBody(req);
    const version = String(body.version ?? '').trim();
    if (version && !/^(?:latest|\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?)$/.test(version)) return json(res, 400, { error: '版本号格式非法' });
    const spec = /^\d/.test(version) ? `@deepseek-ai/dsh@${version}` : '@deepseek-ai/dsh@latest';
    const job = startJob('runtime-install', `安装 dsh ${spec}`, async (log) => {
      const dir = path.join(DATA_ROOT, 'runtimes', version || 'latest');
      if ([...instances.values()].some(instance => instance.running && instance.command.includes(dir))) throw new Error('此运行时仍有实例正在使用，请先停止实例。');
      await fsp.mkdir(dir, { recursive: true });
      await fsp.writeFile(path.join(dir, '.installing'), '', 'utf8');
      if (!exists(path.join(dir, 'pnpm-workspace.yaml'))) await fsp.writeFile(path.join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - .\nnodeLinker: hoisted\n' + DSH_BUILD_POLICY, 'utf8');
      await fsp.writeFile(path.join(dir, 'package.json'),
        JSON.stringify({ name: `dsh-runtime-${version || 'latest'}`, private: true }, null, 2) + '\n', 'utf8');
      const r = await runPnpm(['add', spec], dir, log);
      if (r.code !== 0) throw new Error(`pnpm 安装失败 (exit ${r.code})`);
      await fsp.unlink(path.join(dir, '.installing'));
      return { dir, spec };
    });
    return json(res, 200, { ok: true, jobId: job.id });
  }

  // POST /api/runtimes/query  {version}  -> npm 上的元数据
  if (seg[0] === 'runtimes' && seg[1] === 'query' && method === 'GET') {
    try {
      const r = await fetch(`${config.registry.replace(/\/$/, '')}/@deepseek-ai%2Fdsh`, {
        headers: { accept: 'application/vnd.npm.install-v1+json' },
        signal: AbortSignal.timeout(20000),
      });
      if (!r.ok) throw new Error(`npm HTTP ${r.status}`);
      const data = await r.json();
      const versions = Object.keys(data.versions ?? {});
      return json(res, 200, {
        ok: true,
        latest: data['dist-tags']?.latest ?? null,
        tags: data['dist-tags'] ?? {},
        versions: versions.sort((a, b) => cmpVersion(b, a)).slice(0, 40),
      });
    } catch (e) {
      return json(res, 502, { error: e.message });
    }
  }

  // GET /api/jobs/:id
  if (seg[0] === 'jobs' && seg[1] && method === 'GET') {
    const job = jobs.get(seg[1]);
    if (!job) return json(res, 404, { error: 'job 不存在' });
    const since = Number(q.get('since') ?? 0);
    return json(res, 200, {
      id: job.id, kind: job.kind, title: job.title, status: job.status,
      result: job.result, startedAt: job.startedAt, finishedAt: job.finishedAt,
      lines: job.log.slice(since), next: job.log.length,
    });
  }

  // POST /api/instances/launch {profile}
  if (seg[0] === 'instances' && seg[1] === 'launch' && method === 'POST') {
    const body = await readBody(req);
    try {
      const info = await launchInstance(String(body.profile ?? config.activeProfile));
      return json(res, 200, { ok: true, ...info });
    } catch (e) {
      return json(res, 400, { error: e.message });
    }
  }

  // POST /api/instances/stop {profile}
  if (seg[0] === 'instances' && seg[1] === 'stop' && method === 'POST') {
    const body = await readBody(req);
    const ok = stopInstance(String(body.profile ?? config.activeProfile));
    return json(res, 200, { ok });
  }

  // GET /api/instances/:profile/log?since=N
  if (seg[0] === 'instances' && seg[2] === 'log' && method === 'GET') {
    const data = instanceLog(seg[1]);
    const since = Number(q.get('since') ?? 0);
    return json(res, 200, { ...data, lines: data.lines.filter((l) => l.seq > since) });
  }

  return json(res, 404, { error: `未知接口 ${url.pathname}` });
}

/* -------------------------------------------------------- pnpm 执行封装 */

// Only the native dependencies needed by the official DSH runtime may build.
// Other packages retain pnpm's blocked-script behavior, with a warning rather
// than treating an otherwise complete download as a failed installation.
const DSH_BUILD_POLICY = '\nstrictDepBuilds: false\nallowBuilds:\n  "@deepseek-ai/dsh-subprocess-local": true\n  koffi: true\n  node-pty: true\n';

async function runPnpm(args, cwd, log) {
  const pnpm = findPnpmCjs();
  const nodeExe = findNodeExe();
  if (!pnpm) throw new Error('内置 pnpm 缺失，请重新下载完整发行版。');
  const full = [pnpm, ...args];
  log(`$ node ${full.join(' ')}`);
  log(`  cwd=${cwd}  registry=${config.registry}`);

  const base = path.join(LOG_ROOT, `pnpm-${Date.now().toString(36)}`);
  // 按行切分后回吐，避免半行噪声
  const pending = { out: '', err: '' };
  const { done, files } = spawnLogged(nodeExe, full, {
    cwd,
    // 用环境变量而非 --registry 标志：pnpm remove 等子命令不接受该标志
    env: { ...process.env, DSH_HOME: dshHome(), npm_config_registry: config.registry },
    base,
    onData: (stream, text) => {
      if (stream === 'err') pending.err += text;
      else pending.out += text;
      const buf = pending[stream];
      const parts = buf.split(/\r?\n/);
      pending[stream] = parts.pop() ?? '';
      for (const p of parts) if (p.trim()) log(stream === 'err' ? `! ${p}` : p);
    },
  });

  const code = await done;
  for (const s of ['out', 'err']) {
    if (pending[s].trim()) log(s === 'err' ? `! ${pending[s]}` : pending[s]);
  }
  return { code, dir: cwd, logs: files };
}

async function pnpmInProfile(name, args, log) {
  const dir = profileDir(name);
  if (!exists(dir)) throw new Error(`profile "${name}" 不存在: ${dir}`);
  await backupFile(path.join(dir, 'package.json'), name, 'package.json');
  await backupFile(path.join(dir, 'pnpm-lock.yaml'), name, 'pnpm-lock.yaml');
  const before = JSON.parse(await fsp.readFile(path.join(dir, 'package.json'), 'utf8'));
  const r = await runPnpm(args, dir, log);
  if (r.code !== 0) throw new Error(`pnpm 退出码 ${r.code}`);
  const after = JSON.parse(await fsp.readFile(path.join(dir, 'package.json'), 'utf8'));
  const merged = reconcileBundles(before, after, dir, activeRuntime()?.binJs);
  await fsp.writeFile(path.join(dir, 'package.json'), JSON.stringify(merged, null, 2) + '\n');
  log('已同步 DSH bundle 清单；运行中的实例请重启以加载新插件。');
  return { code: r.code, dir };
}

/* ------------------------------------------------------------- 静态资源 */

async function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const target = path.join(WEB_ROOT, rel);
  if (!target.startsWith(WEB_ROOT + path.sep)) { res.writeHead(403); return res.end('forbidden'); }
  try {
    const data = await fsp.readFile(target);
    res.writeHead(200, { 'content-type': MIME[path.extname(target).toLowerCase()] ?? 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('404');
  }
}

/* ------------------------------------------------------------------ 启动 */

let mutationQueue = Promise.resolve();
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? '127.0.0.1'}`);
  let unlock;
  try {
    const allowedHosts = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
    if (!allowedHosts.has(req.headers.host)) return json(res, 403, { error: '不允许的 Host' });
    if (req.headers.origin && ![`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`].includes(req.headers.origin)) return json(res, 403, { error: '不允许跨站请求' });
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const previous = mutationQueue;
      mutationQueue = new Promise((resolve) => { unlock = resolve; });
      await previous;
    }
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    return await serveStatic(req, res, url);
  } catch (e) {
    if (!res.headersSent) return json(res, e.statusCode ?? 500, { error: e.message });
    res.end();
  } finally { unlock?.(); }
});

const PORT = Number(process.env.PORT ?? config.port);
server.listen(PORT, '127.0.0.1', () => {
  const line = `DSH Launcher 已启动  http://127.0.0.1:${PORT}  (DSH_HOME=${dshHome()})`;
  console.log(line);
});
server.on('error', (error) => { console.error(error.code === 'EADDRINUSE' ? `端口 ${PORT} 已占用，请关闭旧启动器或更换端口。` : error.message); process.exitCode = 1; });
