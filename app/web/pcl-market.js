'use strict';

// PCL PageResource / MyResourceItem: search card and 80px resource rows.
const marketUi = { target: null, sort: 'relevance', status: 'idle', error: '', request: 0 };

function marketTarget() {
  const profiles = state.overview.profiles;
  if (!profiles.some((p) => p.name === marketUi.target)) {
    marketUi.target = profiles.some((p) => p.name === state.currentProfile) ? state.currentProfile : profiles[0]?.name ?? null;
  }
  return marketUi.target;
}

async function doSearch(q) {
  const request = ++marketUi.request;
  const query = String(q ?? '').trim() || 'dsh';
  state.marketQuery = query;
  marketUi.status = 'loading';
  marketUi.error = '';
  if (state.page === 'market') await render();
  try {
    const result = await api('/market?q=' + encodeURIComponent(query));
    if (request !== marketUi.request) return;
    state.market = result;
    marketUi.status = 'ready';
  } catch (error) {
    if (request !== marketUi.request) return;
    state.market = null;
    marketUi.status = 'error';
    marketUi.error = error.message;
  }
  if (state.page === 'market') await render();
}

function resetMarketSearch() {
  marketUi.request++;
  marketUi.status = 'idle';
  marketUi.error = '';
  marketUi.sort = 'relevance';
  marketUi.target = state.currentProfile;
  state.market = null;
  state.marketQuery = '';
  render();
}

function marketMetaIcon(kind) {
  const paths = {
    version: '<path d="m7 3-5 9 5 9h10l5-9-5-9z"/><circle cx="12" cy="12" r="3"/>',
    author: '<circle cx="12" cy="7" r="4"/><path d="M4 22v-3a8 8 0 0 1 16 0v3"/>',
    date: '<path d="M5 4h14v17H5zM8 2v4m8-4v4M5 9h14M8 13h3m2 0h3m-8 4h3"/>',
    source: '<circle cx="12" cy="12" r="10"/><ellipse cx="12" cy="12" rx="4" ry="10"/><path d="M2 12h20"/>',
  };
  return el('span', { class: 'pcl-market-meta-icon', html: `<svg viewBox="0 0 24 24" aria-hidden="true">${paths[kind]}</svg>` });
}

function openMarketItem(item, profile) {
  const actions = [pclOutline('安装插件', () => installPlugin(item.name, profile), { class: 'pcl-outline highlight', disabled: !profile })];
  let npmUrl;
  try {
    const candidate = new URL(item.links?.npm || 'https://www.npmjs.com/package/' + item.name);
    if (['https:', 'http:'].includes(candidate.protocol)) npmUrl = candidate.href;
  } catch { /* Invalid registry link: omit the external link. */ }
  if (npmUrl) actions.push(pclOutline('转到 npm', () => window.open(npmUrl, '_blank', 'noopener')));
  actions.push(pclOutline('复制名称', () => copyText(item.name)));
  openModal('插件详情', [
    el('div', { class: 'pcl-market-detail' },
      el('img', { src: 'assets/mod-no-icon.png', width: 63, height: 63, alt: '' }),
      el('div', {}, el('h2', {}, item.name), el('p', {}, item.version ? `版本 ${item.version}` : '未提供版本信息'))),
    el('p', { class: 'pcl-market-detail-description' }, item.description || '暂无插件简介。'),
    el('p', { class: 'pcl-market-detail-info' }, `作者：${item.author || '未提供'}${item.date ? '　更新于 ' + String(item.date).slice(0, 10) : ''}`),
    el('p', { class: 'pcl-market-detail-info' }, profile ? `安装到：${profileTitle(profile)}` : '请先创建一个 DSH 实例。'),
    el('div', { class: 'pcl-market-detail-actions' }, ...actions),
  ]);
}

function pclMarketPage() {
  const target = marketTarget();
  const profiles = state.overview.profiles;
  let source = state.overview.config.registry;
  try { source = new URL(source).hostname; } catch { source = source || 'npm'; }
  const name = el('input', { class: 'pcl-input', type: 'search', 'aria-label': '插件名称', value: state.marketQuery,
    placeholder: '名称或关键词，例如 dsh-pet', oninput: (event) => { state.marketQuery = event.target.value; },
    onkeydown: (event) => { if (event.key === 'Enter') { event.preventDefault(); doSearch(event.target.value); } } });
  const targetSelect = pclSelect('安装到实例', target ?? '', profiles.map((p) => [p.name, profileTitle(p.name)]), (value) => { marketUi.target = value; render(); });
  targetSelect.disabled = !profiles.length;
  const search = pclOutline(marketUi.status === 'loading' ? '搜索中…' : '搜索', () => doSearch(name.value),
    { class: 'pcl-outline highlight', disabled: marketUi.status === 'loading' });
  const field = (label, control) => el('label', { class: 'pcl-market-field' }, el('span', {}, label), control);
  const form = el('div', { class: 'pcl-market-search-form' },
    el('div', { class: 'pcl-market-fields' },
      field('名称', name),
      field('来源', el('input', { class: 'pcl-input', value: source, readonly: true, 'aria-label': '插件来源', title: state.overview.config.registry })),
      field('安装到', targetSelect),
      field('排序', pclSelect('插件排序', marketUi.sort, [['relevance', '默认排序'], ['updated', '最近更新'], ['name', '名称']], (value) => { marketUi.sort = value; render(); }))),
    el('div', { class: 'pcl-market-search-actions' }, search, pclOutline('重置条件', resetMarketSearch),
      pclOutline('已安装插件', () => { state.currentProfile = marketTarget(); state.plugins = null; navigate('plugins'); }, { disabled: !target })));
  const results = el('div', { class: 'pcl-market-results', 'aria-live': 'polite' });
  if (marketUi.status === 'loading') {
    results.append(pclSheet(null, el('div', { class: 'pcl-market-message', role: 'status' }, el('span', { class: 'pcl-market-spinner', 'aria-hidden': 'true' }),
      el('h2', {}, '正在获取插件列表'), el('p', {}, `正在搜索「${state.marketQuery}」…`))));
  } else if (marketUi.status === 'error') {
    results.append(pclSheet(null, el('div', { class: 'pcl-market-message', role: 'alert' }, el('h2', {}, '搜索失败'),
      el('p', {}, marketUi.error), pclOutline('重试', () => doSearch(state.marketQuery)))));
  } else if (!state.market) {
    results.append(pclSheet(null, el('div', { class: 'pcl-market-message' }, el('h2', {}, '搜索插件'),
      el('p', {}, '输入名称或关键词，查找可安装的 DSH 插件。'))));
  } else if (!state.market.items.length) {
    results.append(pclSheet(null, el('div', { class: 'pcl-market-message' }, el('h2', {}, '没有找到插件'),
      el('p', {}, `没有找到与「${state.market.query || state.marketQuery}」匹配的包，请调整关键词。`))));
  } else {
    const items = [...state.market.items];
    if (marketUi.sort === 'updated') items.sort((a, b) => String(b.date ?? '').localeCompare(String(a.date ?? '')));
    if (marketUi.sort === 'name') items.sort((a, b) => a.name.localeCompare(b.name));
    results.append(pclSheet(null, el('div', { class: 'pcl-market-list', 'aria-label': '插件搜索结果' },
      ...items.map((item) => el('button', { class: 'pcl-market-item', 'data-package': item.name, onclick: () => openMarketItem(item, target) },
        el('img', { class: 'pcl-market-icon', src: 'assets/mod-no-icon.png', alt: '', width: 63, height: 63 }),
        el('span', { class: 'pcl-market-item-text' }, el('span', { class: 'pcl-market-title', title: item.name }, item.name),
          el('span', { class: 'pcl-market-description', title: item.description }, item.description || '暂无插件简介'),
          el('span', { class: 'pcl-market-metadata' },
            el('span', { title: '最新版本' }, marketMetaIcon('version'), item.version || '未知版本'),
            el('span', { title: '作者' }, marketMetaIcon('author'), item.author || '未提供作者'),
            item.date ? el('span', { title: '更新时间' }, marketMetaIcon('date'), String(item.date).slice(0, 10)) : null,
            el('span', {}, marketMetaIcon('source'), 'npm'))),
        pclIcon('chevron', 'pcl-market-item-arrow'))))),
      el('p', { class: 'pcl-market-result-count' }, `共 ${items.length} 个搜索结果`));
  }
  return el('div', { class: 'pcl-page-stack pcl-market-page' }, pclSheet('搜索插件', form), results);
}
