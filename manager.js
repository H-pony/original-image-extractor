// 原图批量提取器 - 任务管理界面
(() => {
  const core = globalThis.DownloaderCore;
  const $ = id => document.getElementById(id);
  const STORAGE_TASK = 'task';
  const STORAGE_SITES = 'sites';
  const STATE_VERSION = 4;

  let state = null;          // 当前任务（含 site 快照）
  let sites = [];            // 用户配置的站点列表 [{ hostname, postPathPattern, ... }]
  let editingHostname = null;
  let running = false;
  let stopping = false;
  let controller = null;
  let storageChain = Promise.resolve();
  const maxAutoRetries = 3;
  const minDispatchWindow = 4;
  const initialDispatchWindow = 12;
  const maxDispatchWindow = 24;
  const reconcileWorkers = 8;
  let dispatchWindow = initialDispatchWindow;
  let successCredit = 0;
  const nonRetryableDownloadErrors = new Set([
    'USER_CANCELED', 'USER_SHUTDOWN', 'FILE_NO_SPACE', 'FILE_ACCESS_DENIED',
    'FILE_NAME_TOO_LONG', 'FILE_TOO_LARGE', 'FILE_VIRUS_INFECTED', 'FILE_BLOCKED',
    'FILE_SECURITY_CHECK_FAILED', 'FILE_SAME_AS_SOURCE', 'SERVER_UNAUTHORIZED', 'SERVER_FORBIDDEN'
  ]);
  const congestionDownloadErrors = new Set(['FILE_TRANSIENT_ERROR', 'FILE_FAILED']);
  const labels = { idle: '等待任务', running: '正在处理', paused: '已暂停，可继续', done: '全部完成', errors: '处理结束，部分失败，可重试' };
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

  function log(text) {
    if (!state) return;
    state.logs.unshift(`${new Date().toLocaleTimeString()}  ${text}`);
    state.logs = state.logs.slice(0, 150);
  }

  function render() {
    const items = state?.images || [];
    const complete = items.filter(item => item.status === 'complete').length;
    const failed = items.filter(item => item.status === 'failed').length + (state?.pages.filter(page => page.status === 'failed').length || 0);
    $('status').textContent = labels[state?.status || 'idle'];
    $('pill-state').textContent = labels[state?.status || 'idle'];
    $('current').textContent = state?.current || '-';
    $('post-count').textContent = String(Object.keys(state?.posts || {}).length);
    $('page-count').textContent = String(state?.pages.filter(page => page.status === 'complete').length || 0);
    $('image-count').textContent = String(items.length);
    $('complete-count').textContent = String(complete);
    $('failed-count').textContent = String(failed);
    $('progress').max = Math.max(items.length, 1);
    $('progress').value = complete;
    $('progress-pct').textContent = `${items.length ? Math.floor(complete * 100 / items.length) : 0}%`;
    $('start').disabled = running || Boolean(state);
    $('pause').disabled = !running || stopping;
    $('resume').disabled = running || !state || !state.pages.some(page => page.status === 'pending') && !items.some(item => ['pending', 'downloading'].includes(item.status));
    $('retry').disabled = running || !failed;
    $('reset').disabled = running || !state;
    for (const id of ['url', 'folder']) $(id).disabled = Boolean(state);
    $('logs').replaceChildren(...(state?.logs || []).map(text => {
      const li = document.createElement('li');
      li.textContent = text;
      return li;
    }));
  }

  function save() {
    render();
    const snapshot = state ? structuredClone(state) : null;
    storageChain = storageChain.catch(() => {})
      .then(() => chrome.storage.local.set({ [STORAGE_TASK]: snapshot }));
    return storageChain;
  }

  async function saveSites() {
    await chrome.storage.local.set({ [STORAGE_SITES]: sites });
    renderSites();
  }

  function enqueue(url, kind, post = null) {
    if (!state.pages.some(page => page.url === url)) state.pages.push({ url, kind, post, status: 'pending' });
  }

  function findSiteByHostname(hostname) {
    return sites.find(s => s.hostname === hostname) || null;
  }

  function urlSite(value) {
    try {
      const url = new URL(value);
      return findSiteByHostname(url.hostname);
    } catch { return null; }
  }

  async function ensureOriginPermission(origin) {
    try {
      return await chrome.permissions.contains({ origins: [`https://${origin}/*`] });
    } catch {
      return false;
    }
  }

  async function requestOriginPermission(origin) {
    if (!origin || !/^[a-z0-9.-]+$/i.test(origin)) {
      throw new Error('域名格式无效，请填写形如 example.com 的主机名');
    }
    const granted = await chrome.permissions.request({ origins: [`https://${origin}/*`] });
    if (!granted) throw new Error(`未授予 ${origin} 的访问权限，无法抓取或下载该站点`);
    return true;
  }

  function fillSiteForm(site) {
    const fields = ['hostname', 'postPathPattern', 'searchPathPattern', 'searchQueryParam', 'pathnameTransform',
      'postBodySelector', 'postImageSelector', 'postTitleSelector', 'titleCleanupRegex'];
    for (const f of fields) $(`site-${toInputId(f)}`).value = site[f] || '';
    $('site-cancel-edit').hidden = false;
    editingHostname = site.hostname;
  }

  function clearSiteForm() {
    const ids = ['hostname', 'post-pattern', 'search-pattern', 'search-q', 'transform',
      'body', 'image', 'title', 'title-cleanup'];
    for (const id of ids) $(`site-${id}`).value = '';
    $('site-cancel-edit').hidden = true;
    editingHostname = null;
  }

  function toInputId(name) {
    const map = {
      hostname: 'hostname',
      postPathPattern: 'post-pattern',
      searchPathPattern: 'search-pattern',
      searchQueryParam: 'search-q',
      pathnameTransform: 'transform',
      postBodySelector: 'body',
      postImageSelector: 'image',
      postTitleSelector: 'title',
      titleCleanupRegex: 'title-cleanup',
    };
    return map[name] || name;
  }

  function renderSites() {
    const list = $('site-list');
    list.replaceChildren();
    if (!sites.length) {
      const empty = document.createElement('div');
      empty.className = 'site-item-empty';
      empty.textContent = '尚未配置任何站点；先在上方表单添加一个域名再开始任务。';
      list.append(empty);
      return;
    }
    for (const site of sites) {
      const card = document.createElement('div');
      card.className = 'site-item';
      const badge = document.createElement('span');
      badge.className = 'site-item-badge';
      badge.textContent = (site.hostname[0] || '?').toUpperCase();
      const copy = document.createElement('div');
      copy.className = 'site-item-copy';
      const name = document.createElement('strong');
      name.textContent = site.hostname;
      const meta = document.createElement('small');
      const parts = [];
      if (site.postPathPattern) parts.push(`<code>post</code> ${shorten(site.postPathPattern)}`);
      if (site.searchPathPattern) parts.push(`<code>search</code> ${shorten(site.searchPathPattern)}`);
      if (site.searchQueryParam) parts.push(`<code>?${escapeHTML(site.searchQueryParam)}=…</code>`);
      meta.innerHTML = parts.length ? parts.join(' · ') : '使用智能默认（任何路径都视为单页）';
      copy.append(name, meta);
      const actions = document.createElement('div');
      actions.className = 'site-item-actions';
      const edit = document.createElement('button');
      edit.type = 'button';
      edit.title = '编辑';
      edit.dataset.action = 'edit';
      edit.dataset.host = site.hostname;
      edit.textContent = '✎';
      const del = document.createElement('button');
      del.type = 'button';
      del.title = '删除';
      del.dataset.action = 'delete';
      del.dataset.host = site.hostname;
      del.textContent = '×';
      actions.append(edit, del);
      card.append(badge, copy, actions);
      list.append(card);
    }
  }

  function shorten(value, max = 32) {
    const s = String(value);
    return s.length > max ? `${s.slice(0, max - 1)}…` : s;
  }

  function escapeHTML(value) {
    return String(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  }

  async function readPage(page) {
    controller = new AbortController();
    const timer = setTimeout(() => controller?.abort(), 45000);
    try {
      const response = await fetch(page.url, { credentials: 'include', signal: controller.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const mapped = core.siteLink(response.url, page.url, state.origin);
      if (!mapped) throw new Error('页面跳转到其他域名，无法继续');
      if (page.kind === 'post' ? core.postRoot(mapped, state.site) !== page.post : core.searchKey(mapped, state.site) !== core.searchKey(page.url, state.site)) {
        throw new Error('页面跳转到非目标帖子或登录页');
      }
      const html = await response.text();
      return core.parsePage(html, page.url, page.kind, state.origin, state.site);
    } finally {
      clearTimeout(timer);
      controller = null;
    }
  }

  async function crawl() {
    while (!stopping) {
      const page = state.pages.find(item => item.status === 'pending');
      if (!page) break;
      state.current = `读取页面：${page.url}`;
      await save();
      try {
        const parsed = await readPage(page);
        if (stopping) break;
        for (const url of parsed.pages) enqueue(url, page.kind, page.post);
        if (page.kind === 'search') {
          for (const url of parsed.posts) {
            if (!state.posts[url]) state.posts[url] = { title: '', count: 0 };
            enqueue(url, 'post', url);
          }
        } else {
          const post = state.posts[page.post];
          if (!post.title) post.title = parsed.title;
          for (const url of parsed.images) {
            if (state.images.some(item => item.post === page.post && item.url === url)) continue;
            post.count += 1;
            state.images.push({ url, post: page.post, filename: core.filename(state.folder, post.title, page.post, post.count, url, state.person), status: 'pending', id: null, attempts: 0 });
          }
        }
        page.status = 'complete';
        log(`${page.kind === 'post' ? '正文图片 ' + parsed.images.length + ' 张' : '发现帖子 ' + parsed.posts.length + ' 个'}：${page.url}`);
      } catch (error) {
        if (stopping) break;
        page.status = 'failed';
        page.error = error.message;
        log(`页面失败：${page.url} — ${error.message}`);
      }
      await save();
      await delay(650);
    }
  }

  async function reconcile() {
    const downloading = state.images.filter(image => image.status === 'downloading');
    let next = 0;
    let completed = 0;
    let congestionFailures = 0;

    async function worker() {
      while (next < downloading.length) {
        const item = downloading[next++];
        let download;
        if (item.id !== null) {
          [download] = await chrome.downloads.search({ id: item.id });
        } else {
          const candidates = await chrome.downloads.search({ url: item.url, startedAfter: state.startedAt });
          download = candidates.find(candidate => candidate.filename.replaceAll('\\', '/').endsWith('/' + item.filename));
          if (download) item.id = download.id;
        }
        if (!download) {
          item.status = 'pending';
        } else if (download.state === 'complete') {
          item.status = 'complete';
          completed += 1;
          delete item.error;
          delete item.retryAt;
        } else if (download.state === 'interrupted') {
          if (scheduleDownloadRetry(item, download.error || '下载中断')) congestionFailures += 1;
        }
      }
    }

    await Promise.all(Array.from({ length: Math.min(reconcileWorkers, downloading.length) }, worker));
    return { completed, congestionFailures };
  }

  function retryStagger(item, spread) {
    let hash = item.attempts || 1;
    for (const char of item.filename) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
    return (hash >>> 0) % (spread + 1);
  }

  function applyFlowStats({ completed = 0, congestionFailures = 0 }) {
    if (congestionFailures) {
      const previous = dispatchWindow;
      dispatchWindow = Math.max(minDispatchWindow, Math.floor(dispatchWindow / 2));
      successCredit = 0;
      if (dispatchWindow < previous) {
        log(`检测到 ${congestionFailures} 个文件写入拥塞，已自动降速并错峰重试`);
      }
      return;
    }
    successCredit += completed;
    if (dispatchWindow < maxDispatchWindow && successCredit >= dispatchWindow * 4) {
      dispatchWindow = Math.min(maxDispatchWindow, dispatchWindow + 2);
      successCredit = 0;
      log('浏览器写入已稳定，滚动下载已自动提速');
    }
  }

  function scheduleDownloadRetry(item, error) {
    item.id = null;
    item.error = error;
    if (nonRetryableDownloadErrors.has(error)) {
      item.status = 'failed';
      delete item.retryAt;
      log(`下载失败，此错误不会自动重试：${item.filename} — ${error}`);
      return false;
    }
    const attempts = item.attempts || 1;
    const congested = congestionDownloadErrors.has(error);
    if (attempts <= maxAutoRetries) {
      const base = congested ? 2500 : 1000;
      const spread = congested ? 2000 : 300;
      const wait = Math.min(30000, base * 2 ** (attempts - 1) + retryStagger(item, spread));
      item.status = 'pending';
      item.retryAt = Date.now() + wait;
      const seconds = Math.ceil(wait / 100) / 10;
      log(`下载失败，${seconds} 秒后自动重试（${attempts}/${maxAutoRetries}）：${item.filename} — ${error}`);
    } else {
      item.status = 'failed';
      delete item.retryAt;
      log(`下载失败，已用完 ${maxAutoRetries} 次自动重试：${item.filename} — ${error}`);
    }
    return congested;
  }

  async function downloadAll() {
    while (!stopping) {
      applyFlowStats(await reconcile());
      const now = Date.now();
      const active = state.images.filter(item => item.status === 'downloading').length;
      const capacity = Math.max(0, dispatchWindow - active);
      const pending = state.images
        .filter(item => item.status === 'pending' && (!item.retryAt || item.retryAt <= now))
        .slice(0, capacity);
      if (pending.length) {
        for (const item of pending) {
          item.status = 'downloading';
          item.attempts = (item.attempts || 0) + 1;
          delete item.retryAt;
        }
        const complete = state.images.filter(item => item.status === 'complete').length;
        state.current = `滚动下载：${complete}/${state.images.length}，本次补位 ${pending.length} 张`;
        await save();
        let congestionFailures = 0;
        try {
          const response = await chrome.runtime.sendMessage({
            type: 'download-batch',
            items: pending.map(item => ({ url: item.url, filename: item.filename }))
          });
          if (response?.error || !Array.isArray(response?.results) || response.results.length !== pending.length) {
            throw new Error(response?.error || '下载服务未返回完整结果');
          }
          response.results.forEach((result, index) => {
            const item = pending[index];
            if (result?.id !== undefined) item.id = result.id;
            else if (scheduleDownloadRetry(item, result?.error || '无法启动下载')) congestionFailures += 1;
          });
        } catch (error) {
          for (const item of pending) {
            if (item.id === null && scheduleDownloadRetry(item, error.message)) congestionFailures += 1;
          }
        }
        applyFlowStats({ congestionFailures });
        await save();
      }
      if (!state.images.some(item => ['pending', 'downloading'].includes(item.status))) break;
      const nextRetryAt = Math.min(...state.images
        .filter(item => item.status === 'pending' && item.retryAt)
        .map(item => item.retryAt));
      const wait = Number.isFinite(nextRetryAt)
        ? Math.max(300, Math.min(800, nextRetryAt - Date.now()))
        : 700;
      await delay(wait);
    }
  }

  async function run() {
    if (running || !state) return;
    running = true;
    stopping = false;
    state.status = 'running';
    try {
      await save();
      applyFlowStats(await reconcile());
      await crawl();
      if (!stopping) await downloadAll();
      state.status = stopping ? 'paused' : [...state.pages, ...state.images].some(item => item.status === 'failed') ? 'errors' : 'done';
      state.current = stopping ? '点击继续可恢复；已开始的下载仍由浏览器处理' : '请在浏览器下载列表中查看文件';
      log(labels[state.status]);
    } catch (error) {
      state.status = 'paused';
      log(`任务暂停：${error.message}`);
    } finally {
      running = false;
      stopping = false;
      await save();
    }
  }

  function readSiteForm() {
    const get = id => $(`site-${id}`).value.trim();
    const hostname = get('hostname').toLowerCase();
    if (!hostname) throw new Error('请填写域名');
    const transformValue = get('transform');
    const site = {
      hostname,
      postPathPattern: get('post-pattern') || null,
      searchPathPattern: get('search-pattern') || null,
      searchQueryParam: get('search-q') || null,
      pathnameTransform: transformValue || null,
      postBodySelector: get('body') || null,
      postImageSelector: get('image') || null,
      postTitleSelector: get('title') || null,
      titleCleanupRegex: get('title-cleanup') || null,
    };
    if (!/^[a-z0-9.-]+$/.test(hostname)) throw new Error('域名格式无效，请填写形如 example.com 的主机名');
    // 预编译正则确保有效
    if (site.postPathPattern) core.compile({ ...site });
    return site;
  }

  $('site-form').addEventListener('submit', async event => {
    event.preventDefault();
    try {
      const site = readSiteForm();
      const granted = await ensureOriginPermission(site.hostname);
      if (!granted) await requestOriginPermission(site.hostname);
      if (editingHostname && editingHostname !== site.hostname) {
        sites = sites.filter(s => s.hostname !== editingHostname);
      }
      const idx = sites.findIndex(s => s.hostname === site.hostname);
      if (idx >= 0) sites[idx] = site;
      else sites.push(site);
      await saveSites();
      clearSiteForm();
      $('status').textContent = `已保存站点：${site.hostname}`;
    } catch (error) {
      $('status').textContent = `保存失败：${error.message}`;
    }
  });

  $('site-cancel-edit').addEventListener('click', clearSiteForm);

  $('site-grant').addEventListener('click', async () => {
    try {
      const url = $('url').value.trim();
      if (!url) throw new Error('请先在「页面链接」框粘贴一个 URL');
      const hostname = new URL(url).hostname;
      await requestOriginPermission(hostname);
      $('status').textContent = `已授予 ${hostname} 的访问权限`;
    } catch (error) {
      $('status').textContent = `权限请求失败：${error.message}`;
    }
  });

  $('site-list').addEventListener('click', async event => {
    const button = event.target.closest('button[data-action]');
    if (!button) return;
    const host = button.dataset.host;
    if (button.dataset.action === 'edit') {
      const site = findSiteByHostname(host);
      if (site) fillSiteForm(site);
    } else if (button.dataset.action === 'delete') {
      if (!confirm(`删除站点配置 ${host}？正在运行的任务不受影响。`)) return;
      sites = sites.filter(s => s.hostname !== host);
      await saveSites();
      if (editingHostname === host) clearSiteForm();
    }
  });

  $('task-form').addEventListener('submit', async event => {
    event.preventDefault();
    if (state || running) return;
    try {
      const value = $('url').value.trim();
      let hostname;
      try { hostname = new URL(value).hostname; } catch { throw new Error('URL 格式无效'); }
      let site = urlSite(value);
      if (!site) {
        // 没有配置：自动创建一份空白配置，让用户填写后再开始
        const granted = await ensureOriginPermission(hostname);
        if (!granted) await requestOriginPermission(hostname);
        site = { hostname };
        const idx = sites.findIndex(s => s.hostname === hostname);
        if (idx >= 0) sites[idx] = site;
        else sites.push(site);
        await saveSites();
        fillSiteForm(site);
        $('status').textContent = `域名 ${hostname} 未配置，已自动添加。请填写正则后再次提交任务`;
        return;
      }
      if (!await ensureOriginPermission(hostname)) {
        await requestOriginPermission(hostname);
      }
      const compiled = core.compile(site);
      const input = core.inputURL(value, compiled);
      state = { version: STATE_VERSION, ...input, folder: core.safeName($('folder').value, '下载'), startedAt: new Date().toISOString(), status: 'paused', current: '', posts: {}, pages: [], images: [], logs: [], site: { hostname: site.hostname, ...compiled } };
      if (input.kind === 'post') state.posts[input.url] = { title: '', count: 0 };
      enqueue(input.url, input.kind, input.kind === 'post' ? input.url : null);
      log(input.kind === 'search'
        ? `任务已创建：将按"${state.folder}/${core.safeName(state.person, '未命名人物')}/帖子"分类下载`
        : `任务已创建：将按"${state.folder}/帖子"分类下载`);
      await run();
    } catch (error) {
      $('status').textContent = error.message;
    }
  });

  $('pause').addEventListener('click', () => {
    stopping = true;
    controller?.abort();
    render();
  });
  $('resume').addEventListener('click', run);
  $('retry').addEventListener('click', async () => {
    for (const item of [...state.pages, ...state.images]) {
      if (item.status === 'failed') {
        item.status = 'pending';
        item.id = null;
        item.attempts = 0;
        delete item.error;
        delete item.retryAt;
      }
    }
    log('重试失败页面和图片；成功项不会重复下载');
    await run();
  });
  $('reset').addEventListener('click', async () => {
    if (!confirm('清除任务记录？不会删除已下载文件，也不会取消浏览器中已开始的下载。')) return;
    state = null;
    await save();
  });

  async function migrateState(saved) {
    if (!saved) return null;
    if (saved.version === STATE_VERSION) return saved;
    // 老 state：根据 url.origin 找回 site 配置
    let site = null;
    try { site = urlSite(saved.url); } catch {}
    return { ...saved, version: STATE_VERSION, site: site ? { hostname: site.hostname, ...core.compile(site) } : null };
  }

  async function initialize() {
    const data = await chrome.storage.local.get([STORAGE_TASK, STORAGE_SITES]);
    sites = Array.isArray(data[STORAGE_SITES]) ? data[STORAGE_SITES] : [];
    state = await migrateState(data[STORAGE_TASK]);
    if (state) {
      if (state.status === 'running') state.status = 'paused';
      $('url').value = state.url;
      $('folder').value = state.folder;
      applyFlowStats(await reconcile());
      await save();
    }
    render();
    renderSites();
  }

  for (const id of ['start', 'pause', 'resume', 'retry', 'reset']) $(id).disabled = true;
  navigator.locks.request('downloader-task-manager', { ifAvailable: true }, async lock => {
    if (!lock) {
      $('status').textContent = '另一个下载器标签页已打开，请在原标签页操作';
      return;
    }
    try {
      await initialize();
      await new Promise(() => {});
    } catch (error) {
      $('status').textContent = `初始化失败：${error.message}`;
    }
  });
})();