/* ============================================================
   DSH Launcher — 前端逻辑
   ============================================================ */
'use strict';

const $ = (sel, root = document) => root.querySelector(sel);
const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'html') n.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2).toLowerCase(), v);
    else n.setAttribute(k, v);
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false) continue;
    n.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return n;
};
const esc = (s) => String(s ?? '');

const api = async (path, opts = {}) => {
  const res = await fetch('/api' + path, {
    method: opts.method ?? 'GET',
    headers: opts.body ? { 'content-type': 'application/json' } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* 非 JSON */ }
  if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
  return data;
};

/* ------------------------------------------------------------- 状态 */

const state = {
  page: 'home',
  overview: null,
  plugins: null,
  market: null,
  marketQuery: '',
  logs: [],
  logSeq: 0,
  logTimer: null,
  currentProfile: null,
  busy: false,
  launchPending: new Set(),
  pluginQuery: '',
  pluginFilter: 'all',
  runtimeCatalog: null,
  catalogStatus: 'idle',
  catalogError: '',
  helpQuery: '',
  backPage: 'home',
};

const PAGE_META = {
  home: ['主页', '总览环境、快速启动'],
  instances: ['实例', '管理 DSH profile 与运行中的实例'],
  versions: ['版本', '安装 / 切换 dsh 本体版本'],
  plugins: ['插件', '启停 profile 内的插件'],
  market: ['插件市场', '从 npm 检索并安装插件'],
  logs: ['日志', '实例运行输出'],
  settings: ['设置', 'DSH 主目录、镜像源与安全'],
  about: ['关于', 'DSH Launcher'],
};

/* ------------------------------------------------------------- 通用 UI */

const activeToasts = new Map();
function toast(msg, kind = '') {
  const message = String(msg).replace(/\s*\n\s*/g, ' ');
  const key = kind + ':' + message;
  const old = activeToasts.get(key);
  if (old) { old.remove(); activeToasts.delete(key); }
  if (activeToasts.size >= 20) return;
  const t = el('div', { class: `toast ${kind}`, role: kind === 'err' ? 'alert' : 'status' }, message);
  $('#toasts').append(t);
  activeToasts.set(key, t);
  const life = 800 + Math.min(23, Math.max(5, message.length)) * 180;
  setTimeout(() => { t.style.opacity = '0'; t.style.transform = 'translateX(-50px)'; }, life);
  setTimeout(() => { t.remove(); if (activeToasts.get(key) === t) activeToasts.delete(key); }, life + 200);
}

let modalReturnFocus = null;
let modalGeneration = 0;
function openModal(title, bodyNodes, options = {}) {
  modalGeneration++;
  $('#modal').classList.remove('is-closing');
  if ($('#modal').hidden) modalReturnFocus = document.activeElement;
  $('#modalTitle').textContent = title;
  const b = $('#modalBody'); b.replaceChildren(...[].concat(bodyNodes));
  const actions = [];
  const children = Array.from(b.children);
  const last = children[children.length - 1];
  if (last?.tagName === 'BUTTON') actions.push(last);
  else if (last && !last.querySelector('input,select,textarea') && last.querySelectorAll('button').length) {
    actions.push(...last.querySelectorAll('button'));
    last.remove();
  }
  const primaryActions = actions.filter((button) => !['取消', '关闭'].includes(button.textContent.trim()));
  $('#modalActions').replaceChildren(...primaryActions);
  for (const button of actions) if (!primaryActions.includes(button)) button.remove();
  $('#modalClose').textContent = options.closeText || (primaryActions.length ? '取消' : '确定');
  $('#modal').dataset.warning = String(Boolean(options.warning || /^(删除|卸载|回收)/.test(title)));
  $('#modal').dataset.kind = b.querySelector('input,textarea') ? 'input' : 'text';
  $('#modal').hidden = false;
  setTimeout(() => {
    const input = b.querySelector('input:not([type="hidden"]),textarea,select');
    (input ?? $('#modalActions').querySelector('button') ?? $('#modalClose')).focus();
  }, 60);
}
const closeModal = () => {
  if ($('#modal').hidden) return;
  const generation = ++modalGeneration;
  $('#modal').classList.add('is-closing');
  setTimeout(() => {
    if (generation !== modalGeneration) return;
    $('#modal').hidden = true;
    $('#modal').classList.remove('is-closing');
    modalReturnFocus?.focus?.();
  }, 150);
};

function setBusy(on) {
  state.busy = on;
  document.querySelectorAll('.content .btn').forEach((b) => {
    if (b.dataset.keepEnabled) return;
    b.disabled = on;
  });
}

function tag(text, cls = '') { return el('span', { class: `tag ${cls}` }, text); }

function copyText(text) {
  navigator.clipboard?.writeText(text).then(
    () => toast('已复制到剪贴板', 'ok'),
    () => toast('复制失败', 'err'));
}

/* ------------------------------------------------------------- 数据加载 */

async function loadOverview() {
  state.overview = await api('/state');
  if (!state.overview.profiles.some((p) => p.name === state.currentProfile)) {
    const names = state.overview.profiles.map((p) => p.name);
    state.currentProfile = names.includes(state.overview.config.activeProfile)
      ? state.overview.config.activeProfile
      : (names[0] ?? null);
  }
  updateStatusPill();
}

function updateStatusPill() {
  const pill = $('#statusPill');
  const o = state.overview;
  if (!o) return;
  const running = o.instances.filter((i) => i.running);
  const cls = running.length ? 'ok' : (o.activeRuntime ? 'warn' : 'err');
  const text = running.length
    ? `${running.length} 个实例运行中${running[0].port ? ' · :' + running[0].port : ''}`
    : (o.activeRuntime ? `就绪 · dsh ${o.activeRuntime}` : '未安装 dsh 运行时');
  pill.className = `pill ${cls}`;
  pill.querySelector('span').textContent = text;
}

async function loadPlugins(profile) {
  state.currentProfile = profile ?? state.currentProfile;
  if (!state.currentProfile) { state.plugins = null; return; }
  const requestedProfile = state.currentProfile;
  try {
    const plugins = await api(`/profiles/${encodeURIComponent(requestedProfile)}/plugins`);
    if (state.currentProfile === requestedProfile) state.plugins = plugins;
  } catch (e) {
    if (state.currentProfile !== requestedProfile) return;
    state.plugins = null;
    if (!/404/.test(e.message)) toast(e.message, 'err');
  }
}

/* ------------------------------------------------------------- 任务轮询 */

function watchJob(jobId, title, onDone) {
  const box = el('div', {},
    el('div', { class: 'row' }, el('span', { class: 'spinner' }), el('b', {}, title)),
    el('div', { class: 'bar', style: 'margin:10px 0' }, el('i', { id: 'jobbar' })));
  const pre = el('div', { class: 'log-view', style: 'height:300px' });
  box.append(pre);
  openModal(title, [box], { closeText: '隐藏' });

  let since = 0;
  const tick = async () => {
    try {
      const j = await api(`/jobs/${jobId}?since=${since}`);
      since = j.next;
      for (const line of j.lines) {
        pre.append(el('div', { class: line.startsWith('$') ? 'l-system' : '' }, line));
      }
      if (j.lines.length) pre.scrollTop = pre.scrollHeight;
      if (j.status === 'running') { setTimeout(tick, 700); return; }
      const spin = box.querySelector('.spinner');
      if (spin) spin.replaceWith(el('span', { class: 'tag ' + (j.status === 'ok' ? 'ok' : 'danger') },
        j.status === 'ok' ? '完成' : '失败'));
      if (j.status === 'ok') toast(`${title} 完成`, 'ok'); else toast(`${title} 失败`, 'err');
      await onDone?.();
    } catch (e) {
      toast(e.message, 'err');
    }
  };
  tick();
}

/* ------------------------------------------------------------- 页面渲染 */

const pages = {};

const PAGE_GROUPS = { home: 'home', selection: 'selection', profileOverview: 'profile', profileSettings: 'profile', plugins: 'profile', profileExport: 'profile', market: 'download', versions: 'download', settings: 'settings', appearance: 'settings', otherSettings: 'settings', instances: 'settings', help: 'more', tools: 'more', feedback: 'more', about: 'more', logs: 'more' };
const GROUP_PAGES = {
  download: [['versions', 'DSH 本体'], [null, '社区资源'], ['market', '插件'], ['selection', '实例']],
  settings: [['settings', '启动'], ['appearance', '个性化'], ['otherSettings', '其他']],
  profile: [['profileOverview', '概览'], ['profileSettings', '设置'], ['plugins', '插件管理'], ['profileExport', '导出']],
  more: [['help', '帮助'], ['about', '关于与鸣谢'], ['tools', '百宝箱'], ['feedback', '反馈']],
};
const SIDE_ICONS = {
  market: '<path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/>',
  versions: '<path d="m12 3 9 5-9 5-9-5zM3 12l9 5 9-5M3 16l9 5 9-5"/>',
  settings: '<path d="m6 3-5 9 5 9h12l5-9-5-9z"/><circle cx="12" cy="12" r="4"/>',
  instances: '<rect x="3" y="4" width="18" height="7" rx="1"/><rect x="3" y="14" width="18" height="7" rx="1"/>',
  plugins: '<path d="M9 3h6v5h5v7h-5v6H9v-6H3V8h6z"/>',
  about: '<circle cx="12" cy="12" r="9"/><path d="M12 10v7m0-11v1"/>',
  logs: '<path d="M5 3h14v18H5zM8 8h8M8 12h8M8 16h5"/>',
};

function renderShell() {
  return renderPclShell();
}

function chooseProfile() {
  return navigate('selection');
}

async function launchSelected() {
  if (!state.currentProfile) return chooseProfile();
  const profile = state.currentProfile;
  if (state.launchPending.has(profile)) return;
  const running = state.overview.instances.find((i) => i.profile === profile)?.running;
  state.launchPending.add(profile);
  renderShell();
  // Keep browser-mode popup creation in the original user gesture.
  const browserWindow = !running && profile.toLowerCase() !== 'desktop' && !window.chrome?.webview ? window.open('about:blank', '_blank') : null;
  try {
    let r = await api('/instances/' + (running ? 'stop' : 'launch'), { method: 'POST', body: { profile } });
    if (!running && !r.desktop && r.status === 'starting') {
      const deadline = Date.now() + 120000;
      while (r.status === 'starting' && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 700));
        const result = await api(`/instances/${encodeURIComponent(profile)}/log`);
        if (!result.running) throw new Error('DSH 启动进程已退出，请查看运行日志');
        r = { ...r, ...result };
      }
      if (r.status !== 'ready') throw new Error('DSH 启动耗时过长，请查看运行日志');
    }
    toast(running ? '已发送停止信号' : r.status === 'ready' ? 'DSH 已就绪' : '已启动，请在运行日志中查看状态', 'ok');
    if (r.url && !running) {
      if (browserWindow) browserWindow.location.replace(r.url);
      else window.open(r.url, '_blank');
    } else browserWindow?.close();
    if (!running && uiPreferences().launchVisibility === 'minimize') windowAction('minimize');
  } catch (e) { browserWindow?.close(); toast(e.message, 'err'); }
  finally { state.launchPending.delete(profile); await refresh(); }
}

/* ---- 主页 ---- */
pages.home = () => el('div', { class: 'pcl-home-right', 'aria-label': '启动背景' });

pages.instances = () => {
  const o = state.overview;
  const frag = document.createDocumentFragment();

  frag.append(el('div', { class: 'section-title' }, '运行中的实例'));
  if (!o.instances.length) {
    frag.append(el('div', { class: 'empty' }, '当前没有启动中的实例'));
  } else {
    frag.append(el('div', { class: 'grid' }, ...o.instances.map((i) => el('div', { class: 'card' },
      el('h3', {}, i.profile, i.running ? tag('运行中', 'ok') : tag('已停止')),
      el('p', { class: 'desc' }, `dsh ${i.runtime} · 端口 ${i.port}`),
      el('div', { class: 'row', style: 'margin-top:10px' },
        i.port && i.running ? el('button', { class: 'btn sm', onclick: () => window.open(i.url ?? `http://127.0.0.1:${i.port}/`, '_blank') }, '打开界面') : null,
        el('button', { class: 'btn ghost sm', onclick: () => { state.currentProfile = i.profile; navigate('logs'); } }, '日志'),
        i.running ? el('button', { class: 'btn danger sm', onclick: async () => {
          await api('/instances/stop', { method: 'POST', body: { profile: i.profile } });
          toast('已停止', 'ok'); refresh();
        } }, '停止') : null)))));
  }

  frag.append(el('div', { class: 'mcard' },
    el('div', { class: 'mcard-title' }, '全部 Profile',
      el('span', { class: 'tag' }, String(o.profiles.length)),
      el('div', { class: 'spacer' }),
      el('button', { class: 'btn sm', onclick: () => promptNewProfile() }, '＋ 新建 Profile')),
    el('div', { class: 'mcard-body tight' },
      o.profiles.length
        ? el('div', { class: 'pcl-list' }, ...o.profiles.map((p) => el('div', {
            class: 'pcl-item clickable',
            onclick: async () => { await loadPlugins(p.name); navigate('plugins'); },
          },
            el('div', { class: 'ico' }, p.name.slice(0, 1).toUpperCase()),
            el('div', { class: 'body' },
              el('div', { class: 't' }, p.name,
                p.healthy ? tag('可用', 'ok') : tag('配置损坏', 'warn'),
                p.hasNodeModules ? null : tag('未装依赖', 'danger')),
              el('div', { class: 'i mono' }, p.dir)),
            el('div', { class: 'tail' },
              el('span', { class: 'muted', style: 'font-size:12px' },
                `${p.pluginCount} 插件 / ${p.disabledCount} 禁用`),
              el('button', { class: 'btn ghost sm', onclick: (e) => { e.stopPropagation(); copyText(p.dir); } }, '路径'),
              !p.hasNodeModules && p.depCount ? el('button', { class: 'btn sm', onclick: async (e) => {
                e.stopPropagation();
                try { const r = await api(`/profiles/${encodeURIComponent(p.name)}/prepare`, { method: 'POST', body: {} }); watchJob(r.jobId, '安装实例依赖', refresh); }
                catch (err) { toast(err.message, 'err'); }
              } }, '安装依赖') : null,
              el('button', { class: 'btn danger sm', onclick: (e) => { e.stopPropagation(); confirmDelete(p); } }, '删除'))))
          )
        : el('div', { class: 'empty' }, `在 ${o.dshHome}\\profiles 下还没有 profile`))));

  return frag;
};

function promptNewProfile() {
  const nameInput = el('input', { type: 'text', placeholder: '例如 demo', id: 'npName' });
  const srcSelect = el('select', { id: 'npSrc' },
    el('option', { value: '' }, '（空白 profile）'),
    ...state.overview.profiles.map((p) => el('option', { value: p.name }, `克隆自 ${p.name}`)));
  openModal('新建 Profile', [
    el('p', { class: 'pcl-inline-hint' }, '每个实例拥有独立的插件集合。新建或克隆实例后，可在版本设置中安装依赖。'),
    el('div', { class: 'row', style: 'margin:12px 0' }, el('span', {}, '名称'), nameInput),
    el('div', { class: 'row' }, el('span', {}, '来源'), srcSelect),
    el('div', { class: 'row', style: 'margin-top:16px; justify-content:flex-end' },
      el('button', { class: 'btn', onclick: async () => {
        const name = $('#npName').value.trim();
        const cloneFrom = $('#npSrc').value;
        if (!name) return toast('请填写名称', 'err');
        try {
          const r = await api('/profiles', { method: 'POST', body: { name, cloneFrom } });
          toast(`已创建 ${r.profile}`, 'ok'); closeModal(); refresh();
        } catch (e) { toast(e.message, 'err'); }
      } }, '创建'),
      el('button', { class: 'btn ghost', onclick: closeModal }, '取消')),
  ]);
  nameInput.focus();
}

function confirmDelete(p) {
  openModal(`删除 Profile「${p.name}」`, [
    el('p', {}, '该实例将移入 DSH 主目录下的 launcher-backups，可从该目录手动恢复。'),
    el('p', { class: 'mono', style: 'color:var(--muted); word-break:break-all' }, p.dir),
    el('div', { class: 'row', style: 'margin-top:16px; justify-content:flex-end' },
      el('button', { class: 'btn danger', onclick: async () => {
        try { const r = await api(`/profiles/${encodeURIComponent(p.name)}`, { method: 'DELETE' });
          toast('已移入备份', 'ok'); closeModal(); refresh(); }
        catch (e) { toast(e.message, 'err'); }
      } }, '确认删除'),
      el('button', { class: 'btn ghost', onclick: closeModal }, '取消')),
  ]);
}

/* ---- 版本 ---- */
/* ---- 插件 ---- */
pages.plugins = pclPluginsPage;

/* ---- 市场 ---- */
pages.market = pclMarketPage;

function installPlugin(name, profile = state.currentProfile) {
  if (!profile) return toast('请先选择一个实例', 'err');
  openModal('安装插件', [
    el('p', {}, `将把 `, el('b', { class: 'mono' }, name), ` 安装到实例 `, el('b', {}, profileTitle(profile)), '。'),
    el('p', { class: 'muted', style: 'font-size:12.5px' },
      '安装后自动同步 bundle 清单。带有 DSH bundle 声明的包会在下次启动时加载。'),
    el('div', { class: 'row', style: 'margin-top:16px; justify-content:flex-end' },
      el('button', { class: 'btn', onclick: async () => {
        try {
          const r = await api(`/profiles/${encodeURIComponent(profile)}/plugins/install`, {
            method: 'POST', body: { spec: name } });
          watchJob(r.jobId, `安装 ${name}`, refresh);
        } catch (e) { toast(e.message, 'err'); }
      } }, '开始安装'),
      el('button', { class: 'btn ghost', onclick: closeModal }, '取消')),
  ]);
}

/* ---- 日志 ---- */
pages.logs = () => {
  const frag = document.createDocumentFragment();
  const o = state.overview;
  const profile = state.currentProfile;
  const running = o.instances.find((i) => i.profile === profile && i.running);
  state.logSeq = 0;
  state.logs = [];
  const view = el('div', { class: 'log-view' });

  frag.append(el('div', { class: 'row', style: 'margin-bottom:12px' },
    el('span', {}, '实例'), el('select', { 'aria-label': '日志实例', onchange: (e) => { state.currentProfile = e.target.value; render(); } },
      ...o.profiles.map((p) => el('option', { value: p.name, selected: p.name === profile ? 'selected' : null }, p.name))),
    running ? tag('运行中', 'ok') : tag('未运行'),
    el('div', { class: 'spacer' }),
    el('button', { class: 'btn ghost sm', onclick: () => { state.logs = []; view.replaceChildren(); } }, '清屏'),
    el('button', { class: 'btn ghost sm', onclick: () => copyText(view.innerText) }, '复制')));

  frag.append(view);

  setTimeout(() => {
    const paint = () => {
      for (const l of state.logs) {
        view.append(el('div', { class: l.stream === 'err' ? 'l-err' : (l.stream === 'system' ? 'l-system' : '') }, l.text));
      }
      state.logs = [];
      view.scrollTop = view.scrollHeight;
    };
    paint();
    if (state.logTimer) clearInterval(state.logTimer);
    state.logTimer = setInterval(async () => {
      if (!profile) return;
      try {
        const r = await api(`/instances/${encodeURIComponent(profile)}/log?since=${state.logSeq}`);
        state.logSeq = r.seq;
        if (r.lines.length) { state.logs = r.lines; if (document.body.contains(view)) paint(); }
      } catch { /* 忽略瞬时错误 */ }
    }, 1000);
  }, 0);

  return frag;
};

/* ---- 设置 ---- */
/* ------------------------------------------------------------- 路由 */

async function render() {
  if (state.logTimer) { clearInterval(state.logTimer); state.logTimer = null; }
  const [title, sub] = PAGE_META[state.page] ?? ['', ''];
  renderShell();
  $('#pageTitle').textContent = title;
  $('#pageSub').textContent = sub;
  document.querySelectorAll('.nav-btn[data-page]').forEach((b) =>
    b.classList.toggle('active', b.dataset.page === state.page));

  const content = $('#content');
  const fn = pages[state.page];
  try {
    const node = await fn();
    content.replaceChildren(node ?? el('div', { class: 'empty' }, '—'));
  } catch (e) {
    content.replaceChildren(el('div', { class: 'empty' }, '渲染失败：' + e.message));
  }
  updateStatusPill();
}

async function navigate(page) {
  if (page === 'profileOverview' && PAGE_GROUPS[state.page] !== 'profile') state.backPage = state.page;
  state.page = page;
  if (page === 'plugins') await loadPlugins(state.currentProfile);
  if (page === 'market' && !state.market && marketUi.status === 'idle') {
    void doSearch(state.marketQuery);
    $('#content').scrollTop = 0;
    return;
  }
  await render();
  $('#content').scrollTop = 0;
}

async function refresh() {
  try { await loadOverview(); } catch (e) { toast('无法连接后端：' + e.message, 'err'); }
  if (state.page === 'plugins') await loadPlugins(state.currentProfile);
  await render();
  void refreshAccount();
}

/* ------------------------------------------------------------- 启动 */

document.querySelectorAll('.nav-btn[data-page]').forEach((b) =>
  b.addEventListener('click', () => navigate(b.dataset.page)));
document.querySelectorAll('.pcl-tab[data-group]').forEach((b) => b.addEventListener('click', () => {
  navigate({ home: 'home', download: 'versions', settings: 'settings', more: 'help' }[b.dataset.group]);
}));
$('#selectVersion').addEventListener('click', chooseProfile);
$('#versionSettings').addEventListener('click', () => navigate('profileOverview'));
$('#windowBack').addEventListener('click', () => navigate(PAGE_GROUPS[state.page] === 'profile' ? state.backPage : 'home'));
$('#launchButton').addEventListener('click', launchSelected);
initializeAccount();
function windowAction(action) {
  if (window.chrome?.webview) window.chrome.webview.postMessage('window:' + action);
  else if (action === 'close') window.close();
  else if (action === 'minimize') toast('浏览器中请使用窗口本身的最小化按钮');
}
$('#windowMinimize').addEventListener('click', () => windowAction('minimize'));
$('#windowClose').addEventListener('click', () => windowAction('close'));
$('#refreshBtn').addEventListener('click', refresh);
$('#modalClose').addEventListener('click', closeModal);
document.addEventListener('keydown', (e) => {
  if ($('#modal').hidden) return;
  if (e.key === 'Escape') { closeModal(); return; }
  if (e.key === 'Tab') {
    const focusable = Array.from($('#modal').querySelectorAll('button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),a[href]'));
    if (!focusable.length) return;
    const first = focusable[0], last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
});

initializePclPages();
refresh();
setInterval(() => { if (state.page === 'home' || state.page === 'instances') refresh().catch(() => {}); }, 15000);
