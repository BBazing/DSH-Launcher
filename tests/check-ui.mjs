// Optional visual check. Set PLAYWRIGHT_PACKAGE to an installed Playwright
// environment's package.json, or install Playwright in this repository.
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(process.env.PLAYWRIGHT_PACKAGE || path.join(root, 'package.json'));
const { chromium } = require('playwright');
fs.mkdirSync(path.join(root, 'build'), { recursive: true });
const temp = fs.mkdtempSync(path.join(root, 'build', 'browser-'));
process.env.TEMP = temp; process.env.TMP = temp;
const home = path.join(temp, 'home'), data = path.join(temp, 'data');
fs.mkdirSync(home); fs.mkdirSync(data);
const probe = net.createServer();
await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
const port = probe.address().port;
await new Promise(resolve => probe.close(resolve));
const server = spawn(path.join(root, 'vendor/node/node.exe'), ['server/server.mjs'], { cwd: path.join(root, 'app'), env: { ...process.env, PORT: String(port), DSH_LAUNCHER_DATA: data, DSH_LAUNCHER_HOME: home, DSH_LAUNCHER_CONFIG: path.join(data, 'config.json'), DSH_DESKTOP_EXE: '' }, windowsHide: true, stdio: 'ignore' });
let browser;
try {
  for (let n = 0; n < 80; n++) { try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) break; } catch {} await new Promise(resolve => setTimeout(resolve, 100)); }
  const edge = process.env.EDGE_EXE || path.join(process.env['ProgramFiles(x86)'], 'Microsoft/Edge/Application/msedge.exe');
  browser = await chromium.launch({ executablePath: edge, headless: true });
  const page = await browser.newPage({ viewport: { width: 1080, height: 643 }, deviceScaleFactor: 1 });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/account**', route => route.fulfill({ json: { status: 'desktop-missing', profile: null, attempt: null } }));
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.getByRole('heading', { name: '准备 DeepSeek Harness', exact: true }).waitFor();
  await page.getByText('未找到 DSH', { exact: true }).waitFor();
  for (const [width, height] of [[1080, 643], [850, 560], [700, 470]]) {
    await page.setViewportSize({ width, height });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth || document.querySelector('#content').scrollWidth > document.querySelector('#content').clientWidth), false, 'First-run overflow');
  }
  await page.setViewportSize({ width: 1080, height: 643 });
  await page.screenshot({ path: path.join(root, 'build/first-run.png') });
  await page.locator('#accountCard').click();
  await page.getByRole('button', { name: '选择 DSH 程序', exact: true }).last().click();
  await page.getByRole('textbox', { name: '桌面程序路径', exact: true }).waitFor();
  await page.evaluate(() => { window.testMessages = []; window.chrome.webview = { postMessage: message => window.testMessages.push(message) }; });
  await page.getByRole('button', { name: '浏览…', exact: true }).click();
  assert.deepEqual(await page.evaluate(() => window.testMessages), ['desktop:choose']);
  const fake = path.join(temp, 'fixture.exe'); fs.writeFileSync(fake, 'Never executed');
  await page.evaluate(file => window.dshDesktopSelected(file), fake);
  assert.equal(await page.getByRole('textbox', { name: '桌面程序路径', exact: true }).inputValue(), fake);
  await page.evaluate(() => delete window.chrome.webview);
  await page.locator('[data-group="home"]').click();
  assert.equal(await page.locator('#launchButton').isEnabled(), true);
  await page.locator('[data-group="more"]').click();
  await page.locator('[data-page="about"]').click();
  assert.equal(await page.getByRole('link', { name: '下载 DSH', exact: true }).getAttribute('href'), 'https://www.deepseek.com/download/');
  await page.screenshot({ path: path.join(root, 'build/release-about.png') });
  assert.deepEqual(errors, []);
  console.log('PASS: empty first-run UI, three sizes, missing-DSH login, native file-picker bridge, persisted path and first desktop launch entry');
} finally {
  await browser?.close();
  if (server.exitCode === null) { const exited = new Promise(resolve => server.once('exit', resolve)); server.kill(); await exited; }
  assert(path.resolve(temp).startsWith(path.join(root, 'build') + path.sep));
  fs.rmSync(temp, { recursive: true, force: true });
}
