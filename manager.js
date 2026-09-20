(() => {
  const core = globalThis.DownloaderCore;
  const $ = id => document.getElementById(id);
  let state = null;
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
    const snapshot = structuredClone(state);
    storageChain = storageChain.catch(() => {}).then(() => chrome.storage.local.set({ task: snapshot }));
    return storageChain;
  }

  function enqueue(url, kind, post = null) {
    if (!state.pages.some(page => page.url === url)) state.pages.push({ url, kind, post, status: 'pending' });
  }

  async function readPage(page) {
    controller = new AbortController();
    const timer = setTimeout(() => controller?.abort(), 45000);
    try {
      const response = await fetch(page.url, { credentials: 'include', signal: controller.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const mapped = core.siteLink(response.url, page.url, state.origin);
      if (!mapped || (page.kind === 'post' ? core.postRoot(mapped) !== page.post : core.searchKey(mapped) !== core.searchKey(page.url))) {
        throw new Error('页面跳转到非目标帖子或登录页');
      }
      const html = await response.text();
      return core.parsePage(html, page.url, page.kind, state.origin);
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

  $('task-form').addEventListener('submit', async event => {
    event.preventDefault();
    if (state || running) return;
    try {
      const input = core.inputURL($('url').value);
      state = { version: 3, ...input, folder: core.safeName($('folder').value, '4KHD'), startedAt: new Date().toISOString(), status: 'paused', current: '', posts: {}, pages: [], images: [], logs: [] };
      if (input.kind === 'post') state.posts[input.url] = { title: '', count: 0 };
      enqueue(input.url, input.kind, input.kind === 'post' ? input.url : null);
      log(input.kind === 'search'
        ? `任务已创建：将按“${state.folder}/${core.safeName(state.person, '未命名人物')}/帖子”分类下载`
        : `任务已创建：将按“${state.folder}/帖子”分类下载`);
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

  async function initialize() {
    const saved = await chrome.storage.local.get('task');
    state = saved.task || null;
    if (state) {
      if (state.status === 'running') state.status = 'paused';
      $('url').value = state.url;
      $('folder').value = state.folder;
      applyFlowStats(await reconcile());
      state.version = 3;
      await save();
    }
    render();
  }

  for (const id of ['start', 'pause', 'resume', 'retry', 'reset']) $(id).disabled = true;
  navigator.locks.request('4khd-task-manager', { ifAvailable: true }, async lock => {
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