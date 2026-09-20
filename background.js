chrome.action.onClicked.addListener(async () => {
  const url = chrome.runtime.getURL('manager.html');
  const tabs = await chrome.tabs.query({});
  const existing = tabs.find(tab => tab.url === url);
  if (existing) {
    await chrome.tabs.update(existing.id, { active: true });
    await chrome.windows.update(existing.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url });
  }
});

const queuedFilenames = new Map();

function queueFilename(url, filename) {
  const queue = queuedFilenames.get(url) || [];
  queue.push(filename);
  queuedFilenames.set(url, queue);
}

function takeFilename(url) {
  const queue = queuedFilenames.get(url);
  if (!queue?.length) return null;
  const filename = queue.shift();
  if (!queue.length) queuedFilenames.delete(url);
  return filename;
}

function discardFilename(url, filename) {
  const queue = queuedFilenames.get(url);
  if (!queue?.length) return;
  const index = queue.indexOf(filename);
  if (index !== -1) queue.splice(index, 1);
  if (!queue.length) queuedFilenames.delete(url);
}

chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  if (item.byExtensionId && item.byExtensionId !== chrome.runtime.id) {
    suggest();
    return;
  }
  const filename = takeFilename(item.url) || takeFilename(item.finalUrl);
  if (filename) suggest({ filename, conflictAction: 'uniquify' });
  else suggest();
});

async function startDownload(item) {
  if (!item || typeof item.url !== 'string' || typeof item.filename !== 'string' || !item.filename) {
    return { error: '下载参数无效' };
  }
  queueFilename(item.url, item.filename);
  try {
    const id = await chrome.downloads.download({
      url: item.url,
      conflictAction: 'uniquify',
      saveAs: false
    });
    return { id };
  } catch (error) {
    discardFilename(item.url, item.filename);
    return { error: error?.message || String(error) };
  }
}

async function startBatch(items) {
  const results = new Array(items.length);
  const groups = new Map();
  items.forEach((item, index) => {
    const group = groups.get(item?.url) || [];
    group.push({ item, index });
    groups.set(item?.url, group);
  });
  await Promise.all([...groups.values()].map(async group => {
    for (const { item, index } of group) results[index] = await startDownload(item);
  }));
  return results;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'download-batch' || !Array.isArray(message.items)) return;
  startBatch(message.items)
    .then(results => sendResponse({ results }))
    .catch(error => sendResponse({ error: error?.message || String(error) }));
  return true;
});