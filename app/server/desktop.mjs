import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const script = fileURLToPath(new URL('../native/desktop-window.ps1', import.meta.url));

export function spawnDesktop(command, args, options) {
  return spawn(command, args, { ...options, windowsHide: false, detached: true });
}

/** Inspect the actual Electron window, including hidden windows with MainWindowHandle=0. */
export async function desktopWindow(executable, { pid = 0, wait = 0, show = false } = {}) {
  if (process.platform !== 'win32') throw new Error('DSH 桌面版需要 Windows');
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script,
    '-Executable', executable, '-TargetProcessId', String(pid), '-WaitMilliseconds', String(wait)];
  if (show) args.push('-Show');
  const { stdout } = await run('powershell.exe', args, { windowsHide: true, timeout: wait + 15000, encoding: 'utf8' });
  return JSON.parse(stdout.trim());
}
