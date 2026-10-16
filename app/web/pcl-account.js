'use strict';

const accountUi = { data: null, error: '', fetching: false, busy: false, dialog: 0, openOnReady: false, home: null };
const accountPhase = () => accountUi.data?.attempt?.phase;
const activeAccountAttempt = () => ['initializing', 'waiting-browser', 'exchanging', 'committing'].includes(accountPhase());
const accountMetadata = () => ({ locale: navigator.language || 'zh-CN', timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60 });
function accountAvatarUrl(profile) {
  try { const url = new URL(profile?.avatarUrl); if (url.protocol === 'https:') return url.href; } catch { }
  return 'assets/account-guest.svg';
}
function accountPhaseText() {
  return { initializing: '正在准备登录…', 'waiting-browser': '等待浏览器授权', exchanging: '正在完成登录…', committing: '正在保存登录状态…',
    failed: '登录未完成，请重试', expired: '登录已超时，请重试', cancelled: '已取消本次登录' }[accountPhase()] || '';
}

function renderAccount() {
  const home = state.overview?.dshHome;
  if (home && home !== accountUi.home) {
    accountUi.home = home; accountUi.data = null; accountUi.error = ''; accountUi.openOnReady = false;
  }
  const stored = accountUi.data?.status === 'credential-stored';
  const desktopMissing = accountUi.data?.status === 'desktop-missing';
  const profile = stored && accountUi.data.profile?.status === 'ready' ? accountUi.data.profile.value : null;
  $('#accountTypeLabel').textContent = 'DeepSeek 登录';
  $('#accountName').textContent = stored ? (profile?.name || 'DeepSeek 账号') : desktopMissing ? '未找到 DSH' : activeAccountAttempt() ? '正在登录' : accountUi.error ? '账号读取失败' : accountUi.data ? '未登录' : '读取账号…';
  $('#accountSubtitle').textContent = stored ? (profile?.contact || '已保存本机登录状态') : desktopMissing ? '安装并设置 DSH 后即可登录' : activeAccountAttempt() ? accountPhaseText() : accountUi.error ? '点击重试' : '点击登录 DeepSeek';
  $('#accountAvatar').setAttribute('src', accountAvatarUrl(profile));
  $('#accountCard').setAttribute('aria-label', stored ? '管理 DeepSeek 账号' : '登录 DeepSeek');
  $('#accountCard').setAttribute('aria-busy', String(accountUi.busy || accountUi.fetching));
}

function maybeOpenAccountBrowser() {
  const attempt = accountUi.data?.attempt;
  if (accountUi.openOnReady && attempt?.phase === 'waiting-browser' && attempt.authorizeUrl) {
    accountUi.openOnReady = false;
    window.open(attempt.authorizeUrl, '_blank', 'noopener');
  }
  if (['failed', 'cancelled', 'expired', 'succeeded'].includes(attempt?.phase)) accountUi.openOnReady = false;
}

async function refreshAccount(force = false) {
  if (!state.overview) return;
  renderAccount();
  if (accountUi.fetching || accountUi.busy) return;
  const home = state.overview.dshHome;
  if (home !== accountUi.home) { accountUi.home = home; accountUi.data = null; accountUi.error = ''; renderAccount(); }
  accountUi.fetching = true;
  const previous = JSON.stringify([accountUi.data, accountUi.error]);
  try {
    const value = await api('/account' + (force ? '?refresh=1' : ''));
    if (state.overview.dshHome !== home) return;
    accountUi.data = value;
    accountUi.error = '';
    maybeOpenAccountBrowser();
  } catch (error) {
    if (state.overview.dshHome !== home) return;
    accountUi.error = error.message;
  } finally {
    accountUi.fetching = false;
    renderAccount();
    if (previous !== JSON.stringify([accountUi.data, accountUi.error]) && accountUi.dialog === modalGeneration && !$('#modal').hidden) showAccountDialog();
  }
}

async function accountCommand(action, body = {}) {
  if (accountUi.busy) return;
  if (accountUi.home !== state.overview?.dshHome || !accountUi.data) { void refreshAccount(true); return; }
  const home = accountUi.home;
  accountUi.busy = true;
  accountUi.error = '';
  if (action === 'login') accountUi.openOnReady = true;
  renderAccount();
  showAccountDialog();
  try {
    const result = await api('/account/' + action, { method: 'POST', body: { ...accountMetadata(), ...body, home } });
    if (state.overview.dshHome !== home) return;
    accountUi.data = result;
    maybeOpenAccountBrowser();
    if (action === 'logout') toast('已退出本机 DeepSeek 账号', 'ok');
    if (action === 'cancel') toast('已取消本次登录');
  } catch (error) { accountUi.error = error.message; accountUi.openOnReady = false; toast(error.message, 'err'); }
  finally {
    accountUi.busy = false;
    renderAccount();
    if (accountUi.dialog === modalGeneration && !$('#modal').hidden) showAccountDialog();
  }
}

function showAccountDialog() {
  const data = accountUi.data;
  const stored = data?.status === 'credential-stored';
  const profile = stored && data.profile?.status === 'ready' ? data.profile.value : null;
  const body = [];
  const actions = [];
  if (accountUi.busy) body.push(el('p', { class: 'pcl-account-dialog-note' }, '正在处理账号请求…'));
  else if (stored) {
    body.push(el('div', { class: 'pcl-account-dialog-profile' }, el('img', { src: accountAvatarUrl(profile), alt: '', width: 70, height: 70, referrerpolicy: 'no-referrer' }),
      el('div', {}, el('strong', {}, profile?.name || 'DeepSeek 账号'), el('span', {}, profile?.contact || '本机登录已保存'))));
    if (data.profile?.status !== 'ready') body.push(el('p', { class: 'pcl-account-dialog-note' }, '账号资料暂时无法读取，可以稍后刷新。'));
    actions.push(pclOutline('刷新资料', () => refreshAccount(true)), pclOutline('退出登录', () => {
      openModal('退出 DeepSeek 账号', [el('p', {}, '退出当前本机 DeepSeek 账号？DSH 本体也会退出该账号，已配置的 API Key 会保留。'),
        pclOutline('确认退出', () => accountCommand('logout'))], { warning: true });
    }));
  } else if (data?.status === 'desktop-missing') {
    body.push(el('p', { class: 'pcl-account-dialog-note' }, '请先安装或选择 DSH 桌面程序，随后即可沿用 DSH 本体登录。'));
    actions.push(el('a', { class: 'pcl-outline pcl-credit-link', href: 'https://www.deepseek.com/download/', target: '_blank', rel: 'noopener noreferrer' }, '官方下载 DSH'), pclOutline('选择 DSH 程序', () => { closeModal(); selectDesktopProgram(); }));
  } else if (activeAccountAttempt()) {
    body.push(el('p', { class: 'pcl-account-dialog-status' }, accountPhaseText()),
      el('p', { class: 'pcl-account-dialog-note' }, '请在系统浏览器中完成 DeepSeek 授权，完成后这里会自动更新。'));
    if (data.attempt.authorizeUrl) actions.push(pclOutline('打开登录页面', () => window.open(data.attempt.authorizeUrl, '_blank', 'noopener'), { class: 'pcl-outline highlight' }));
    actions.push(pclOutline('取消本次登录', () => accountCommand('cancel', { attemptId: data.attempt.id })));
  } else if (!data) {
    body.push(el('p', { class: 'pcl-account-dialog-note' }, accountUi.error || '正在读取本机 DSH 账号状态…'));
    actions.push(pclOutline('重新读取', () => refreshAccount(true)));
  } else {
    body.push(el('p', { class: 'pcl-account-dialog-note' }, '使用 DSH 本体的 DeepSeek 账号登录。点击下方按钮，在系统浏览器中完成授权。'));
    if (['failed', 'expired'].includes(accountPhase())) body.push(el('p', { class: 'pcl-account-dialog-error' }, accountPhaseText()));
    actions.push(pclOutline('在浏览器中登录', () => accountCommand('login'), { class: 'pcl-outline highlight' }));
  }
  if (accountUi.error && data) body.push(el('p', { class: 'pcl-account-dialog-error' }, accountUi.error));
  if (actions.length) body.push(el('div', { class: 'pcl-account-dialog-actions' }, ...actions));
  openModal(stored ? 'DeepSeek 账号' : '登录 DeepSeek', body);
  accountUi.dialog = modalGeneration;
}

function openAccountDialog() {
  showAccountDialog();
  void refreshAccount(true);
}

function initializeAccount() {
  $('#accountEdit').addEventListener('click', openAccountDialog);
  $('#accountCard').addEventListener('click', openAccountDialog);
  $('#accountAvatar').addEventListener('error', () => { if ($('#accountAvatar').getAttribute('src') !== 'assets/account-guest.svg') $('#accountAvatar').setAttribute('src', 'assets/account-guest.svg'); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void refreshAccount(true); });
  setInterval(() => { if (!document.hidden && (state.page === 'home' || activeAccountAttempt() || accountUi.dialog === modalGeneration && !$('#modal').hidden)) void refreshAccount(); }, 5000);
}
