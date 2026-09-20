"""原图批量提取器端到端测试。

设计要点：
- 站点差异通过 SiteConfig 注入，URL/HTML fixture 仍然按 4khd / mtldss 习惯构造，
  用来验证通用化后的 core.js 在历史结构上行为不变。
- 测试启动时把扩展复制到临时目录，给临时 manifest 写入固定的 host_permissions，
  绕过 chrome.permissions.request 的用户弹窗，保证自动化无交互。
- chrome.storage.local 的 sites / task 都在 setUp 里重置，互不污染。
"""

import base64
import http.server
import json
import os
import shutil
import tempfile
import threading
import time
import unittest
from pathlib import Path, PurePosixPath

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent

# 4khd 站点配置（与原 1.4.1 行为等价）
SITE_4KHD = {
    'hostname': 'www.4khd.com',
    'postPathPattern': r'^/content/[^/]+/[^/]+\.html(?:\/\d+)?/?$',
    'searchPathPattern': r'^/search/([^/]+)(?:\/page\/\d+)?/?$',
    'searchQueryParam': 's',
    'pathnameTransform': 'html-suffix',
    'postBodySelector': '.entry-content.wp-block-post-content, article .entry-content',
    'postImageSelector': 'p img, figure img, .gallery img',
    'postTitleSelector': 'main .wp-block-post-title, article .entry-title, .wp-block-post-title',
    'searchBodyIndicator': 'body.search-results, body.search-no-results',
    'searchPostLinkSelector': '.wp-block-query .wp-block-post-template .wp-block-post-featured-image a[href], .wp-block-query .wp-block-post-template .wp-block-post-title a[href]',
    'searchPageLinkSelector': '.wp-block-query-pagination a[href], link[rel="next"]',
    'postPageLinkSelector': '.entry-content .page-links a[href], .entry-content .page-link-box a[href], link[rel="next"], link[rel="prev"]',
    'titleCleanupRegex': r'\s*[-–]\s*4KHD\s*$',
}

# mtldss 站点配置
SITE_MTLDSS = {
    'hostname': 'mtldss.top',
    'postPathPattern': r'^/index\.php/\d{4}/\d{2}/\d{2}/[^/]+/?$',
    'searchPathPattern': r'^/index\.php/tag/([^/]+)(?:\/page\/\d+)?/?$',
    'pathnameTransform': 'page',
    'postBodySelector': '[data-nav="posts"].wp-posts-content, article .wp-posts-content',
    'postImageSelector': 'img',
    'postTitleSelector': 'article h1.article-title',
    'searchBodyIndicator': 'body.archive.tag, .posts-row.ajaxpager',
    'searchPostLinkSelector': 'posts.posts-item h2.item-heading a[href]',
    'searchPageLinkSelector': '.pagenav.ajax-pag a.page-numbers[href]',
    'postPageLinkSelector': 'link[rel="next"], link[rel="prev"]',
    'titleCleanupRegex': r'\s*[-–]\s*每天来点色色.*$',
}

# 通用站点：只配 hostname，所有选择器走 DEFAULTS — 用于验证纯空白配置也能工作
SITE_GENERIC = {
    'hostname': 'example.org',
}

ORIGIN_4KHD = 'https://www.4khd.com'
ORIGIN_MTLDSS = 'https://mtldss.top'

POST = '/content/10/test-post.html'
SECOND_POST = '/content/11/second-post.html'
MTLDSS_TAG = '/index.php/tag/byoru/'
MTLDSS_TAG_PAGE_2 = '/index.php/tag/byoru/page/2/'
MTLDSS_POST = '/index.php/2026/02/14/byoru-first/'
MTLDSS_SECOND_POST = '/index.php/2026/02/13/byoru-second/'

PNG = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=')


class ImageServer(http.server.BaseHTTPRequestHandler):
    lock = threading.Lock()
    active = 0
    max_active = 0

    def do_GET(self):
        with self.lock:
            type(self).active += 1
            type(self).max_active = max(type(self).max_active, type(self).active)
        try:
            time.sleep(0.6)
            self.send_response(200)
            self.send_header('Content-Type', 'image/png')
            self.send_header('Content-Disposition', 'attachment; filename="flat.png"')
            self.send_header('Content-Length', str(len(PNG)))
            self.end_headers()
            self.wfile.write(PNG)
        finally:
            with self.lock:
                type(self).active -= 1

    def log_message(self, *args):
        pass


class ExtensionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix='ext-tests-', dir=os.environ.get('TEST_TEMP_DIR'))
        # 1. 复制扩展到临时目录并写入固定 host_permissions，绕过 permissions.request 弹窗
        cls.ext_dir = Path(cls.temp.name) / 'ext'
        shutil.copytree(ROOT, cls.ext_dir, ignore=shutil.ignore_patterns('.git', '__pycache__', 'node_modules'))
        manifest_path = cls.ext_dir / 'manifest.json'
        manifest = json.loads(manifest_path.read_text())
        manifest['host_permissions'] = [
            f'{ORIGIN_4KHD}/*',
            f'{ORIGIN_MTLDSS}/*',
            'https://example.org/*',  # 给通用测试用例和"未配置域名"流程用
        ]
        manifest_path.write_text(json.dumps(manifest, indent=2, ensure_ascii=False))
        # 2. 启动图片 HTTP 服务器
        cls.server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), ImageServer)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.image_origin = f'http://127.0.0.1:{cls.server.server_port}'
        # 3. 启动 Playwright
        cls.playwright = sync_playwright().start()
        cls.download_dir = Path(cls.temp.name) / 'downloads'
        cls.download_dir.mkdir(parents=True, exist_ok=True)
        profile = Path(cls.temp.name) / 'profile'
        (profile / 'Default').mkdir(parents=True, exist_ok=True)
        (profile / 'Default' / 'Preferences').write_text(json.dumps({
            'download': {
                'default_directory': str(cls.download_dir),
                'directory_upgrade': True,
                'prompt_for_download': False
            }
        }))
        cls.context = cls.playwright.chromium.launch_persistent_context(
            str(profile), channel='chromium', headless=True,
            args=[f'--disable-extensions-except={cls.ext_dir}', f'--load-extension={cls.ext_dir}'])
        worker = cls.context.service_workers[0] if cls.context.service_workers else cls.context.wait_for_event('serviceworker')
        cls.extension_url = worker.url.replace('background.js', 'manager.html')

    @classmethod
    def tearDownClass(cls):
        cls.context.close()
        cls.playwright.stop()
        cls.server.shutdown()
        cls.server.server_close()
        cls.temp.cleanup()

    def setUp(self):
        with ImageServer.lock:
            ImageServer.active = 0
            ImageServer.max_active = 0
        self.page = self.context.new_page()
        self.errors = []
        self.page.on('pageerror', lambda error: self.errors.append(str(error)))
        self.page.goto(self.extension_url)
        # 重置 storage 并预设 sites 配置（sites 在每个 setUp 里都重置为 4khd + mtldss）
        self.bootstrap_sites([SITE_4KHD, SITE_MTLDSS])
        self.wait_ui('!document.getElementById("start").disabled')
        self.download_dir = self.__class__.download_dir
        for path in self.download_dir.iterdir():
            shutil.rmtree(path) if path.is_dir() else path.unlink()
        self.context.new_cdp_session(self.page).send('Browser.setDownloadBehavior', {
            'behavior': 'default'})

    def tearDown(self):
        self.assertEqual(self.errors, [])
        self.page.evaluate('chrome.storage.local.clear()')
        self.page.close()
        self.context.unroute_all(behavior='wait')

    def bootstrap_sites(self, sites):
        """把 sites 写入扩展 storage 后重载页面，让 manager.js 用新的配置初始化。"""
        self.page.evaluate('chrome.storage.local.clear()')
        self.page.evaluate('sites => chrome.storage.local.set({ sites })', sites)
        self.page.reload()

    def image(self, name):
        return f'{self.image_origin}/{name}.png'

    def post_html(self, images, pages=(), title='测试帖子', origin=ORIGIN_4KHD):
        pictures = ''.join(f'<a href="{url}"><img width="1300" height="1500" src="{url}"></a>' for url in images)
        links = ''.join(f'<a href="{origin}{path}">{index}</a>' for index, path in enumerate(pages, 2))
        return f'<html><body><main><h3 class="wp-block-post-title">{title}</h3><div class="entry-content wp-block-post-content"><p>{pictures}</p><ul class="page-links">{links}</ul></div><div id="basicE"><img src="{self.image("recommendation")}"></div></main></body></html>'

    def search_html(self, posts, pages=(), origin=ORIGIN_4KHD):
        cards = ''.join(f'<li class="wp-block-post"><figure class="wp-block-post-featured-image"><a href="{origin}{post}"><img src="{self.image("thumb")}"></a></figure><h2 class="wp-block-post-title"><a href="{origin}{post}">帖子</a></h2></li>' for post in posts)
        links = ''.join(f'<a href="{origin}{path}">下一页</a>' for path in pages)
        return f'<html><body class="search-results"><div class="wp-block-query"><ul class="wp-block-post-template">{cards}</ul><nav class="wp-block-query-pagination">{links}</nav></div></body></html>'

    def mtldss_tag_html(self, posts, pages=()):
        cards = ''.join(f'<posts class="posts-item card ajax-item style3"><h2 class="item-heading"><a href="{ORIGIN_MTLDSS}{post}">帖子</a></h2></posts>' for post in posts)
        links = ''.join(f'<a class="page-numbers" href="{ORIGIN_MTLDSS}{path}">下一页</a>' for path in pages)
        return f'<html><body class="archive tag tag-byoru"><div class="posts-row ajaxpager">{cards}</div><div class="pagenav ajax-pag">{links}</div></body></html>'

    def mtldss_post_html(self, images, title='测试 mtldss 帖子'):
        pictures = ''.join(f'<p><img src="{ORIGIN_MTLDSS}/wp-content/themes/zibll/img/thumbnail-lg.svg" data-src="{url}"></p>' for url in images)
        return f'''<html><body class="single single-post"><article>
          <h1 class="article-title"><a>{title}</a></h1>
          <div class="article-content"><img src="{self.image("outside-content")}">
            <div data-nav="posts" class="theme-box wp-posts-content">{pictures}</div>
          </div>
        </article><aside><img src="{self.image("recommendation")}"></aside></body></html>'''

    def route_pages(self, fixtures, fail=None, origin=ORIGIN_4KHD):
        seen = []

        def handle(route):
            url = route.request.url
            seen.append(url)
            path = url.removeprefix(origin)
            if fail and fail(path):
                route.fulfill(status=503, body='Temporarily unavailable')
            elif path in fixtures:
                route.fulfill(status=200, content_type='text/html', body=fixtures[path])
            else:
                route.fulfill(status=404, body='Not found')

        self.context.route(origin + '/**', handle)
        return seen

    def wait_ui(self, expression, timeout=30000):
        deadline = time.monotonic() + timeout / 1000
        while time.monotonic() < deadline:
            if self.page.evaluate('() => (' + expression + ')'):
                return
            self.page.wait_for_timeout(100)
        self.fail('等待界面超时: ' + self.page.locator('#logs').inner_text())

    def start(self, path, origin=ORIGIN_4KHD):
        self.page.locator('#url').fill(origin + path)
        self.page.locator('#start').click()

    def wait_done(self):
        self.wait_ui('document.getElementById("status").textContent === "全部完成"', timeout=30000)

    def task(self):
        return self.page.evaluate('chrome.storage.local.get("task").then(result => result.task)')

    def sites(self):
        return self.page.evaluate('chrome.storage.local.get("sites").then(result => result.sites || [])')

    def js_compile(self, site):
        """在扩展页面里调用 core.compile 拿到编译后的 site。"""
        return self.page.evaluate('site => DownloaderCore.compile(site)', site)

    # --- 测试用例 ---------------------------------------------------------------

    def test_manifest_and_branding(self):
        """manifest / 资源 / 标题 / 站点卡片区均已去品牌化。"""
        self.assertEqual(self.page.title(), '原图批量提取器')
        self.assertIn('原图批量提取器', self.page.locator('.brand').inner_text())
        manifest = json.loads((ROOT / 'manifest.json').read_text())
        self.assertEqual(manifest['name'], '原图批量提取器')
        self.assertTrue(all((ROOT / path).is_file() for path in manifest['icons'].values()))
        self.assertEqual(manifest.get('host_permissions', []), [], '仓库 manifest 必须保持 host_permissions 为空')
        self.assertIn('optional_host_permissions', manifest.get('permissions', []))
        # 旧"安装与使用说明"类文案已彻底移除
        body_text = self.page.locator('body').inner_text()
        self.assertNotIn('4KHD', body_text)
        self.assertNotIn('mtldss', body_text)
        self.assertNotIn('hecoq', body_text)
        # 站点卡片被域名列表替换
        self.assertEqual(self.page.locator('.site-card').count(), 0)
        self.assertGreater(self.page.locator('.site-item').count(), 0)

    def test_core_defaults_and_compile(self):
        """core.DEFAULTS 提供兜底，compile 把字符串 regex 编译为实例并保留原始字段。"""
        defaults = self.page.evaluate('DownloaderCore.DEFAULTS')
        self.assertIn('postBodySelector', defaults)
        self.assertIn('postImageSelector', defaults)
        self.assertIn('postTitleSelector', defaults)
        # 非法正则必须降级为 null 而不是抛错
        compiled = self.page.evaluate('site => DownloaderCore.compile({ hostname: "x.test", postPathPattern: "([unclosed" })', None)
        self.assertIsNone(compiled['_postPattern'])
        self.assertEqual(compiled['postPathPattern'], '([unclosed')
        # 合法正则编译成功
        compiled = self.page.evaluate('site => DownloaderCore.compile({ hostname: "x.test", postPathPattern: "^/p/\\\\d+$" })', None)
        self.assertIsNotNone(compiled['_postPattern'])

    def test_core_match_site(self):
        """matchSite 按 hostname 命中站点配置。"""
        result = self.page.evaluate(
            'sites => DownloaderCore.matchSite("https://www.4khd.com/foo", sites)',
            [SITE_4KHD, SITE_MTLDSS])
        self.assertEqual(result['hostname'], 'www.4khd.com')
        result = self.page.evaluate(
            'sites => DownloaderCore.matchSite("https://unknown.example/", sites)',
            [SITE_4KHD, SITE_MTLDSS])
        self.assertIsNone(result)

    def test_input_url_post_search_and_unknown(self):
        """inputURL：4khd 帖子 / 搜索 / 未识别分别走 post / search / 默认单页三种分支。"""
        compiled_4k = self.js_compile(SITE_4KHD)
        compiled_mt = self.js_compile(SITE_MTLDSS)
        post = self.page.evaluate('(args) => DownloaderCore.inputURL(args.url, args.site)',
                                  {'url': ORIGIN_4KHD + POST, 'site': compiled_4k})
        self.assertEqual(post['kind'], 'post')
        self.assertEqual(post['url'], ORIGIN_4KHD + POST)
        self.assertEqual(post['origin'], ORIGIN_4KHD)
        search = self.page.evaluate('(args) => DownloaderCore.inputURL(args.url, args.site)',
                                    {'url': ORIGIN_4KHD + '/?s=%E5%BC%A0%E4%B8%89', 'site': compiled_4k})
        self.assertEqual(search['kind'], 'search')
        self.assertEqual(search['person'], '张三')
        self.assertEqual(search['url'], ORIGIN_4KHD + '/search/%E5%BC%A0%E4%B8%89')
        mt = self.page.evaluate('(args) => DownloaderCore.inputURL(args.url, args.site)',
                                {'url': ORIGIN_MTLDSS + MTLDSS_TAG_PAGE_2, 'site': compiled_mt})
        self.assertEqual(mt, {
            'url': ORIGIN_MTLDSS + MTLDSS_TAG,
            'kind': 'search',
            'origin': ORIGIN_MTLDSS,
            'person': 'byoru',
        })
        # 跨域直接抛错
        with self.assertRaises(Exception):
            self.page.evaluate('(args) => DownloaderCore.inputURL(args.url, args.site)',
                              {'url': 'https://example.org/content/10/post.html', 'site': compiled_4k})

    def test_parse_page_post_filters_and_dedup(self):
        """parsePage：正文内图片正确解析、过滤侧栏 / 小图标 / 懒加载 placeholder。"""
        compiled = self.js_compile(SITE_4KHD)
        html = self.post_html([self.image('one'), self.image('one')], [POST + '/2', SECOND_POST])
        html = html.replace(
            '</p>',
            f'<img width="10" src="{self.image("icon")}"><img data-lazy-src="{self.image("lazy")}" src="data:image/png;base64,AA"></p>')
        result = self.page.evaluate(
            '(args) => DownloaderCore.parsePage(args.html, args.url, args.kind, args.origin, args.site)',
            {'html': html, 'url': ORIGIN_4KHD + POST, 'kind': 'post', 'origin': ORIGIN_4KHD, 'site': compiled})
        self.assertEqual(result['images'], [self.image('one'), self.image('lazy')])
        self.assertEqual(result['pages'], [ORIGIN_4KHD + POST + '/2'])

    def test_filename_and_safe_name(self):
        """safeName 处理保留名、非法字符；filename 路径层级正确。"""
        self.assertEqual(self.page.evaluate('() => DownloaderCore.safeName("../CON")'), '_CON')
        filename = self.page.evaluate(
            '() => DownloaderCore.filename("4KHD", "帖子", "' + ORIGIN_4KHD + POST + '", 1, "https://img.example/one.JPG", "../张:三")')
        self.assertEqual(PurePosixPath(filename).parts[:2], ('4KHD', '_张_三'))

    def test_post_download_pagination_dedup_and_restore(self):
        fixtures = {
            POST: self.post_html([self.image('one'), self.image('two')], [POST + '/2']),
            POST + '/2': self.post_html([self.image('two'), self.image('three')], [POST])
        }
        seen = self.route_pages(fixtures)
        self.start(POST + '/2')
        self.wait_ui('Number(document.getElementById("page-count").textContent) >= 1')
        self.page.locator('#pause').click()
        self.wait_ui('document.getElementById("status").textContent.includes("已暂停")')
        self.page.reload()
        self.wait_ui('!document.getElementById("resume").disabled')
        self.page.locator('#resume').click()
        self.wait_done()
        task = self.task()
        self.assertEqual(len(task['images']), 3)
        self.assertEqual(len(task['pages']), 2)
        self.assertTrue(all(image['status'] == 'complete' for image in task['images']))
        self.assertEqual(seen.count(ORIGIN_4KHD + POST), 1)
        # task 已迁移到 v4 并写入 site 快照
        self.assertEqual(task['version'], 4)
        self.assertIsNotNone(task['site'])
        self.assertEqual(task['site']['hostname'], 'www.4khd.com')
        for image in task['images']:
            self.assertEqual(len(PurePosixPath(image['filename']).parts), 3)
            result = self.page.evaluate('id => chrome.downloads.search({ id })', image['id'])[0]
            self.assertEqual(result['state'], 'complete')
            self.assertEqual(Path(result['filename']).relative_to(self.download_dir).as_posix(), image['filename'])
            self.assertEqual(Path(result['filename']).read_bytes(), PNG)

    def test_search_nested_pagination_and_failed_page_retry(self):
        search = '/search/test'
        fixtures = {
            search: self.search_html([POST], [search + '/page/2']),
            search + '/page/2': self.search_html([POST, SECOND_POST], [search]),
            POST: self.post_html([self.image('search-one')], [POST + '/2']),
            POST + '/2': self.post_html([self.image('search-two')], [POST]),
            SECOND_POST: self.post_html([self.image('search-one')], title='第二个帖子')
        }
        failed = {'enabled': True}
        seen = self.route_pages(fixtures, lambda path: path == POST + '/2' and failed['enabled'])
        self.start(search)
        self.wait_ui('document.getElementById("status").textContent.includes("部分失败")', timeout=30000)
        self.assertEqual(self.page.locator('#failed-count').inner_text(), '1')
        failed['enabled'] = False
        self.page.locator('#retry').click()
        self.wait_done()
        task = self.task()
        self.assertEqual(len(task['posts']), 2)
        self.assertEqual(len(task['pages']), 5)
        self.assertEqual(len(task['images']), 3)
        self.assertEqual(seen.count(ORIGIN_4KHD + POST), 1)
        self.assertEqual(seen.count(ORIGIN_4KHD + POST + '/2'), 2)
        self.assertEqual(task['person'], 'test')
        paths = [PurePosixPath(image['filename']) for image in task['images']]
        self.assertTrue(all(path.parts[:2] == ('4KHD', 'test') for path in paths))
        self.assertTrue(all(len(path.parts) == 4 for path in paths))
        self.assertEqual(len({path.parts[2] for path in paths}), 2)
        for image in task['images']:
            result = self.page.evaluate('id => chrome.downloads.search({ id })', image['id'])[0]
            self.assertEqual(result['state'], 'complete')
            self.assertEqual(Path(result['filename']).relative_to(self.download_dir).as_posix(), image['filename'])
            self.assertEqual(Path(result['filename']).read_bytes(), PNG)

    def test_mtldss_tag_pagination_lazy_images_and_nested_folders(self):
        compiled = self.js_compile(SITE_MTLDSS)
        tag_input = self.page.evaluate('(args) => DownloaderCore.inputURL(args.url, args.site)',
                                       {'url': ORIGIN_MTLDSS + MTLDSS_TAG_PAGE_2, 'site': compiled})
        self.assertEqual(tag_input, {
            'url': ORIGIN_MTLDSS + MTLDSS_TAG,
            'kind': 'search',
            'origin': ORIGIN_MTLDSS,
            'person': 'byoru',
        })
        self.assertEqual(
            self.page.evaluate('(args) => DownloaderCore.postRoot(args.url, args.site)',
                              {'url': ORIGIN_MTLDSS + MTLDSS_POST + '?ref=tag', 'site': compiled}),
            ORIGIN_MTLDSS + MTLDSS_POST)

        fixtures = {
            MTLDSS_TAG: self.mtldss_tag_html([MTLDSS_POST], [MTLDSS_TAG_PAGE_2]),
            MTLDSS_TAG_PAGE_2: self.mtldss_tag_html([MTLDSS_POST, MTLDSS_SECOND_POST], [MTLDSS_TAG]),
            MTLDSS_POST: self.mtldss_post_html([self.image('mtldss-one')], title='Byoru 第一帖'),
            MTLDSS_SECOND_POST: self.mtldss_post_html([self.image('mtldss-two')], title='Byoru 第二帖')
        }
        seen = self.route_pages(fixtures, origin=ORIGIN_MTLDSS)
        self.start(MTLDSS_TAG_PAGE_2, origin=ORIGIN_MTLDSS)
        self.wait_done()

        task = self.task()
        self.assertEqual(task['person'], 'byoru')
        self.assertEqual(task['site']['hostname'], 'mtldss.top')
        self.assertEqual(len(task['posts']), 2)
        self.assertEqual(len(task['pages']), 4)
        self.assertEqual(len(task['images']), 2)
        self.assertEqual(seen.count(ORIGIN_MTLDSS + MTLDSS_TAG), 1)
        self.assertEqual(seen.count(ORIGIN_MTLDSS + MTLDSS_TAG_PAGE_2), 1)
        paths = [PurePosixPath(image['filename']) for image in task['images']]
        self.assertTrue(all(path.parts[:2] == ('4KHD', 'byoru') for path in paths))
        self.assertTrue(all(len(path.parts) == 4 for path in paths))
        self.assertEqual(len({path.parts[2] for path in paths}), 2)
        self.assertEqual({image['url'] for image in task['images']}, {self.image('mtldss-one'), self.image('mtldss-two')})
        for image in task['images']:
            result = self.page.evaluate('id => chrome.downloads.search({ id })', image['id'])[0]
            self.assertEqual(result['state'], 'complete')
            self.assertEqual(Path(result['filename']).relative_to(self.download_dir).as_posix(), image['filename'])
            self.assertEqual(Path(result['filename']).read_bytes(), PNG)

    def test_unlimited_total_uses_rolling_dispatch(self):
        images = [self.image(f'bulk-{index}') for index in range(30)]
        self.route_pages({POST: self.post_html(images)})
        self.page.evaluate('''() => {
          const sendMessage = chrome.runtime.sendMessage.bind(chrome.runtime);
          globalThis.batchSizes = [];
          chrome.runtime.sendMessage = message => {
            if (message?.type === 'download-batch') globalThis.batchSizes.push(message.items.length);
            return sendMessage(message);
          };
        }''')
        self.start(POST)
        self.wait_done()
        batch_sizes = self.page.evaluate('globalThis.batchSizes')
        self.assertEqual(sum(batch_sizes), 30)
        self.assertGreater(len(batch_sizes), 1)
        self.assertLessEqual(max(batch_sizes), 12)
        self.assertGreater(ImageServer.max_active, 3)
        self.assertLessEqual(ImageServer.max_active, 12)

    def test_file_congestion_reduces_dispatch_and_recovers(self):
        images = [self.image(f'pressure-{index}') for index in range(18)]
        self.route_pages({POST: self.post_html(images)})
        self.page.evaluate('''() => {
          const sendMessage = chrome.runtime.sendMessage.bind(chrome.runtime);
          globalThis.pressureBatchSizes = [];
          globalThis.injectTransientFailure = true;
          chrome.runtime.sendMessage = message => {
            if (message?.type !== 'download-batch') return sendMessage(message);
            globalThis.pressureBatchSizes.push(message.items.length);
            if (globalThis.injectTransientFailure) {
              globalThis.injectTransientFailure = false;
              return Promise.resolve({
                results: message.items.map(() => ({ error: 'FILE_TRANSIENT_ERROR' }))
              });
            }
            return sendMessage(message);
          };
        }''')
        self.start(POST)
        self.wait_done()
        batch_sizes = self.page.evaluate('globalThis.pressureBatchSizes')
        self.assertEqual(batch_sizes[0], 12)
        self.assertTrue(all(size <= 6 for size in batch_sizes[1:]))
        task = self.task()
        self.assertTrue(all(image['status'] == 'complete' for image in task['images']))
        self.assertEqual(sum(image['attempts'] for image in task['images']), 30)
        self.assertIn('已自动降速并错峰重试', self.page.locator('#logs').inner_text())

    def test_saved_running_task_resumes_through_rolling_queue(self):
        images = [self.image(f'resume-{index}') for index in range(18)]
        saved_task = {
            'version': 3,
            'url': ORIGIN_4KHD + POST,
            'kind': 'post',
            'origin': ORIGIN_4KHD,
            'folder': '4KHD',
            'startedAt': '2026-09-18T00:00:00.000Z',
            'status': 'running',
            'current': '旧任务执行中',
            'posts': {ORIGIN_4KHD + POST: {'title': '恢复测试', 'count': len(images)}},
            'pages': [{'url': ORIGIN_4KHD + POST, 'kind': 'post', 'post': ORIGIN_4KHD + POST, 'status': 'complete'}],
            'images': [
                {
                    'url': url,
                    'post': ORIGIN_4KHD + POST,
                    'filename': f'4KHD/resume-test/{index + 1:04}.png',
                    'status': 'pending',
                    'id': None,
                    'attempts': 2
                }
                for index, url in enumerate(images)
            ],
            'logs': []
        }
        self.page.evaluate('task => chrome.storage.local.set({ task })', saved_task)
        self.page.reload()
        self.wait_ui('!document.getElementById("resume").disabled')
        self.page.evaluate('''() => {
          const sendMessage = chrome.runtime.sendMessage.bind(chrome.runtime);
          globalThis.resumeBatchSizes = [];
          chrome.runtime.sendMessage = message => {
            if (message?.type === 'download-batch') globalThis.resumeBatchSizes.push(message.items.length);
            return sendMessage(message);
          };
        }''')
        self.page.locator('#resume').click()
        self.wait_done()
        task = self.task()
        self.assertEqual(task['version'], 4)
        self.assertIsNotNone(task['site'])
        self.assertEqual(task['site']['hostname'], 'www.4khd.com')
        self.assertTrue(all(image['status'] == 'complete' for image in task['images']))
        batch_sizes = self.page.evaluate('globalThis.resumeBatchSizes')
        self.assertEqual(sum(batch_sizes), 18)
        self.assertLessEqual(max(batch_sizes), 12)

    def test_download_failures_retry_automatically_and_stop_after_limit(self):
        success = self.image('retry-success')
        exhausted = self.image('retry-exhausted')
        self.route_pages({POST: self.post_html([success, exhausted])})
        self.page.evaluate('''successURL => {
          const sendMessage = chrome.runtime.sendMessage.bind(chrome.runtime);
          globalThis.retryCalls = {};
          chrome.runtime.sendMessage = async message => {
            if (message?.type !== 'download-batch') return sendMessage(message);
            const results = new Array(message.items.length);
            const realItems = [];
            const realIndexes = [];
            message.items.forEach((item, index) => {
              const attempt = (globalThis.retryCalls[item.url] || 0) + 1;
              globalThis.retryCalls[item.url] = attempt;
              if (item.url === successURL && attempt >= 4) {
                realItems.push(item);
                realIndexes.push(index);
              } else {
                results[index] = { error: '模拟下载失败' };
              }
            });
            if (realItems.length) {
              const response = await sendMessage({ type: 'download-batch', items: realItems });
              response.results.forEach((result, index) => { results[realIndexes[index]] = result; });
            }
            return { results };
          };
        }''', success)
        self.start(POST)
        self.wait_ui('document.getElementById("status").textContent.includes("部分失败")', timeout=30000)
        task = self.task()
        success_item = next(image for image in task['images'] if image['url'] == success)
        exhausted_item = next(image for image in task['images'] if image['url'] == exhausted)
        self.assertEqual((success_item['status'], success_item['attempts']), ('complete', 4))
        self.assertEqual((exhausted_item['status'], exhausted_item['attempts']), ('failed', 4))
        self.assertEqual(self.page.evaluate('globalThis.retryCalls'), {success: 4, exhausted: 4})
        logs = self.page.locator('#logs').inner_text()
        self.assertIn('自动重试（3/3）', logs)
        self.assertIn('已用完 3 次自动重试', logs)

    # --- 通用化相关新增用例 -----------------------------------------------------

    def test_sites_listed_in_manager(self):
        """启动后域名列表里能看到预设的两个站点。"""
        items = self.page.locator('.site-item').evaluate_all(
            'nodes => nodes.map(node => node.querySelector("strong").textContent)')
        self.assertIn('www.4khd.com', items)
        self.assertIn('mtldss.top', items)

    def test_add_edit_delete_site_via_ui(self):
        """通过 UI 增删改 site 配置并实时持久化。"""
        # 添加
        self.page.locator('#site-hostname').fill('example.org')
        self.page.locator('#site-post-pattern').fill(r'^/posts/[^/]+/?$')
        self.page.locator('#site-save').click()
        self.wait_ui('document.getElementById("status").textContent.includes("已保存")')
        self.assertIn('example.org', [s['hostname'] for s in self.sites()])
        # 编辑：修改 searchPathPattern
        self.page.locator('.site-item').filter(has_text='example.org').locator('button[data-action="edit"]').click()
        self.page.locator('#site-search-pattern').fill(r'^/q/([^/]+)/?$')
        self.page.locator('#site-save').click()
        sites = self.sites()
        target = next(s for s in sites if s['hostname'] == 'example.org')
        self.assertEqual(target['searchPathPattern'], r'^/q/([^/]+)/?$')
        self.assertEqual(target['postPathPattern'], r'^/posts/[^/]+/?$')
        # 删除
        self.page.on('dialog', lambda d: d.accept())
        self.page.locator('.site-item').filter(has_text='example.org').locator('button[data-action="delete"]').click()
        self.wait_ui('!Array.from(document.querySelectorAll(".site-item")).some(n => n.textContent.includes("example.org"))')
        self.assertNotIn('example.org', [s['hostname'] for s in self.sites()])

    def test_invalid_regex_does_not_crash_save(self):
        """非法正则：compile 内部 try/catch 降级，UI 保存不应该把扩展搞崩。"""
        self.page.locator('#site-hostname').fill('broken.example.org')
        self.page.locator('#site-post-pattern').fill('([unclosed')
        self.page.locator('#site-save').click()
        self.wait_ui('document.getElementById("status").textContent.includes("已保存")')
        sites = self.sites()
        target = next(s for s in sites if s['hostname'] == 'broken.example.org')
        self.assertEqual(target['postPathPattern'], '([unclosed')
        # page error 没新增
        self.assertEqual(self.errors, [])

    def test_unconfigured_domain_creates_blank_site(self):
        """未配置域名提交任务：自动建空白 site 引导用户填写。"""
        self.bootstrap_sites([])  # 清空预设
        self.page.locator('#url').fill('https://news.example.org/articles/2026/09/intro/')
        self.page.locator('#start').click()
        self.wait_ui('document.getElementById("status").textContent.includes("未配置")')
        sites = self.sites()
        self.assertIn('news.example.org', [s['hostname'] for s in sites])
        # task 不会被创建
        self.assertIsNone(self.task())

    def test_generic_site_uses_defaults(self):
        """仅配 hostname 的站点能用 DEFAULTS 抓到正文图片。"""
        # 路由返回一段 article-only HTML，DEFAULTS 的 postBodySelector 应能命中
        body_origin = ORIGIN_4KHD  # 复用同一图片服务器
        # 替换 origin：把 example.org 路由到 localhost 图片服务器
        self.context.route('https://example.org/**', lambda route: route.fulfill(
            status=200, content_type='text/html',
            body=f'<html><body><article><h1>通用测试</h1><p><img src="{self.image("g1")}"></p><p><img src="{self.image("g2")}"></p></article></body></html>'
        ))
        self.bootstrap_sites([SITE_GENERIC])
        self.page.locator('#url').fill('https://example.org/posts/2026/09/intro/')
        self.page.locator('#start').click()
        self.wait_done()
        task = self.task()
        self.assertEqual(len(task['images']), 2)
        self.assertEqual(task['site']['hostname'], 'example.org')
        for image in task['images']:
            self.assertEqual(image['status'], 'complete')


if __name__ == '__main__':
    unittest.main(verbosity=2)