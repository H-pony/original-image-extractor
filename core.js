(() => {
  const hosts = new Set(['hecoq.uuss.uk', 'www.4khd.com', '4khd.com', 'mtldss.top', 'www.mtldss.top']);
  const postPattern = /^\/content\/[^/]+\/[^/]+\.html(?:\/\d+)?\/?$/i;
  const mtldssPostPattern = /^\/index\.php\/\d{4}\/\d{2}\/\d{2}\/[^/]+\/?$/i;

  function isMtldss(url) {
    return url.hostname === 'mtldss.top' || url.hostname === 'www.mtldss.top';
  }

  function cleanURL(value, base) {
    const url = new URL(value, base);
    if (url.protocol !== 'https:' || !hosts.has(url.hostname) || url.port || url.username || url.password) {
      throw new Error('仅支持 hecoq.uuss.uk、4khd.com 或 mtldss.top 的 HTTPS 地址');
    }
    url.hash = '';
    return url;
  }

  function postRoot(value) {
    const url = cleanURL(value);
    if (isMtldss(url)) {
      if (!mtldssPostPattern.test(url.pathname)) return null;
      url.pathname = `${url.pathname.replace(/\/+$/, '')}/`;
    } else {
      if (!postPattern.test(url.pathname)) return null;
      url.pathname = url.pathname.replace(/(\.html)(?:\/\d+)?\/?$/i, '$1');
    }
    url.search = '';
    return url.href;
  }

  function searchKey(value) {
    const url = cleanURL(value);
    if (isMtldss(url)) {
      const match = url.pathname.match(/^\/index\.php\/tag\/([^/]+)(?:\/page\/\d+)?\/?$/i);
      return match ? decodeURIComponent(match[1]) : null;
    }
    const match = url.pathname.match(/^\/search\/([^/]+)(?:\/page\/\d+)?\/?$/);
    if (match) return decodeURIComponent(match[1]);
    if (/^\/(?:page\/\d+\/?)?$/.test(url.pathname) && url.searchParams.get('s')) return url.searchParams.get('s');
    return null;
  }

  function inputURL(value) {
    const url = cleanURL(value.trim());
    const post = postRoot(url.href);
    if (post) return { url: post, kind: 'post', origin: url.origin };
    const key = searchKey(url.href);
    if (key) {
      url.pathname = isMtldss(url)
        ? `/index.php/tag/${encodeURIComponent(key)}/`
        : `/search/${encodeURIComponent(key)}`;
      url.search = '';
      return { url: url.href, kind: 'search', origin: url.origin, person: key.trim() || '未命名人物' };
    }
    throw new Error('请输入 4KHD 帖子/搜索地址，或 mtldss 帖子/标签地址');
  }

  function siteLink(value, base, origin) {
    try {
      const url = cleanURL(value, base);
      const mapped = new URL(url.pathname + url.search, origin);
      mapped.pathname = isMtldss(mapped)
        ? `${mapped.pathname.replace(/\/+$/, '')}/`
        : mapped.pathname.replace(/\/$/, '') || '/';
      return mapped.href;
    } catch {
      return null;
    }
  }

  function imageURL(value, base) {
    if (!value) return null;
    try {
      const url = new URL(value, base);
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null;
      if (!/\.(?:jpe?g|png|webp|gif|avif)(?:$)/i.test(url.pathname)) return null;
      if (/(?:spacer|transparent|placeholder|loading|gravatar|favicon)/i.test(url.pathname)) return null;
      url.hash = '';
      return url.href;
    } catch {
      return null;
    }
  }

  function largestSource(value, base) {
    return (value || '').split(',').map(part => {
      const [url, size] = part.trim().split(/\s+/);
      return { url: imageURL(url, base), size: Number.parseFloat(size) || 1 };
    }).filter(item => item.url).sort((a, b) => b.size - a.size)[0]?.url;
  }

  function parsePage(html, pageURL, kind, origin) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const mtldss = isMtldss(cleanURL(pageURL));
    const links = selector => [...doc.querySelectorAll(selector)]
      .map(node => siteLink(node.getAttribute('href'), pageURL, origin)).filter(Boolean);
    if (kind === 'search') {
      const key = searchKey(pageURL);
      if (mtldss && !doc.querySelector('body.archive.tag, .posts-row.ajaxpager')) {
        throw new Error('未识别到标签结果，可能需要先在浏览器登录或完成验证');
      }
      if (!mtldss && !doc.querySelector('body.search-results, body.search-no-results')) {
        throw new Error('未识别到搜索结果，可能需要先在浏览器登录或完成验证');
      }
      const postSelector = mtldss
        ? 'posts.posts-item h2.item-heading a[href]'
        : '.wp-block-query .wp-block-post-template .wp-block-post-featured-image a[href], .wp-block-query .wp-block-post-template .wp-block-post-title a[href]';
      const pageSelector = mtldss
        ? '.pagenav.ajax-pag a.page-numbers[href]'
        : '.wp-block-query-pagination a[href], link[rel="next"]';
      const posts = [...new Set(links(postSelector)
        .map(url => postRoot(url)).filter(Boolean))];
      const pages = [...new Set(links(pageSelector)
        .filter(url => searchKey(url) === key))];
      if (!posts.length && (mtldss || !doc.querySelector('body.search-no-results'))) {
        throw new Error(`${mtldss ? '标签' : '搜索'}结果结构发生变化：没有找到帖子链接`);
      }
      return { posts, pages, images: [], title: doc.title };
    }
    const body = mtldss
      ? doc.querySelector('[data-nav="posts"].wp-posts-content, article .wp-posts-content')
      : doc.querySelector('.entry-content.wp-block-post-content, article .entry-content');
    if (!body) throw new Error('未找到帖子正文，可能需要先在浏览器登录或完成验证');
    const root = postRoot(pageURL);
    const excluded = '.wp-block-query, .wp-block-post-template, .related, .related-posts, #basicE, aside, header, footer, .advertisement, .ads, .adsbygoogle, .heateor_sss_sharing_container';
    const images = [...body.querySelectorAll(mtldss ? 'img' : 'p img, figure img, .gallery img')].filter(img => {
      if (img.closest(excluded) || img.matches('.emoji, .wp-smiley, .avatar, .wp-post-image')) return false;
      const width = Number(img.getAttribute('width'));
      const height = Number(img.getAttribute('height'));
      return !(width > 0 && width < 180) && !(height > 0 && height < 180);
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
    const pages = mtldss ? [] : [...new Set(links('.entry-content .page-links a[href], .entry-content .page-link-box a[href], link[rel="next"], link[rel="prev"]')
      .filter(url => postRoot(url) === root))];
    const title = (mtldss
      ? doc.querySelector('article h1.article-title')
      : doc.querySelector('main .wp-block-post-title, article .entry-title, .wp-block-post-title'))?.textContent?.trim()
      || doc.title.replace(mtldss ? /\s*[-–]\s*每天来点色色.*$/ : /\s*[-–]\s*4KHD\s*$/, '');
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
    const folders = [safeName(folder, '4KHD')];
    if (person) folders.push(safeName(person, '未命名人物'));
    folders.push(`${safeName(title)}_${shortHash(post)}`);
    return `${folders.join('/')}/${String(index).padStart(4, '0')}.${extension}`;
  }

  globalThis.DownloaderCore = { inputURL, postRoot, searchKey, siteLink, parsePage, safeName, filename };
})();