import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const buildRoot = path.join(root, 'build');
fs.mkdirSync(buildRoot, { recursive: true });
const temp = fs.mkdtempSync(path.join(buildRoot, 'test-'));
const data = path.join(temp, 'data');
const home = path.join(temp, 'dsh-home');
fs.mkdirSync(data, { recursive: true });
fs.mkdirSync(home, { recursive: true });
const probe = net.createServer();
await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
const port = probe.address().port;
await new Promise(resolve => probe.close(resolve));
const logFile = path.join(temp, 'server.log');
const log = fs.openSync(logFile, 'a');
const node = path.join(root, 'vendor', 'node', 'node.exe');
const pnpm = path.join(root, 'vendor', 'pnpm', 'bin', 'pnpm.cjs');
const env = { ...process.env, PORT: String(port), DSH_LAUNCHER_DATA: data, DSH_LAUNCHER_CONFIG: path.join(data, 'launcher.config.json'), DSH_LAUNCHER_HOME: home, DSH_DESKTOP_EXE: '', DSH_LAUNCHER_NODE: node, DSH_LAUNCHER_PNPM: pnpm };
env.TEMP = temp;
env.TMP = temp;
delete env.ELECTRON_RUN_AS_NODE;
delete env.NODE_OPTIONS;
const backend = spawn(node, ['server/server.mjs'], { cwd: path.join(root, 'app'), env, windowsHide: true, stdio: ['ignore', log, log] });
async function api(route, body, status = 200) {
  const response = await fetch(`http://127.0.0.1:${port}/api${route}`, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const value = await response.json();
  assert.equal(response.status, status, JSON.stringify(value));
  return value;
}
try {
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { ready = (await api('/health')).app === 'dsh-launcher'; if (ready) break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert(ready, fs.readFileSync(logFile, 'utf8'));
  const state = await api('/state');
  assert.equal(state.appVersion, '0.3.0');
  assert.equal(state.dataRoot, data);
  assert.equal(state.config.desktopExe, '');
  assert.equal(state.desktopInstalled, false);
  assert.equal(state.tools.node, node);
  assert.equal(state.tools.pnpm, pnpm);
  assert.deepEqual(state.profiles, []);
  assert.equal((await api('/account')).status, 'desktop-missing');
  const dummyDesktop = path.join(temp, 'fixture.exe');
  fs.writeFileSync(dummyDesktop, 'fixture, never executed');
  await api('/config', { desktopExe: dummyDesktop });
  const virtualDesktop = (await api('/state')).profiles.find(profile => profile.name === 'desktop');
  assert.equal(virtualDesktop.needsFirstLaunch, true, 'Desktop must be launchable before DSH creates its profile');
  assert.equal((await api('/profiles/desktop/plugins')).configurationPending, true);
  assert(!fs.existsSync(path.join(home, 'profiles', 'desktop')), 'Listing must not initialize a real desktop profile');
  await api('/config', { desktopExe: '' });
  await api('/config', { memoryMB: 2048 });
  assert.equal(JSON.parse(fs.readFileSync(path.join(data, 'launcher.config.json'))).memoryMB, 2048);
  await api('/profiles', { name: 'fresh' });
  const plugins = await api('/profiles/fresh/plugins');
  assert.equal(plugins.configurationPending, true);
  assert.deepEqual(plugins.plugins, []);
  assert.equal((await api('/profiles')).profiles.length, 1);
  const response = await fetch(`http://127.0.0.1:${port}/api/launcher/exit`, { method: 'POST', headers: { origin: 'https://untrusted.example', 'content-type': 'application/json' }, body: '{}' });
  assert.equal(response.status, 403);
  const pnpmResult = await run(node, [pnpm, '--version'], { cwd: temp, windowsHide: true, env });
  assert.equal(pnpmResult.stdout.trim(), '11.7.0');
  const exe = path.join(root, 'dist', 'DSHLauncher-v0.3.0-win-x64.exe');
  assert(fs.existsSync(exe), 'Build the release before testing');
  const extracted = path.join(temp, '路径带空格 Release');
  const report = path.join(temp, 'report.json');
  await run(exe, ['--data-dir', extracted, '--extract-only', '--report', report], { windowsHide: true, timeout: 120000 });
  const result = JSON.parse(fs.readFileSync(report, 'utf8'));
  assert.equal(result.ok, true, JSON.stringify(result));
  const manifest = JSON.parse(fs.readFileSync(path.join(result.root, 'payload-manifest.json'), 'utf8'));
  assert(manifest.length > 30);
  for (const item of manifest) {
    assert(!/(^|\/)(\.credentials|launcher\.config|\.webview-profile|\.window-profile|logs|backups)(\/|\.|$)/.test(item.path), item.path);
    const file = fs.readFileSync(path.join(result.root, item.path));
    assert.equal(file.length, item.size, item.path);
    assert.equal(createHash('sha256').update(file).digest('hex'), item.sha256, item.path);
    if (/\.(mjs|js|ps1|json|md|cs)$/.test(item.path) && !item.path.startsWith('vendor/')) {
      assert(!file.toString('utf8').includes('C:\\Users\\24230'), item.path + ' contains author-specific path');
      assert(!file.toString('utf8').includes('G:\\DSH'), item.path + ' contains a fixed desktop location');
    }
  }
  const marker = path.join(result.root, '.complete');
  const modified = fs.statSync(marker).mtimeMs;
  await run(exe, ['--data-dir', extracted, '--extract-only', '--report', report], { windowsHide: true, timeout: 120000 });
  assert.equal(fs.statSync(marker).mtimeMs, modified, 'Second start must reuse the existing extraction');
  const sourceArchive = path.join(root, 'dist', 'DSHLauncher-v0.3.0-source.zip');
  assert(fs.existsSync(sourceArchive), 'Source archive must accompany the release');
  const zipScript = path.join(temp, 'source-list.ps1');
  fs.writeFileSync(zipScript, "param([string]$Archive)\nAdd-Type -AssemblyName System.IO.Compression.FileSystem\n$zip=[IO.Compression.ZipFile]::OpenRead($Archive)\ntry { ConvertTo-Json -InputObject @($zip.Entries.FullName) -Compress } finally { $zip.Dispose() }\n");
  const listing = await run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', zipScript, '-Archive', sourceArchive], { windowsHide: true, env });
  const sourceNames = JSON.parse(listing.stdout.trim());
  assert(sourceNames.includes('.github/workflows/release.yml'));
  assert(sourceNames.includes('scripts/fetch-dependencies.ps1'));
  assert(sourceNames.every(name => !/^(vendor|build|dist)\//.test(name) && !name.startsWith('app/native/bin/')));
  const expectedExeHash = fs.readFileSync(path.join(root, 'dist', 'SHA256SUMS.txt'), 'utf8').split(/\s+/)[0];
  assert.equal(createHash('sha256').update(fs.readFileSync(exe)).digest('hex'), expectedExeHash);
  console.log(`PASS: isolated backend, empty first run, bundled pnpm, EXE extraction, ${manifest.length} payload hashes, cache reuse and private-data exclusions`);
} finally {
  if (backend.exitCode === null) {
    const exited = new Promise(resolve => backend.once('exit', resolve));
    backend.kill(); await exited;
  }
  fs.closeSync(log);
  const resolved = path.resolve(temp);
  assert(resolved.startsWith(path.resolve(buildRoot) + path.sep));
  fs.rmSync(resolved, { recursive: true, force: true });
}
