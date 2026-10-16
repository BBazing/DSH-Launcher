import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const workerFile = fileURLToPath(new URL('./account-worker.mjs', import.meta.url));
let current;
export class DshAccountBridge {
  constructor(exe, home, workerOptions = {}) {
    const asar = path.join(path.dirname(exe), 'resources', 'app.asar');
    if (!fs.existsSync(exe) || !fs.existsSync(asar)) throw new Error('未找到 DSH 桌面版，请在设置中检查桌面程序路径。');
    this.pending = new Map();
    this.sequence = 0;
    this.closed = false;
    this.child = spawn(exe, [workerFile, asar, home, JSON.stringify(workerOptions)], { windowsHide: true,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_HOME: home }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    this.ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { reject(new Error('DSH 登录组件启动超时。')); this.close(); }, 15000);
      const fail = () => {
        clearTimeout(timer);
        this.closed = true;
        reject(new Error('DSH 登录组件已停止，请重试。'));
        for (const { reject: rejectCall, timer: callTimer } of this.pending.values()) { clearTimeout(callTimer); rejectCall(new Error('DSH 登录组件已停止，请重试。')); }
        this.pending.clear();
      };
      this.child.on('error', fail);
      this.child.on('exit', fail);
      this.child.on('message', (message) => {
        if (message.ready !== undefined) {
          clearTimeout(timer);
          if (message.ready) resolve();
          else { reject(new Error(message.error)); this.close(); }
          return;
        }
        const call = this.pending.get(message.id);
        if (!call) return;
        clearTimeout(call.timer);
        this.pending.delete(message.id);
        if (message.error) call.reject(new Error(message.error));
        else call.resolve(message.value);
      });
    });
  }
  async call(method, body = {}) {
    await this.ready;
    if (this.closed) throw new Error('DSH 登录组件已停止，请重试。');
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('DSH 账号操作超时，请重试。')); }, 30000);
      this.pending.set(id, { resolve, reject, timer });
      this.child.send({ id, method, body }, error => {
        if (!error || !this.pending.has(id)) return;
        clearTimeout(timer); this.pending.delete(id); reject(new Error('无法连接 DSH 登录组件。'));
      });
    });
  }
  close() {
    this.closed = true;
    if (this.child.connected) this.child.disconnect();
    const timer = setTimeout(() => { if (this.child.exitCode === null) this.child.kill(); }, 3000);
    timer.unref();
  }
}

export function accountBridge(exe, home) {
  const key = JSON.stringify([exe, home]);
  if (!current || current.key !== key || current.bridge.closed) {
    current?.bridge.close();
    current = { key, bridge: new DshAccountBridge(exe, home) };
  }
  return current.bridge;
}
