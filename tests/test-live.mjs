import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const build = path.join(root, 'build');
fs.mkdirSync(build, { recursive: true });
const temp = fs.mkdtempSync(path.join(build, 'live-'));
const home = path.join(temp, 'home');
const data = path.join(temp, 'data');
fs.mkdirSync(home); fs.mkdirSync(data);
const probe = net.createServer();
await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
const port = probe.address().port;
await new Promise(resolve => probe.close(resolve));
const fd = fs.openSync(path.join(temp, 'server.log'), 'a');
const env = { ...process.env, PORT: String(port), DSH_LAUNCHER_DATA: data, DSH_LAUNCHER_HOME: home, DSH_LAUNCHER_CONFIG: path.join(data, 'config.json'),
  DSH_LAUNCHER_NODE: path.join(root, 'vendor', 'node', 'node.exe'), DSH_LAUNCHER_PNPM: path.join(root, 'vendor', 'pnpm', 'bin', 'pnpm.cjs'),
  TEMP: temp, TMP: temp, npm_config_store_dir: path.join(temp, 'pnpm-store') };
env.PATH = path.dirname(env.DSH_LAUNCHER_NODE) + path.delimiter + env.PATH;
delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
const child = spawn(env.DSH_LAUNCHER_NODE, ['server/server.mjs'], { cwd: path.join(root, 'app'), env, windowsHide: true, stdio: ['ignore', fd, fd] });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function api(route, body, status = 200) {
  const response = await fetch(`http://127.0.0.1:${port}/api${route}`, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const result = await response.json();
  if (response.status !== status && route === '/instances/launch') {
    const failure = await (await fetch(`http://127.0.0.1:${port}/api/instances/release-web/log`)).json();
    console.log(failure.lines.map(line => line.text.replace(/token=[^\s]+/g, 'token=[redacted]')).join('\n'));
  }
  assert.equal(response.status, status, JSON.stringify(result)); return result;
}
async function job(id) {
  let last = '';
  for (const deadline = Date.now() + 360000; Date.now() < deadline;) {
    const result = await api('/jobs/' + id);
    const line = result.lines.at(-1);
    if (line && line !== last) { console.log(line); last = line; }
    if (result.status !== 'running') { assert.equal(result.status, 'ok', result.lines.join('\n')); return result; }
    await sleep(900);
  }
  throw new Error('Package job timed out');
}
try {
  let ready = false;
  for (let n = 0; n < 100; n++) { try { ready = (await api('/health')).app === 'dsh-launcher'; if (ready) break; } catch {} await sleep(100); }
  assert(ready);
  await api('/config', { registry: 'https://registry.npmjs.org' });
  const installation = await api('/runtimes/install', { version: '0.1.5-rc.2' });
  await api('/launcher/exit', {}, 409);
  const runtime = await job(installation.jobId);
  assert(runtime.result.dir.startsWith(path.join(data, 'runtimes') + path.sep));
  await api('/config', { runtimeVersion: '0.1.5-rc.2' });
  console.log('PASS: fresh Web runtime downloaded with bundled pnpm into the persistent data directory');
  await api('/profiles', { name: 'release-web' });
  const installed = await api('/profiles/release-web/plugins/install', { spec: 'dsh-pet@0.3.7' });
  await job(installed.jobId);
  const packageFile = path.join(home, 'profiles', 'release-web', 'package.json');
  let pkg = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
  assert(pkg.dependencies['dsh-pet']); assert(pkg.dsh.profile.bundles.includes('dsh-pet'));
  assert.equal((await api('/profiles/release-web/plugins')).configurationPending, true);
  const launch = await api('/instances/launch', { profile: 'release-web' });
  const response = await fetch(launch.url, { redirect: 'manual' });
  assert(response.status >= 200 && response.status < 400);
  assert(launch.command.includes(path.join(data, 'runtimes')), 'Must use the freshly downloaded runtime');
  console.log('PASS: fresh Web runtime boots with real downloaded plugin; HTTP ' + response.status);
  await api('/launcher/exit', {}, 409);
  await api('/instances/stop', { profile: 'release-web' }); await sleep(1200);
  await job((await api('/profiles/release-web/plugins/uninstall', { pkg: 'dsh-pet' })).jobId);
  pkg = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
  assert(!pkg.dependencies?.['dsh-pet']); assert(!pkg.dsh.profile.bundles.includes('dsh-pet'));
  assert(pkg.dsh.profile.bundles.includes('@deepseek-ai/dsh-base'));
  console.log('PASS: real plugin uninstall and shutdown guards; user profiles untouched');
} finally {
  try { await api('/instances/stop', { profile: 'release-web' }); } catch {}
  if (child.exitCode === null) { const exited = new Promise(resolve => child.once('exit', resolve)); child.kill(); await exited; }
  fs.closeSync(fd);
  assert(path.resolve(temp).startsWith(path.resolve(build) + path.sep));
  if (process.env.DSH_RELEASE_KEEP_TEST === '1') console.log('Diagnostic workspace: ' + temp);
  else fs.rmSync(temp, { recursive: true, force: true });
}
