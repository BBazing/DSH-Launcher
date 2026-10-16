'use strict';

function uiPreferences() {
  try { return JSON.parse(localStorage.getItem('dsh-launcher-ui') ?? '{}') ?? {}; }
  catch { return {}; }
}

function saveUiPreferences(patch) {
  const next = { ...uiPreferences(), ...patch };
  localStorage.setItem('dsh-launcher-ui', JSON.stringify(next));
  document.documentElement.dataset.palette = next.palette ?? 'blue';
  $('#appBrand').textContent = next.brand || 'DSH';
  return next;
}

function profileMeta(name = state.currentProfile) { return uiPreferences().profiles?.[name] ?? {}; }
function profileTitle(name = state.currentProfile) { return profileMeta(name).title || name || '未选择实例'; }
function saveProfileMeta(patch, name = state.currentProfile) {
  const profiles = { ...uiPreferences().profiles, [name]: { ...profileMeta(name), ...patch } };
  saveUiPreferences({ profiles });
}
function currentProfile() { return state.overview.profiles.find((p) => p.name === state.currentProfile); }
function profileIcon(name = state.currentProfile) {
  const icon = profileMeta(name).icon;
  return `assets/${icon && icon !== 'auto' ? icon : name === 'desktop' ? 'anvil' : 'grass'}.png`;
}

const PCL_ICONS = {
  cube: '<path d="m12 2 10 5.5v9L12 22 2 16.5v-9zM2 7.5 12 13l10-5.5M12 13v9M7 4.7l10 5.5"/>',
  settings: '<path d="M15 3a6 6 0 0 0-7 7L2 16a3.5 3.5 0 0 0 5 5l6-6a6 6 0 0 0 8-7l-5 5-5-5 5-5z"/>',
  plugins: '<path d="M9 3v5H3v7h5a3 3 0 1 0 6 0h7V8h-6V3z"/>',
  shirt: '<path d="m8 3-6 4 3 5 3-2v12h8V10l3 2 3-5-6-4c-1 4-7 4-8 0z"/>',
  grid: '<rect x="3" y="3" width="6" height="6" rx=".5"/><rect x="15" y="3" width="6" height="6" rx=".5"/><rect x="3" y="15" width="6" height="6" rx=".5"/><rect x="15" y="15" width="6" height="6" rx=".5"/>',
  help: '<circle cx="12" cy="12" r="10"/><path d="M9 8a3.1 3.1 0 1 1 5 2.5c-2 1.2-2 1.5-2 3.5m0 3v.5"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 10v7m0-11v1"/>',
  add: '<circle cx="12" cy="12" r="10"/><path d="M12 6v12M6 12h12"/>',
  clone: '<path d="M8 4h11v14H8zM5 8H3v14h11v-2"/>',
  feedback: '<path d="m8 3 9 6-7 11H2v-8zM2 22h20M5 11l9 6"/>',
  logs: '<path d="M5 3h14v18H5zM8 8h8M8 12h8M8 16h5"/>',
  launch: '<path d="m5 3 16 9-16 9z"/>',
  search: '<circle cx="10" cy="10" r="7"/><path d="m16 16 6 6"/>',
  chevron: '<path d="m6 9 6 6 6-6"/>',
};

function pclIcon(name, cls = '') {
  return el('span', { class: 'pcl-vector ' + cls, html: `<svg viewBox="0 0 24 24" aria-hidden="true">${PCL_ICONS[name] ?? PCL_ICONS.cube}</svg>` });
}

function pclSheet(title, children, options = {}) {
  const body = el('div', { class: 'pcl-sheet-body ' + (options.bodyClass ?? '') }, ...[].concat(children));
  if (options.fold) return el('details', { class: 'pcl-sheet pcl-fold ' + (options.className ?? ''), open: options.open ? true : null },
    el('summary', { class: 'pcl-sheet-heading' }, el('span', {}, title), pclIcon('chevron', 'pcl-chevron')), body);
  return el('section', { class: 'pcl-sheet ' + (options.className ?? '') },
    title ? el('h2', { class: 'pcl-sheet-heading' }, title) : null, body);
}

function pclResourceRow(title, subtitle, icon, onClick, tail = null) {
  return el(onClick ? 'button' : 'div', { class: 'pcl-resource-row', onclick: onClick },
    el('img', { class: 'pcl-resource-icon', src: icon, alt: '', width: 40, height: 40 }),
    el('span', { class: 'pcl-resource-text' }, el('span', { class: 'pcl-resource-title' }, title),
      el('span', { class: 'pcl-resource-subtitle' }, subtitle)), tail);
}

function pclSelect(label, value, choices, onChange) {
  return el('select', { class: 'pcl-input', 'aria-label': label, onchange: (e) => onChange?.(e.target.value) },
    ...choices.map(([key, title]) => el('option', { value: key, selected: String(key) === String(value) ? 'selected' : null }, title)));
}
function pclText(label, value, onChange, placeholder = '') {
  return el('input', { class: 'pcl-input', type: 'text', value: value ?? '', placeholder, 'aria-label': label, onchange: (e) => onChange?.(e.target.value) });
}
function pclFormRow(label, control) { return el('div', { class: 'pcl-form-row' }, el('span', { class: 'pcl-form-label' }, label), control); }
function pclOutline(text, onClick, attrs = {}) { return el('button', { class: 'pcl-outline', onclick: onClick, ...attrs }, text); }

function selectDesktopProgram() {
  if (window.chrome?.webview) window.chrome.webview.postMessage('desktop:choose');
  else { navigate('settings'); toast('在“桌面程序路径”中填写已安装的 DeepSeek Harness.exe 路径。'); }
}
window.dshDesktopSelected = async (desktopExe) => {
  if (typeof desktopExe !== 'string' || !desktopExe) return;
  if (await saveLauncherOption({ desktopExe })) { await refresh(); await refreshAccount(true); }
};

function firstRunPage() {
  return el('div', { class: 'pcl-page-stack' }, pclSheet('开始使用', el('div', { class: 'pcl-export-body' },
    el('h2', {}, '准备 DeepSeek Harness'),
    el('p', {}, '请先安装 DSH 桌面版；已经安装的话，选择它的程序文件即可。'),
    el('div', { class: 'pcl-shortcut-grid' },
      el('a', { class: 'pcl-outline pcl-credit-link', href: 'https://www.deepseek.com/download/', target: '_blank', rel: 'noopener noreferrer' }, '官方下载 DSH'),
      pclOutline('选择 DSH 程序', selectDesktopProgram)),
    el('p', { class: 'pcl-sheet-hint' }, '使用网页版：到“下载”安装运行时，再在“版本选择”中新建 Web 实例。'))));
}

async function saveLauncherOption(patch) {
  try {
    const response = await api('/config', { method: 'POST', body: patch });
    state.overview.config = response.config;
    if (patch.activeProfile) { state.currentProfile = patch.activeProfile; state.plugins = null; renderShell(); }
    toast('设置已保存', 'ok');
    return true;
  } catch (e) { toast(e.message, 'err'); return false; }
}

function openChoiceDialog(title, caption, choices, current, onConfirm) {
  let selected = current;
  const fieldset = el('fieldset', { class: 'pcl-dialog-choices' },
    el('legend', {}, caption), ...choices.map(([value, label, description]) => el('label', { class: 'pcl-dialog-choice' },
      el('input', { type: 'radio', name: 'pcl-dialog-choice', value, checked: value === current ? true : null, onchange: () => { selected = value; } }),
      el('span', {}, label, description ? el('small', {}, description) : null))));
  openModal(title, [fieldset, pclOutline('确定', () => onConfirm(selected))]);
}

function openLocalFolder(kind) {
  const overview = state.overview;
  const profile = currentProfile();
  const paths = { profile: profile?.dir, plugins: profile?.dir ? profile.dir + '\\node_modules' : null,
    home: overview.dshHome, sessions: overview.dshHome + '\\sessions', logs: overview.root + '\\logs', backups: overview.backupRoot };
  const folder = paths[kind];
  if (!folder) return toast('请先选择实例', 'err');
  if (window.chrome?.webview) window.chrome.webview.postMessage(JSON.stringify({ type: 'open-folder', path: folder }));
  else copyText(folder);
}

function renderPclShell() {
  const home = state.page === 'home';
  const group = PAGE_GROUPS[state.page] ?? 'more';
  const nested = group === 'selection' || group === 'profile';
  document.documentElement.dataset.view = home ? 'home' : 'page';
  $('#workspace').dataset.home = String(home);
  $('#workspace').dataset.group = group;
  $('#homeLeft').hidden = !home;
  $('#pageLeft').hidden = home;
  $('#pageToolbar').hidden = true;
  $('#appBrand').hidden = nested;
  $('#mainTabs').hidden = nested;
  $('#windowBack').hidden = !nested;
  $('#windowBackTitle').textContent = group === 'selection' ? '版本选择' : '版本设置 - ' + profileTitle();
  document.querySelectorAll('.pcl-tab[data-group]').forEach((b) => b.classList.toggle('active', b.dataset.group === group));
  if (group === 'selection') {
    $('#sectionNav').replaceChildren(
      el('div', { class: 'pcl-side-caption' }, '文件夹列表'),
      el('button', { class: 'pcl-folder-current', onclick: () => openLocalFolder('home') }, el('span', {}, '当前文件夹'), el('small', {}, state.overview.dshHome)),
      el('div', { class: 'pcl-side-caption pcl-side-gap' }, '添加或导入'),
      el('button', { class: 'pcl-side-item', onclick: promptNewProfile }, pclIcon('add'), el('span', {}, '新建实例')),
      el('button', { class: 'pcl-side-item', onclick: () => { promptNewProfile(); $('#npSrc').value = state.currentProfile ?? ''; } }, pclIcon('clone'), el('span', {}, '克隆当前实例')),
    );
  } else if (!home) {
    const icons = { versions: 'cube', market: 'plugins', selection: 'cube', settings: 'launch', appearance: 'shirt', otherSettings: 'grid',
      profileOverview: 'cube', profileSettings: 'settings', plugins: 'plugins', profileExport: 'cube', help: 'help', about: 'info', tools: 'cube', feedback: 'feedback', logs: 'logs' };
    $('#sectionNav').replaceChildren(...(GROUP_PAGES[group] ?? []).map(([page, title]) => page
      ? el('button', { class: 'pcl-side-item' + (page === state.page ? ' active' : ''), 'data-page': page, onclick: () => navigate(page) }, pclIcon(icons[page]), el('span', {}, title))
      : el('div', { class: 'pcl-side-caption pcl-side-gap' }, title)));
  }
  const instance = state.overview?.instances.find((i) => i.profile === state.currentProfile);
  $('#launchLabel').textContent = state.launchPending.has(state.currentProfile) ? (instance?.running ? '正在处理…' : '正在启动…') : instance?.running ? '停止 DSH' : '启动 DSH';
  $('#launchDetail').textContent = profileTitle();
  $('#launchButton').disabled = !state.currentProfile || state.launchPending.has(state.currentProfile);
  renderAccount();
}

async function selectProfile(name) {
  try {
    await api('/config', { method: 'POST', body: { activeProfile: name } });
    state.currentProfile = name; state.plugins = null;
    await navigate('home');
  } catch (e) { toast(e.message, 'err'); }
}

function profileSelectionPage() {
  const profiles = state.overview.profiles;
  const sections = [];
  const favorites = profiles.filter((p) => profileMeta(p.name).favorite);
  if (favorites.length) sections.push(['收藏夹', favorites]);
  sections.push(['可启动的实例', profiles.filter((p) => !profileMeta(p.name).favorite)]);
  return el('div', { class: 'pcl-page-stack' }, ...sections.filter(([, list]) => list.length).map(([title, list]) =>
    pclSheet(`${title} (${list.length})`, list.map((p) => pclResourceRow(profileTitle(p.name),
      profileMeta(p.name).description || (p.needsFirstLaunch ? '桌面版，首次启动后自动创建实例与插件配置' : `${p.name === 'desktop' ? '桌面版' : 'Web 实例'} ${state.overview.activeRuntime ?? ''}, ${p.pluginCount} 个插件, ${p.depCount} 个扩展包`),
      profileIcon(p.name), () => selectProfile(p.name))), { fold: true, open: true, bodyClass: 'pcl-resource-list' })),
    !profiles.length ? pclSheet('本地实例', el('div', { class: 'pcl-sheet-note' }, '当前目录还没有实例，请在左侧新建。')) : null);
}

function editProfileText(field, title) {
  const input = pclText(title, profileMeta()[field] || (field === 'title' ? state.currentProfile : ''), null);
  openModal(title, [input, el('div', { class: 'row', style: 'margin-top:18px' }, pclOutline('保存', () => {
    saveProfileMeta({ [field]: input.value.trim() }); closeModal(); render();
  }))]);
}

function profileOverviewPage() {
  const profile = currentProfile();
  if (!profile) return pclSheet('未选择实例', pclOutline('版本选择', chooseProfile));
  const meta = profileMeta();
  const summary = meta.description || `${profile.name === 'desktop' ? '桌面版' : 'Web 实例'} ${state.overview.activeRuntime ?? ''}, ${profile.pluginCount} 个插件, ${profile.depCount} 个扩展包`;
  return el('div', { class: 'pcl-page-stack' },
    pclSheet(null, pclResourceRow(profileTitle(), summary, profileIcon(), null), { className: 'pcl-profile-summary' }),
    pclSheet('个性化', el('div', { class: 'pcl-profile-personal' },
      pclFormRow('图标', pclSelect('实例图标', meta.icon ?? 'auto', [['auto', '自动'], ['anvil', '铁砧'], ['grass', '草方块'], ['neoforge', 'NeoForge'], ['commandblock', '命令方块']], (icon) => { saveProfileMeta({ icon }); render(); })),
      pclFormRow('分类', pclSelect('实例分类', meta.category ?? 'auto', [['auto', '自动'], ['work', '工作'], ['test', '测试'], ['personal', '个人']], (category) => saveProfileMeta({ category }))),
      el('div', { class: 'pcl-shortcut-grid pcl-personal-buttons' },
        pclOutline('修改实例名', () => editProfileText('title', '修改显示名称')),
        pclOutline('修改实例描述', () => editProfileText('description', '修改实例描述')),
        pclOutline(meta.favorite ? '移出收藏夹' : '加入收藏夹', () => { saveProfileMeta({ favorite: !meta.favorite }); render(); })))),
    pclSheet('快捷方式', el('div', { class: 'pcl-shortcut-grid' },
      pclOutline('实例文件夹', () => openLocalFolder('profile')), pclOutline('会话文件夹', () => openLocalFolder('sessions')),
      pclOutline('插件文件夹', () => openLocalFolder('plugins')), pclOutline('日志文件夹', () => openLocalFolder('logs'))), { bodyClass: 'pcl-shortcuts' }),
    pclSheet('实例管理', el('div', { class: 'pcl-shortcut-grid' }, pclOutline('插件管理', () => navigate('plugins')),
      pclOutline('安装实例依赖', async () => {
        try { const r = await api(`/profiles/${encodeURIComponent(state.currentProfile)}/prepare`, { method: 'POST', body: {} }); watchJob(r.jobId, '安装实例依赖', refresh); }
        catch (e) { toast(e.message, 'err'); }
      }), pclOutline('回收此实例', () => confirmDelete(profile))), { bodyClass: 'pcl-shortcuts' }));
}

function installRuntime(version) {
  openModal('安装 DSH', [el('p', {}, `安装 DSH ${version || 'latest'} 到启动器的运行时目录？`),
    pclOutline('开始安装', async () => {
      try { const r = await api('/runtimes/install', { method: 'POST', body: { version } }); watchJob(r.jobId, '安装 DSH ' + (version || 'latest'), async () => { state.runtimeCatalog = null; await refresh(); }); }
      catch (e) { toast(e.message, 'err'); }
    })]);
}

async function loadRuntimeCatalog() {
  if (state.catalogStatus === 'loading' || state.runtimeCatalog) return;
  state.catalogStatus = 'loading'; state.catalogError = '';
  try { state.runtimeCatalog = await api('/runtimes/query'); state.catalogStatus = 'ready'; }
  catch (e) { state.catalogStatus = 'error'; state.catalogError = e.message; }
  if (state.page === 'versions') render();
}

function runtimeRow(version, description, icon = 'grass') {
  return pclResourceRow(version || '正在获取版本…', description, `assets/${icon}.png`, version ? () => installRuntime(version) : null);
}

function versionsPage() {
  const catalog = state.runtimeCatalog;
  const versions = catalog?.versions ?? [];
  const stable = versions.filter((v) => !v.includes('-'));
  const previews = versions.filter((v) => v.includes('-'));
  const latest = catalog?.latest;
  const preview = catalog?.tags?.next || catalog?.tags?.beta || previews[0];
  const installed = state.overview.runtimes;
  const children = [pclSheet('最新版本', [
    runtimeRow(latest, state.catalogError ? '版本查询失败，可点击下方重试' : '最新发行版，点击安装', 'grass'),
    runtimeRow(preview, preview ? '最新预览版，点击安装' : '等待预览版信息', 'commandblock'),
    state.catalogStatus === 'error' ? el('div', { class: 'pcl-sheet-note' }, el('span', {}, state.catalogError), pclOutline('重试', () => loadRuntimeCatalog())) : null,
  ], { bodyClass: 'pcl-resource-list' }),
    pclSheet('正式版', stable.length ? stable.map((v) => runtimeRow(v, '正式版，点击安装')) : el('p', { class: 'pcl-sheet-note' }, '暂无正式版信息'), { fold: true }),
    pclSheet('预览版', previews.length ? previews.map((v) => runtimeRow(v, '预览版，点击安装', 'commandblock')) : el('p', { class: 'pcl-sheet-note' }, '暂无预览版信息'), { fold: true }),
    pclSheet('已安装版本', installed.length ? installed.map((r) => pclResourceRow('DSH ' + r.version,
      r.version === state.overview.activeRuntime ? '当前使用，下一次启动 Web 实例时生效' : '点击切换到此版本', 'assets/anvil.png', async () => {
        if (await saveLauncherOption({ runtimeVersion: r.version })) { state.overview.activeRuntime = r.version; render(); }
      })) : el('p', { class: 'pcl-sheet-note' }, '尚未安装运行时'), { fold: true }),
    pclSheet('手动安装', el('div', { class: 'pcl-manual-install' },
      pclText('指定版本号', '', null, '版本号，例如 0.1.5-rc.2；留空安装 latest'),
      pclOutline('安装', (e) => installRuntime(e.currentTarget.parentElement.querySelector('input').value.trim()))), { fold: true }),
  ];
  if (state.catalogStatus === 'idle') setTimeout(loadRuntimeCatalog, 0);
  return el('div', { class: 'pcl-page-stack' }, ...children);
}

function settingsPage() {
  const c = state.overview.config;
  const prefs = uiPreferences();
  const totalMB = Math.round((state.overview.system?.totalMemory ?? 16 * 1024 ** 3) / 1024 ** 2);
  const memoryMode = c.memoryMode ?? 'auto';
  const slider = el('input', { type: 'range', min: 512, max: Math.max(1024, totalMB), step: 256, value: c.memoryMB ?? 4096,
    disabled: memoryMode !== 'custom', 'aria-label': 'Web 实例内存上限', onchange: (e) => saveLauncherOption({ memoryMB: Number(e.target.value) }),
    oninput: (e) => { memoryAmount.textContent = (Number(e.target.value) / 1024).toFixed(1) + ' GB'; } });
  const memoryAmount = el('span', { class: 'pcl-memory-amount' }, ((c.memoryMB ?? 4096) / 1024).toFixed(1) + ' GB');
  const radio = (value, title) => el('label', { class: 'pcl-radio-label' }, el('input', { type: 'radio', name: 'memory-mode', value,
    checked: value === memoryMode ? true : null, onchange: async () => { await saveLauncherOption({ memoryMode: value }); render(); } }), title);
  return el('div', { class: 'pcl-page-stack' },
    pclSheet('启动选项', el('div', { class: 'pcl-form pcl-launch-options' },
      pclFormRow('默认实例隔离', pclSelect('默认实例隔离', c.homeMode, [['real', '使用真实 DSH 环境'], ['sandbox', '使用沙盒 DSH 环境']], async (homeMode) => { await saveLauncherOption({ homeMode }); await refresh(); })),
      pclFormRow('桌面程序路径', el('div', { class: 'pcl-path-picker' }, pclText('桌面程序路径', c.desktopExe, (desktopExe) => saveLauncherOption({ desktopExe }), '选择 DSH 桌面程序'), pclOutline('浏览…', selectDesktopProgram))),
      pclFormRow('自定义信息', pclText('自定义信息', prefs.brand || 'DSH', (brand) => saveUiPreferences({ brand: brand.trim() || 'DSH' }))),
      pclFormRow('启动器可见性', pclSelect('启动器可见性', prefs.launchVisibility ?? 'keep', [['keep', 'DSH 启动后仍保持不变'], ['minimize', 'DSH 启动后最小化']], (launchVisibility) => saveUiPreferences({ launchVisibility }))),
      pclFormRow('默认启动实例', pclSelect('默认启动实例', c.activeProfile, state.overview.profiles.map((p) => [p.name, profileTitle(p.name)]), (activeProfile) => saveLauncherOption({ activeProfile }))),
      pclFormRow('默认运行时', pclSelect('默认运行时', c.runtimeVersion || '', [['', '自动（最新已安装版本）'], ...state.overview.runtimes.map((r) => [r.version, r.version])], (runtimeVersion) => saveLauncherOption({ runtimeVersion }))))),
    pclSheet('内存分配', el('div', { class: 'pcl-memory-body' },
      radio('auto', '自动配置'), el('div', { class: 'pcl-memory-custom' }, radio('custom', '自定义'), slider),
      el('div', { class: 'pcl-memory-caption' }, el('span', {}, '系统内存 ' + (totalMB / 1024).toFixed(1) + ' GB'), memoryAmount),
      el('p', { class: 'pcl-sheet-hint' }, '为 Web 实例设置 Node.js 堆内存上限；自动配置使用运行时默认值。桌面版由 DSH 本体管理。'))),
    pclSheet('网络与服务', el('div', { class: 'pcl-form' },
      pclFormRow('镜像源', pclText('npm 镜像源', c.registry, (registry) => saveLauncherOption({ registry }))),
      pclFormRow('Web 起始端口', pclText('Web 起始端口', String(c.instancePort ?? 3080), (value) => saveLauncherOption({ instancePort: Number(value) }))))));
}

const HELP_ARTICLES = [
  { group: '指南', title: 'DSH 使用教程', subtitle: '从选择实例开始，启动你的 DeepSeek Harness', icon: 'commandblock', body: '在启动页点击“版本选择”，选中 desktop 或 Web 实例。desktop 会打开已安装的 DSH 桌面程序；Web 实例就绪后会打开本地界面。遇到启动问题可在“更多 → 百宝箱 → 运行日志”查看输出。' },
  { group: '指南', title: '实例制作指南', subtitle: '介绍独立实例、插件清单与收藏夹', icon: 'grass', body: '点击“版本选择”进入实例列表。左侧可以新建实例或克隆当前实例。每个实例有独立的插件清单与用户补丁；克隆后可在“版本设置 → 概览”安装依赖。收藏的实例会在版本选择页单独列出。' },
  { group: '指南', title: '资源安装指南', subtitle: '介绍如何安装扩展包、切换版本以及启用插件', icon: 'grass', body: '在“下载 → 插件”搜索扩展包并安装到当前实例。安装后重启实例加载新的 bundle。已有插件的开关位于“版本设置 → 插件管理”，条件启用项由 DSH 自动控制。' },
  { group: 'DSH', title: '桌面版与 Web 实例有什么区别？', subtitle: '启动方式与版本选择', icon: 'anvil', body: 'desktop 由 DSH 桌面程序管理，它不使用普通 CLI 的 --profile desktop。Web 实例使用启动器选定的 CLI 运行时，并独立监听本地端口。切换 CLI 版本只影响下一次启动的 Web 实例。' },
  { group: '百科', title: '插件、依赖包与 bundle', subtitle: '了解 DSH 插件的组成', icon: 'commandblock', body: '依赖包安装到实例目录。声明了 dsh.bundle.patch 的包会加入实例的 bundle 清单。插件树中的单个条目可以通过用户补丁启停；同一个包的不同插件实例通过 ID 区分。' },
  { group: '启动器', title: '备份与恢复', subtitle: '找回插件配置与已回收的实例', icon: 'anvil', body: '修改用户补丁、package.json 和 lockfile 前会自动备份到启动器的 backups 目录。回收的实例在 DSH 主目录下的 launcher-backups 中。恢复时先停止实例，再将需要的备份复制回原路径。' },
  { group: '个性化', title: '修改名称、图标与账号显示', subtitle: '调整启动器外观', icon: 'grasspath', body: '在“版本设置 → 概览”修改实例的显示名称、描述、图标和收藏状态。在首页点击账号区可以修改本地显示资料；实际的 DSH 登录由 DSH 本体完成。' },
];

function helpPage() {
  const input = el('input', { type: 'search', placeholder: '搜索帮助', value: state.helpQuery, 'aria-label': '搜索帮助',
    oninput: (e) => { state.helpQuery = e.target.value; paintHelp(); } });
  const results = el('div', { class: 'pcl-page-stack pcl-help-results' });
  function paintHelp() {
    const query = state.helpQuery.trim().toLowerCase();
    const matches = HELP_ARTICLES.filter((a) => `${a.title} ${a.subtitle} ${a.body}`.toLowerCase().includes(query));
    results.replaceChildren(...['指南', 'DSH', '百科', '启动器', '个性化'].map((group) => {
      const articles = matches.filter((a) => a.group === group);
      if (!articles.length) return null;
      return pclSheet(group, articles.map((a) => pclResourceRow(a.title, a.subtitle, `assets/${a.icon}.png`, () => openModal(a.title, [el('p', { class: 'pcl-help-article' }, a.body)]))), { fold: true, open: group === '指南' || Boolean(query), bodyClass: 'pcl-resource-list' });
    }).filter(Boolean));
    if (!matches.length) results.append(pclSheet('搜索结果', el('p', { class: 'pcl-sheet-note' }, '没有找到相关帮助。')));
  }
  paintHelp();
  return el('div', { class: 'pcl-page-stack' }, el('div', { class: 'pcl-sheet pcl-help-search' }, pclIcon('search'), input), results);
}

function downloadProfileManifest() {
  const p = currentProfile();
  if (!p) return toast('请先选择实例', 'err');
  const manifest = { format: 'dsh-launcher-profile-v1', name: p.name, display: profileMeta(), dependencies: p.deps, bundles: p.bundles };
  const blob = new Blob([JSON.stringify(manifest, null, 2) + '\n'], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = el('a', { href: url, download: `${p.name}.dsh-profile.json` });
  link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function initializePclPages() {
  pages.home = () => state.overview.desktopInstalled === false && !state.overview.profiles.length ? firstRunPage() : el('div', { class: 'pcl-home-right', 'aria-label': '启动背景' });
  Object.assign(PAGE_META, { selection: ['版本选择', '本地实例'], profileOverview: ['概览', '实例概览'], profileSettings: ['设置', '实例设置'], profileExport: ['导出', '实例清单'], appearance: ['个性化', '启动器外观'], otherSettings: ['其他', '工具与备份'], help: ['帮助', '使用指南'], tools: ['百宝箱', '本地工具'], feedback: ['反馈', '问题排查'] });
  pages.selection = profileSelectionPage;
  pages.profileOverview = profileOverviewPage;
  pages.versions = versionsPage;
  pages.settings = settingsPage;
  pages.help = helpPage;
  pages.profileSettings = () => pclSheet('实例设置', el('div', { class: 'pcl-form' },
    pclFormRow('当前实例', el('span', {}, profileTitle())),
    pclFormRow('实例目录', el('div', { class: 'pcl-path-value' }, currentProfile()?.dir ?? '未选择实例')),
    pclFormRow('默认启动', pclSelect('默认启动', state.overview.config.activeProfile === state.currentProfile ? 'yes' : 'no', [['yes', '使用当前实例'], ['no', '保持现有默认实例']], (value) => { if (value === 'yes') saveLauncherOption({ activeProfile: state.currentProfile }); })),
    el('div', { class: 'pcl-shortcut-grid' }, pclOutline('打开实例目录', () => openLocalFolder('profile')), pclOutline('插件管理', () => navigate('plugins')))));
  pages.profileExport = () => pclSheet('导出实例清单', el('div', { class: 'pcl-export-body' },
    el('p', {}, '导出当前实例的扩展包、bundle 清单和显示资料。'),
    el('p', { class: 'pcl-sheet-hint' }, '不包含账号凭据、聊天记录或插件的私有配置。'),
    pclOutline('导出 JSON 清单', downloadProfileManifest)));
  pages.appearance = () => pclSheet('个性化', el('div', { class: 'pcl-form' },
    pclFormRow('主题颜色', pclSelect('主题颜色', uiPreferences().palette ?? 'blue', [['blue', 'PCL 蓝'], ['purple', '紫色'], ['green', '绿色']], (palette) => saveUiPreferences({ palette }))),
    pclFormRow('自定义信息', pclText('自定义信息', uiPreferences().brand || 'DSH', (brand) => saveUiPreferences({ brand }))),
    el('div', { class: 'pcl-shortcut-grid' }, pclOutline('管理 DeepSeek 账号', openAccountDialog), pclOutline('恢复默认外观', () => { saveUiPreferences({ palette: 'blue', brand: 'DSH' }); render(); }))));
  pages.otherSettings = () => el('div', { class: 'pcl-page-stack' }, pclSheet('环境信息', el('div', { class: 'pcl-form' },
    pclFormRow('Node.js', el('span', {}, state.overview.tools.nodeVersion)), pclFormRow('DSH 主目录', el('span', { class: 'pcl-path-value' }, state.overview.dshHome)))),
    pclSheet('备份与工具', el('div', { class: 'pcl-shortcut-grid' }, pclOutline('备份文件夹', () => openLocalFolder('backups')), pclOutline('实例管理', () => navigate('instances')), pclOutline('运行日志', () => navigate('logs')),
      pclOutline('切换运行环境', () => openChoiceDialog('切换运行环境', '选择启动器管理的 DSH 环境', [['real', '真实环境', '使用本机已有的实例和插件'], ['sandbox', '沙盒环境', '使用启动器目录内的独立实例']], state.overview.config.homeMode, async (homeMode) => {
        if (await saveLauncherOption({ homeMode })) { closeModal(); await refresh(); }
      }))), { bodyClass: 'pcl-shortcuts' }));
  pages.tools = () => pclSheet('百宝箱', el('div', { class: 'pcl-shortcut-grid' }, pclOutline('运行日志', () => navigate('logs')), pclOutline('实例管理', () => navigate('instances')), pclOutline('打开 DSH 目录', () => openLocalFolder('home')), pclOutline('打开备份目录', () => openLocalFolder('backups')),
    pclOutline('完全退出启动器', () => openModal('完全退出启动器', [el('p', {}, '退出窗口和后台服务。正在运行的实例及下载任务需要先停止。'), pclOutline('确认退出', async () => { try { await api('/launcher/exit', { method: 'POST', body: {} }); windowAction('close'); } catch (e) { toast(e.message, 'err'); } })]))), { bodyClass: 'pcl-shortcuts' });
  pages.feedback = () => pclSheet('问题排查', el('div', { class: 'pcl-export-body' }, el('p', {}, '请先查看对应实例的运行日志，复制错误信息后提供给维护者。'), pclOutline('查看运行日志', () => navigate('logs'))));
  pages.about = () => el('div', { class: 'pcl-page-stack' }, pclSheet('DSH Launcher', el('div', { class: 'pcl-export-body' }, el('h2', {}, 'DeepSeek Harness 启动器'), el('p', {}, '本地实例、运行时与插件管理'), el('p', { class: 'pcl-sheet-hint' }, '界面参照用户提供的 PCL 截图制作。'))),
    pclSheet('鸣谢', el('div', { class: 'pcl-credit-list' }, ...[
      ['DeepSeek', '提供模型与智能体技术', 'DeepSeek 官网', 'https://www.deepseek.com/'],
      ['DeepSeek Harness', '实例与插件运行时', '下载 DSH', 'https://www.deepseek.com/download/'],
      ['Plain Craft Launcher 2 · 龙腾猫跃', '界面与图标参考；独立项目，与 PCL 官方无隶属关系', 'PCL 项目主页', 'https://github.com/Meloong-Git/PCL'],
      ['Microsoft WebView2', '原生窗口内核'],
    ].map(([name, description, label, href]) => el('div', { class: 'pcl-credit-row' },
      el('div', { class: 'pcl-credit-text' }, el('span', { class: 'pcl-resource-title' }, name), el('span', { class: 'pcl-resource-subtitle' }, description)),
      href ? el('a', { class: 'pcl-outline pcl-credit-link', href, target: '_blank', rel: 'noopener noreferrer' }, label) : null)))));
  saveUiPreferences({});
}
