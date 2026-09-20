// 原图批量提取器 - 核心解析库
// 接口：globalThis.DownloaderCore
// 输入 URL/HTML，输出结构化数据。所有站点差异通过 SiteConfig 传入。
(() => {
  const PROTOCOLS = ['https:', 'http:'];
  const IMAGE_EXT = /\.(?:jpe?g|png|webp|gif|avif)(?:$)/i;
  const IMAGE_DENY = /(?:spacer|transparent|placeholder|loading|gravatar|favicon)/i;

  // 智能默认：未配置字段的兜底值
  const DEFAULTS = {
    postPathPattern: null,
    searchPathPattern: null,
    searchQueryParam: null,
    pathnameTransform: null,
    postBodySelector: 'article, main, [role="main"], .post, .entry-content, .post-content, .article-content',
    postImageSelector: 'img',
    postTitleSelector: 'h1, .post-title, .entry-title, .article-title, main h1',
    searchBodyIndicator: null,
    searchPostLinkSelector: 'a[href]',
    searchPageLinkSelector: 'a[href][rel="next"], .pagination a[href], .nav-links a[href], link[rel="next"]',
    postPageLinkSelector: 'link[rel="next"], link[rel="prev"], .pagination a[href], .page-links a[href]',
    titleCleanupRegex: null,
    minImageSize: 180,
  };

  // 默认排除选择器（帖子正文内的非正文图）
  const DEFAULT_EXCLUDED =
    '.wp-block-query, .wp-block-post-template, .related, .related-posts, #basicE, aside, header, footer, ' +
    '.advertisement, .ads, .adsbygoogle, .heateor_sss_sharing_container, .comments, .comment, ' +
    'nav, .nav, .sidebar, .widget, .share, .social, .breadcrumb';

  // 用户提供的 site 配置 + 默认值合并，并编译正则
  function compile(rawSite) {
    const site = { ...DEFAULTS, ...(rawSite || {}) };
    const compiled = { ...site };
    compiled._postPattern = site.postPathPattern ? safeRegex(site.postPathPattern) : null;
    compiled._searchPattern = site.searchPathPattern ? safeRegex(site.searchPathPattern) : null;
    compiled._titleCleanup = site.titleCleanupRegex ? safeRegex(site.titleCleanupRegex) : null;
    return compiled;
  }

  function safeRegex(pattern) {
    try {
      return new RegExp(pattern, 'i');
    } catch {
      return null;
    }
  }

  // 校验 URL：白名单 + HTTPS（允许 http 兜底）+ 无用户名/端口
  function cleanURL(value, base, site) {
    if (!site) throw new Error('当前域名未配置，请先在「域名配置」中添加规则');
    const url = new URL(value, base);
    if (!PROTOCOLS.includes(url.protocol) || url.username || url.password) {
      throw new Error('仅支持 HTTP/HTTPS，且地址不能包含凭据');
    }
    if (url.port) {
      throw new Error('不支持非标准端口的地址');
    }
    if (url.hostname !== site.hostname) {
      throw new Error(`当前域名 ${url.hostname} 与站点配置 ${site.hostname} 不一致`);
    }
    url.hash = '';
    return url;
  }

  // 把 URL 规约到帖子根路径（去掉 ?page=N、尾斜杠、.html/N）
  function postRoot(value, site) {
    const url = cleanURL(value, undefined, site);
    const pattern = site._postPattern;
    if (pattern && !pattern.test(url.pathname)) return null;
    switch (site.pathnameTransform) {
      case 'html-suffix':
        url.pathname = url.pathname.replace(/(\.html)(?:\/\d+)?\/?$/i, '$1');
        break;
      case 'page':
        url.pathname = `${url.pathname.replace(/\/+$/, '')}/`;
        break;
      case 'strip-slash':
        url.pathname = url.pathname.replace(/\/+$/, '') || '/';
        break;
      default:
        // 未配置 transform：原样保留
        break;
    }
    url.search = '';
    return url.href;
  }

  // 从搜索页 URL 提取搜索关键词
  function searchKey(value, site) {
    const url = cleanURL(value, undefined, site);
    const pattern = site._searchPattern;
    if (pattern) {
      const match = url.pathname.match(pattern);
      if (match) return decodeURIComponent(match[1] || '');
    }
    if (site.searchQueryParam && url.searchParams.get(site.searchQueryParam)) {
      return url.searchParams.get(site.searchQueryParam);
    }
    return null;
  }

  // 把 URL 归类成 {kind, url, origin, person?}
  function inputURL(value, site) {
    const url = cleanURL(value.trim(), undefined, site);
    const post = postRoot(url.href, site);
    if (post) return { url: post, kind: 'post', origin: url.origin };
    const key = searchKey(url.href, site);
    if (key) {
      url.pathname = site._searchPattern
        ? url.pathname.replace(/\/page\/\d+\/?$/i, '').replace(/\/+$/, '/')
        : url.pathname;
      url.search = site.searchQueryParam ? `?${site.searchQueryParam}=${encodeURIComponent(key)}` : '';
      return { url: url.href, kind: 'search', origin: url.origin, person: key.trim() || '未命名人物' };
    }
    // 既不是帖子页也不是搜索页：整页当作单页 post 处理（无分页）
    url.search = '';
    return { url: url.href, kind: 'post', origin: url.origin };
  }

  // 把站内相对/绝对链接归一为基于 origin 的绝对 URL（跨域跳转会被丢弃）
  function siteLink(value, base, origin) {
    if (!value) return null;
    try {
      const url = new URL(value, base);
      if (!PROTOCOLS.includes(url.protocol) || url.username || url.password) return null;
      const baseURL = new URL(base);
      if (url.origin !== baseURL.origin) return null;
      url.hash = '';
      return url.href;
    } catch {
      return null;
    }
  }

  // 规范化图片 URL：协议/扩展名/黑名单过滤
  function imageURL(value, base) {
    if (!value) return null;
    try {
      const url = new URL(value, base);
      if (!PROTOCOLS.includes(url.protocol) || url.username || url.password) return null;
      if (!IMAGE_EXT.test(url.pathname)) return null;
      if (IMAGE_DENY.test(url.pathname)) return null;
      url.hash = '';
      return url.href;
    } catch {
      return null;
    }
  }

  // srcset 选最大图：格式 "url 1x, url2 2x" 或 "url 600w, url2 1200w"
  function largestSource(value, base) {
    return (value || '').split(',').map(part => {
      const [url, size] = part.trim().split(/\s+/);
      return { url: imageURL(url, base), size: Number.parseFloat(size) || 1 };
    }).filter(item => item.url).sort((a, b) => b.size - a.size)[0]?.url;
  }

  // 解析搜索/帖子页 HTML
  function parsePage(html, pageURL, kind, origin, site) {
    const compiled = compile(site);
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const links = selector => [...doc.querySelectorAll(selector)]
      .map(node => siteLink(node.getAttribute('href'), pageURL, origin)).filter(Boolean);

    if (kind === 'search') {
      const indicator = compiled.searchBodyIndicator;
      if (indicator && !doc.querySelector(indicator)) {
        throw new Error('未识别到搜索结果，可能需要先在浏览器登录或完成验证');
      }
      const key = searchKey(pageURL, compiled);
      const posts = [...new Set(links(compiled.searchPostLinkSelector)
        .map(url => postRoot(url, compiled)).filter(Boolean))];
      const pages = [...new Set(links(compiled.searchPageLinkSelector)
        .filter(url => key && searchKey(url, compiled) === key))];
      if (!posts.length) {
        throw new Error('搜索结果结构发生变化：没有找到帖子链接');
      }
      return { posts, pages, images: [], title: doc.title };
    }

    const body = doc.querySelector(compiled.postBodySelector);
    if (!body) throw new Error('未找到帖子正文，可能需要先在浏览器登录或完成验证');
    const root = postRoot(pageURL, compiled);
    const minSize = Number(compiled.minImageSize) || 0;
    const images = [...body.querySelectorAll(compiled.postImageSelector)].filter(img => {
      if (img.closest(DEFAULT_EXCLUDED) || img.matches('.emoji, .wp-smiley, .avatar, .wp-post-image, .icon, .logo')) return false;
      const width = Number(img.getAttribute('width'));
      const height = Number(img.getAttribute('height'));
      return !(width > 0 && width < minSize) && !(height > 0 && height < minSize);
    }).map(img => {
      const anchor = img.closest('a[href]');
      return imageURL(img.getAttribute('data-original'), pageURL)
        || imageURL(img.getAttribute('data-full-url'), pageURL)
        || imageURL(anchor?.getAttribute('href'), pageURL)
        || largestSource(img.getAttribute('data-srcset') || img.getAttribute('srcset'), pageURL)
        || imageURL(img.getAttribute('data-lazy-src'), pageURL)
        || imageURL(img.getAttribute('data-src'), pageURL)
        || imageURL(img.getAttribute('src'), pageURL);
    }).filter(Boolean);
    if (!images.length) throw new Error('正文中没有识别到图片；未下载任何侧栏或推荐图片');
    const pages = root ? [...new Set(links(compiled.postPageLinkSelector)
      .filter(url => postRoot(url, compiled) === root))] : [];
    const rawTitle = doc.querySelector(compiled.postTitleSelector)?.textContent?.trim() || doc.title;
    const title = compiled._titleCleanup ? rawTitle.replace(compiled._titleCleanup, '').trim() : rawTitle;
    return { title, images: [...new Set(images)], pages, posts: [] };
  }

  function safeName(value, fallback = '未命名帖子') {
    const name = String(value).normalize('NFKC').replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '_')
      .replace(/\s+/g, ' ').replace(/^[.\s]+|[.\s]+$/g, '').slice(0, 80).replace(/[.\s]+$/g, '');
    if (!name) return fallback;
    return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name) ? `_${name}` : name;
  }

  function shortHash(value) {
    let result = 2166136261;
    for (const char of value) result = Math.imul(result ^ char.charCodeAt(0), 16777619);
    return (result >>> 0).toString(16).padStart(8, '0');
  }

  function filename(folder, title, post, index, url, person = '') {
    const extension = new URL(url).pathname.match(/\.(jpe?g|png|webp|gif|avif)$/i)?.[1].toLowerCase() || 'jpg';
    const folders = [safeName(folder, '下载')];
    if (person) folders.push(safeName(person, '未命名人物'));
    folders.push(`${safeName(title)}_${shortHash(post)}`);
    return `${folders.join('/')}/${String(index).padStart(4, '0')}.${extension}`;
  }

  function matchSite(value, sites) {
    if (!Array.isArray(sites)) return null;
    let url;
    try { url = new URL(value); } catch { return null; }
    return sites.find(s => s && s.hostname === url.hostname) || null;
  }

  globalThis.DownloaderCore = {
    DEFAULTS,
    compile,
    matchSite,
    cleanURL,
    postRoot,
    searchKey,
    inputURL,
    siteLink,
    imageURL,
    largestSource,
    parsePage,
    safeName,
    shortHash,
    filename,
  };
})();