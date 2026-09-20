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
ORIGIN = 'https://hecoq.uuss.uk'
POST = '/content/10/test-post.html'
SECOND_POST = '/content/11/second-post.html'
MTLDSS_ORIGIN = 'https://mtldss.top'
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
        cls.temp = tempfile.TemporaryDirectory(prefix='4khd-tests-', dir=os.environ.get('TEST_TEMP_DIR'))
        cls.server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), ImageServer)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.image_origin = f'http://127.0.0.1:{cls.server.server_port}'
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
            args=[f'--disable-extensions-except={ROOT}', f'--load-extension={ROOT}'])
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
        self.page.evaluate('chrome.storage.local.clear()')
        self.page.reload()
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

    def image(self, name):
        return f'{self.image_origin}/{name}.png'

    def post_html(self, images, pages=(), title='测试帖子'):
        pictures = ''.join(f'<a href="{url}"><img width="1300" height="1500" src="{url}"></a>' for url in images)
        links = ''.join(f'<a href="https://www.4khd.com{path}">{index}</a>' for index, path in enumerate(pages, 2))
        return f'<html><body><main><h3 class="wp-block-post-title">{title}</h3><div class="entry-content wp-block-post-content"><p>{pictures}</p><ul class="page-links">{links}</ul></div><div id="basicE"><img src="{self.image("recommendation")}"></div></main></body></html>'

    def search_html(self, posts, pages=()):
        cards = ''.join(f'<li class="wp-block-post"><figure class="wp-block-post-featured-image"><a href="https://www.4khd.com{post}"><img src="{self.image("thumb")}"></a></figure><h2 class="wp-block-post-title"><a href="https://www.4khd.com{post}">帖子</a></h2></li>' for post in posts)
        links = ''.join(f'<a href="https://www.4khd.com{path}">下一页</a>' for path in pages)
        return f'<html><body class="search-results"><div class="wp-block-query"><ul class="wp-block-post-template">{cards}</ul><nav class="wp-block-query-pagination">{links}</nav></div></body></html>'

    def mtldss_tag_html(self, posts, pages=()):
        cards = ''.join(f'<posts class="posts-item card ajax-item style3"><h2 class="item-heading"><a href="{MTLDSS_ORIGIN}{post}">帖子</a></h2></posts>' for post in posts)
        links = ''.join(f'<a class="page-numbers" href="{MTLDSS_ORIGIN}{path}">下一页</a>' for path in pages)
        return f'<html><body class="archive tag tag-byoru"><div class="posts-row ajaxpager">{cards}</div><div class="pagenav ajax-pag">{links}</div></body></html>'

    def mtldss_post_html(self, images, title='测试 mtldss 帖子'):
        pictures = ''.join(f'<p><img src="{MTLDSS_ORIGIN}/wp-content/themes/zibll/img/thumbnail-lg.svg" data-src="{url}"></p>' for url in images)
        return f'''<html><body class="single single-post"><article>
          <h1 class="article-title"><a>{title}</a></h1>
          <div class="article-content"><img src="{self.image("outside-content")}">
            <div data-nav="posts" class="theme-box wp-posts-content">{pictures}</div>
          </div>
        </article><aside><img src="{self.image("recommendation")}"></aside></body></html>'''

    def route_pages(self, fixtures, fail=None, origin=ORIGIN):
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

    def start(self, path, origin=ORIGIN):
        self.page.locator('#url').fill(origin + path)
        self.page.locator('#start').click()

    def wait_done(self):
        self.wait_ui('document.getElementById("status").textContent === "全部完成"', timeout=30000)

    def task(self):
        return self.page.evaluate('chrome.storage.local.get("task").then(result => result.task)')

    def test_parser_scope_lazy_and_url_validation(self):
        self.assertEqual(self.page.title(), '帖子图床提取器')
        self.assertIn('帖子图床提取器', self.page.locator('.brand').inner_text())
        manifest = json.loads((ROOT / 'manifest.json').read_text())
        self.assertEqual(manifest['name'], '帖子图床提取器')
        self.assertTrue(all((ROOT / path).is_file() for path in manifest['icons'].values()))
        self.assertEqual(self.page.locator('.intro, .intro-list, .install, .install-list').count(), 0)
        body_text = self.page.locator('body').inner_text()
        self.assertNotIn('功能说明', body_text)
        self.assertNotIn('安装与使用说明', body_text)
        site_links = self.page.locator('#supported-sites a.site-card').evaluate_all(
            'nodes => nodes.map(node => ({ href: node.href, target: node.target, rel: node.rel }))')
        self.assertEqual({item['href'] for item in site_links}, {
            'https://www.4khd.com/',
            'https://hecoq.uuss.uk/',
            'https://mtldss.top/'
        })
        self.assertTrue(all(item['target'] == '_blank' for item in site_links))
        self.assertTrue(all({'noopener', 'noreferrer'} <= set(item['rel'].split()) for item in site_links))
        html = self.post_html([self.image('one'), self.image('one')], [POST + '/2', SECOND_POST])
        html = html.replace('</p>', f'<img width="10" src="{self.image("icon")}"><img data-lazy-src="{self.image("lazy")}" src="data:image/png;base64,AA"></p>')
        result = self.page.evaluate('html => DownloaderCore.parsePage(html, "' + ORIGIN + POST + '", "post", "' + ORIGIN + '")', html)
        self.assertEqual(result['images'], [self.image('one'), self.image('lazy')])
        self.assertEqual(result['pages'], [ORIGIN + POST + '/2'])
        self.assertTrue(self.page.evaluate('() => { try { DownloaderCore.inputURL("https://example.org/content/10/post.html"); return false; } catch { return true; } }'))
        self.assertEqual(self.page.evaluate('DownloaderCore.safeName("../CON")'), '_CON')
        search_input = self.page.evaluate('DownloaderCore.inputURL("' + ORIGIN + '/?s=%E5%BC%A0%E4%B8%89")')
        self.assertEqual(search_input['person'], '张三')
        self.assertEqual(search_input['url'], ORIGIN + '/search/%E5%BC%A0%E4%B8%89')
        filename = self.page.evaluate('DownloaderCore.filename("4KHD", "帖子", "' + ORIGIN + POST + '", 1, "https://img.example/one.JPG", "../张:三")')
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
        self.assertEqual(seen.count(ORIGIN + POST), 1)
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
        self.assertNotIn('concurrency', task)
        self.assertEqual(self.page.locator('#concurrency').count(), 0)
        self.assertEqual(seen.count(ORIGIN + POST), 1)
        self.assertEqual(seen.count(ORIGIN + POST + '/2'), 2)
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
        tag_input = self.page.evaluate(f'DownloaderCore.inputURL("{MTLDSS_ORIGIN}{MTLDSS_TAG_PAGE_2}")')
        self.assertEqual(tag_input, {
            'url': MTLDSS_ORIGIN + MTLDSS_TAG,
            'kind': 'search',
            'origin': MTLDSS_ORIGIN,
            'person': 'byoru'
        })
        self.assertEqual(
            self.page.evaluate(f'DownloaderCore.postRoot("{MTLDSS_ORIGIN}{MTLDSS_POST}?ref=tag")'),
            MTLDSS_ORIGIN + MTLDSS_POST)

        fixtures = {
            MTLDSS_TAG: self.mtldss_tag_html([MTLDSS_POST], [MTLDSS_TAG_PAGE_2]),
            MTLDSS_TAG_PAGE_2: self.mtldss_tag_html([MTLDSS_POST, MTLDSS_SECOND_POST], [MTLDSS_TAG]),
            MTLDSS_POST: self.mtldss_post_html([self.image('mtldss-one')], title='Byoru 第一帖'),
            MTLDSS_SECOND_POST: self.mtldss_post_html([self.image('mtldss-two')], title='Byoru 第二帖')
        }
        seen = self.route_pages(fixtures, origin=MTLDSS_ORIGIN)
        self.start(MTLDSS_TAG_PAGE_2, origin=MTLDSS_ORIGIN)
        self.wait_done()

        task = self.task()
        self.assertEqual(task['person'], 'byoru')
        self.assertEqual(len(task['posts']), 2)
        self.assertEqual(len(task['pages']), 4)
        self.assertEqual(len(task['images']), 2)
        self.assertEqual(seen.count(MTLDSS_ORIGIN + MTLDSS_TAG), 1)
        self.assertEqual(seen.count(MTLDSS_ORIGIN + MTLDSS_TAG_PAGE_2), 1)
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
        self.assertNotIn('concurrency', self.task())

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
            'version': 2,
            'url': ORIGIN + POST,
            'kind': 'post',
            'origin': ORIGIN,
            'folder': '4KHD',
            'startedAt': '2026-09-18T00:00:00.000Z',
            'status': 'running',
            'current': '旧任务执行中',
            'posts': {ORIGIN + POST: {'title': '恢复测试', 'count': len(images)}},
            'pages': [{'url': ORIGIN + POST, 'kind': 'post', 'post': ORIGIN + POST, 'status': 'complete'}],
            'images': [
                {
                    'url': url,
                    'post': ORIGIN + POST,
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
        self.assertEqual(task['version'], 3)
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


if __name__ == '__main__':
    unittest.main(verbosity=2)