'use strict';

// PageInstanceMod / MyLocalModItem geometry, with DSH package operations.
const pluginUi = { profile: null, selected: new Set(), anchor: null, busy: false };
const pluginKey = (p) => JSON.stringify([p.id ?? null, p.name ?? null]);
const pluginStatus = (p) => p.effectiveDisabled === 'conditional' ? 'conditional' : p.effectiveDisabled === true ? 'disabled' : 'enabled';
const pluginHasOverride = (p) => p.switchPatched ?? p.patched;
const PLUGIN_ACTION_PATHS = {
  enable: '<circle cx="12" cy="12" r="9"/><path d="m7.5 12 3 3 6-6"/>',
  disable: '<circle cx="12" cy="12" r="9"/><path d="M7 12h10"/>',
  reset: '<path d="M4 10a8 8 0 1 1 1 7M4 4v6h6"/>',
  cancel: '<path d="m5 5 14 14M5 19 19 5"/>',
  delete: '<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7"/>',
};
function pluginActionIcon(action) {
  return el('span', { class: 'pcl-mod-action-icon', html: `<svg viewBox="0 0 24 24" aria-hidden="true">${PLUGIN_ACTION_PATHS[action]}</svg>` });
}

function promptPluginInstall() {
  const input = el('input', { class: 'pcl-input', 'aria-label': '插件包名', placeholder: '例如 dsh-pet 或 dsh-pet@0.3.7' });
  openModal('安装插件', [el('p', {}, '输入要安装的 npm 插件包名，可指定版本。'), input,
    pclOutline('下一步', () => {
      if (!input.value.trim()) { input.focus(); return; }
      installPlugin(input.value.trim());
    })]);
}

async function changePlugins(profile, plugins, action) {
  if (pluginUi.busy) return;
  const eligible = plugins.filter((p) => action === 'reset' ? pluginHasOverride(p)
    : pluginStatus(p) !== 'conditional' && (action === 'enable' ? p.effectiveDisabled === true : p.effectiveDisabled === false));
  if (!eligible.length) return;
  pluginUi.busy = true;
  if (state.page === 'plugins') await render();
  const failed = [];
  let changed = 0;
  try {
    for (const plugin of eligible) {
      try {
        await api(`/profiles/${encodeURIComponent(profile)}/plugins/${action === 'reset' ? 'reset' : 'toggle'}`, {
          method: 'POST', body: { id: plugin.id, name: plugin.name, ...(action === 'reset' ? {} : { disabled: action === 'disable' }) },
        });
        changed++;
        if (pluginUi.profile === profile) pluginUi.selected.delete(pluginKey(plugin));
      } catch (error) { failed.push(`${plugin.id ?? plugin.name}：${error.message}`); }
    }
    if (changed) toast(`已${{ enable: '启用', disable: '禁用', reset: '恢复默认' }[action]} ${changed} 个插件`, 'ok');
    if (failed.length) openModal('部分插件未能修改', [el('p', {}, '以下插件保持选中，可以重试。'),
      el('div', { class: 'pcl-mod-errors' }, ...failed.map((message) => el('p', {}, message)))]);
    if (state.currentProfile === profile) await loadPlugins(profile);
  } finally {
    pluginUi.busy = false;
    if (state.page === 'plugins') await render();
  }
}

function pclPluginsPage() {
  const profile = state.currentProfile;
  if (pluginUi.profile !== profile) {
    pluginUi.profile = profile;
    pluginUi.selected.clear();
    pluginUi.anchor = null;
  }
  if (!state.overview.profiles.length) return pclSheet('尚未创建实例', el('div', { class: 'pcl-mod-empty' },
    el('p', {}, '请先创建一个 DSH 实例，再管理其中的插件。'), pclOutline('版本选择', () => navigate('selection'))));
  if (!state.plugins) return pclSheet('无法加载插件', el('div', { class: 'pcl-mod-empty' },
    el('p', {}, '该实例缺少可读取的 cordis.yml，无法显示插件列表。'), pclOutline('重新加载', () => navigate('plugins'))));

  const plugins = state.plugins.plugins;
  const valid = new Set(plugins.map(pluginKey));
  for (const key of pluginUi.selected) if (!valid.has(key)) pluginUi.selected.delete(key);
  const selected = () => plugins.filter((p) => pluginUi.selected.has(pluginKey(p)));
  const visible = (p) => (state.pluginFilter === 'all' || pluginStatus(p) === state.pluginFilter)
    && `${p.id ?? ''} ${p.name ?? ''}`.toLowerCase().includes(state.pluginQuery.trim().toLowerCase());
  const root = el('div', { class: 'pcl-plugin-page' });
  const selectionLabel = el('div', { class: 'pcl-mod-selection-label', 'aria-live': 'polite' });
  const batchButtons = {};
  const batch = (action, label) => {
    const button = el('button', { class: 'pcl-mod-text-action', onclick: () => changePlugins(profile, selected(), action) }, pluginActionIcon(action), label);
    batchButtons[action] = button;
    return button;
  };
  const cancel = el('button', { class: 'pcl-mod-text-action', onclick: () => { pluginUi.selected.clear(); sync(); } }, pluginActionIcon('cancel'), '取消选择');
  const selectionBar = el('section', { class: 'pcl-sheet pcl-mod-selection', 'aria-label': '批量操作', hidden: true }, selectionLabel,
    el('div', { class: 'pcl-mod-selection-actions' }, batch('enable', '启用'), batch('disable', '禁用'), batch('reset', '恢复默认'), cancel));
  const rows = [];
  function sync() {
    const picked = selected();
    for (const { p, row, select } of rows) {
      row.hidden = !visible(p);
      row.classList.toggle('selected', pluginUi.selected.has(pluginKey(p)));
      select.setAttribute('aria-pressed', String(pluginUi.selected.has(pluginKey(p))));
    }
    const shown = plugins.filter(visible);
    const hiddenCount = picked.filter((p) => !visible(p)).length;
    count.textContent = `${shown.length} / ${plugins.length}`;
    empty.hidden = shown.length > 0;
    selectionBar.hidden = !picked.length;
    root.classList.toggle('has-selection', picked.length > 0);
    selectionLabel.textContent = pluginUi.busy ? '正在修改插件…' : `已选择 ${picked.length} 个插件${hiddenCount ? `（${hiddenCount} 个已被筛选隐藏）` : ''}`;
    batchButtons.enable.disabled = pluginUi.busy || !picked.some((p) => p.effectiveDisabled === true);
    batchButtons.disable.disabled = pluginUi.busy || !picked.some((p) => p.effectiveDisabled === false);
    batchButtons.reset.disabled = pluginUi.busy || !picked.some(pluginHasOverride);
    cancel.disabled = pluginUi.busy;
    all.disabled = pluginUi.busy || !shown.length;
    all.textContent = shown.length && shown.every((p) => pluginUi.selected.has(pluginKey(p))) ? '取消全选' : '全选';
    for (const [value, button] of filters) button.setAttribute('aria-pressed', String(state.pluginFilter === value));
  }
  const search = el('input', { type: 'search', 'aria-label': '搜索已安装插件', placeholder: '搜索插件名称 / 包名 / ID', value: state.pluginQuery,
    oninput: (event) => { state.pluginQuery = event.target.value; sync(); } });
  const all = pclOutline('全选', () => {
    const shown = plugins.filter(visible);
    const deselect = shown.every((p) => pluginUi.selected.has(pluginKey(p)));
    for (const p of shown) deselect ? pluginUi.selected.delete(pluginKey(p)) : pluginUi.selected.add(pluginKey(p));
    sync();
  });
  const toolbar = el('div', { class: 'pcl-mod-toolbar' }, pclOutline('打开文件夹', () => openLocalFolder('plugins'), { class: 'pcl-outline highlight' }),
    pclOutline('安装插件', promptPluginInstall), pclOutline('下载插件', () => navigate('market')), all);
  const count = el('span', { class: 'pcl-mod-count', 'aria-label': '可见插件数' });
  const filterOptions = [['all', '全部'], ['enabled', '已启用'], ['disabled', '已禁用'], ['conditional', '条件启用']];
  const filters = filterOptions.map(([value, label]) => [value, el('button', { class: 'pcl-mod-filter', 'aria-pressed': 'false',
    onclick: () => { state.pluginFilter = value; sync(); } }, label)]);
  const empty = el('div', { class: 'pcl-mod-empty', hidden: true }, el('h2', {}, plugins.length ? '未找到匹配的插件' : state.plugins.configurationPending ? '尚未生成插件配置' : '尚未安装插件'),
    el('p', {}, plugins.length ? '试试其他关键词，或切换上方的状态筛选。' : state.plugins.configurationPending
      ? '首次启动实例后会生成插件配置。已安装的扩展包可在下方查看和卸载。' : '可以通过插件市场下载，或输入插件包名安装。'));
  const list = el('div', { class: 'pcl-mod-list', 'aria-label': '已安装插件' });
  for (const p of plugins) {
    const status = pluginStatus(p);
    const statusText = { enabled: '已启用', disabled: '已禁用', conditional: '条件启用' }[status];
    const title = p.id ?? p.name;
    const info = [p.name, p.kind === 'group' ? '分组' : null, statusText, pluginHasOverride(p) ? '自定义开关' : '跟随默认'].filter(Boolean).join(' · ');
    const logo = el('span', { class: 'pcl-mod-logo' }, el('img', { src: 'assets/mod-no-icon.png', alt: '', width: 43, height: 43 }),
      status === 'disabled' ? el('img', { class: 'pcl-mod-disabled-icon', src: 'assets/mod-disabled.png', alt: '', width: 25, height: 25 }) : null);
    const select = el('button', { class: 'pcl-mod-select', 'aria-label': '选择插件 ' + title, 'aria-pressed': 'false', disabled: pluginUi.busy,
      onclick: (event) => {
        const key = pluginKey(p);
        const shown = plugins.filter(visible);
        const from = shown.findIndex((item) => pluginKey(item) === pluginUi.anchor);
        const to = shown.indexOf(p);
        if (event.shiftKey && from !== -1) {
          for (const item of shown.slice(Math.min(from, to), Math.max(from, to) + 1)) pluginUi.selected.add(pluginKey(item));
        } else {
          pluginUi.selected.has(key) ? pluginUi.selected.delete(key) : pluginUi.selected.add(key);
        }
        pluginUi.anchor = key;
        sync();
      } }, logo, el('span', { class: 'pcl-mod-text' }, el('span', { class: 'pcl-mod-title' }, title), el('span', { class: 'pcl-mod-info', title: info }, info)));
    const action = (kind, label) => el('button', { class: 'pcl-mod-icon-button', title: label, 'aria-label': label + ' ' + title,
      disabled: pluginUi.busy, onclick: () => changePlugins(profile, [p], kind) }, pluginActionIcon(kind));
    const row = el('div', { class: 'pcl-mod-item ' + status, 'data-plugin-id': title, 'data-status': status }, select,
      el('div', { class: 'pcl-mod-row-actions' },
        status === 'conditional' ? el('span', { class: 'pcl-mod-conditional', title: '该插件由 DSH 条件表达式控制，不能直接切换开关' }, '条件控制')
          : action(status === 'disabled' ? 'enable' : 'disable', status === 'disabled' ? '启用' : '禁用'),
        pluginHasOverride(p) ? action('reset', '恢复默认') : null));
    rows.push({ p, row, select });
    list.append(row);
  }
  const deps = Object.entries(currentProfile()?.deps ?? {});
  const packages = deps.map(([pkg, version]) => el('div', { class: 'pcl-mod-package' },
    el('img', { class: 'pcl-mod-package-icon', src: 'assets/mod-no-icon.png', alt: '', width: 43, height: 43 }),
    el('div', { class: 'pcl-mod-text' }, el('span', { class: 'pcl-mod-title' }, pkg), el('span', { class: 'pcl-mod-info' }, version)),
    el('button', { class: 'pcl-mod-icon-button', title: '卸载扩展包', 'aria-label': '卸载 ' + pkg, disabled: pluginUi.busy,
      onclick: () => openModal('卸载扩展包', [el('p', {}, `从 ${profileTitle(profile)} 卸载 ${pkg}？修改前会自动备份。`),
        pclOutline('确认卸载', async () => {
          try {
            const result = await api(`/profiles/${encodeURIComponent(profile)}/plugins/uninstall`, { method: 'POST', body: { pkg } });
            watchJob(result.jobId, '卸载 ' + pkg, refresh);
          } catch (error) { toast(error.message, 'err'); }
        })]) }, pluginActionIcon('delete'))));
  root.append(el('div', { class: 'pcl-page-stack' },
    el('div', { class: 'pcl-sheet pcl-help-search pcl-mod-search' }, pclIcon('search'), search),
    pclSheet(null, toolbar),
    pclSheet(null, [el('div', { class: 'pcl-mod-filters', 'aria-label': '筛选插件状态' }, ...filters.map(([, button]) => button), count), list, empty]),
    pclSheet(`扩展包 (${deps.length})`, packages.length ? packages : el('p', { class: 'pcl-sheet-note' }, '还没有额外安装的扩展包。'),
      { fold: true, open: Boolean(state.plugins.configurationPending), bodyClass: 'pcl-mod-packages' })), selectionBar);
  if (pluginUi.busy) for (const button of toolbar.querySelectorAll('button')) button.disabled = true;
  sync();
  return root;
}
