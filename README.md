# 原图批量提取器

> 通用网页原图批量下载 Chrome 扩展。自定义域名白名单与路径正则，按主题与帖子自动归档，失败自动重试。

把任意网页的正文原图，按 `根目录/主题或人名/帖子哈希/序号.ext` 三层结构批量下载到本地。

## 特性

- 🌐 **通用化**：用户可配置域名白名单与路径正则，适配任意网站
- 📑 **自动分页**：识别帖子页和搜索页的分页链接，按去重队列读取全部
- ⚡ **自适应并发**：浏览器写入拥塞时自动降速，稳定后自动提速；不设硬上限
- 🔁 **智能重试**：区分可重试与不可重试错误（`FILE_TRANSIENT_ERROR` 错峰重试，`SERVER_FORBIDDEN` 直接标失败）
- 📦 **多层归档**：`<根目录>/<主题或人名>/<帖子哈希>/0001.jpg` 结构，文件名永不冲突
- 🛡 **可选权限**：用 `optional_host_permissions`，按需申请；不上传任何数据
- 🧪 **端到端测试**：Playwright + Chromium 持久化 profile，覆盖 UI/解析/下载/重试/恢复

## 安装

需要 Chrome 109 或更高版本（Manifest V3）。

1. 克隆本仓库或下载 ZIP 并解压
2. 打开 `chrome://extensions`
3. 打开右上角「**开发者模式**」
4. 点击「**加载已解压的扩展程序**」，选择本仓库根目录（含 `manifest.json` 的目录）
5. 点击工具栏扩展图标打开「原图批量提取器」管理面板

## 使用

### 1. 添加站点配置

首次使用先到管理面板的「域名配置」表单，添加你要抓图的站点：

- **域名**：例如 `example.com`（不含协议、不含路径）
- **帖子路径正则**：识别帖子页的正则，例 `^/posts/[^/]+\.html$`。留空 = 把任何路径当作单页
- **搜索路径正则**：识别搜索页的正则，**第一捕获组是搜索关键词**，例 `^/search/([^/]+)/?$`
- **搜索参数名**：URL `?xxx=...` 中的参数名（如 `?s=张三` 填 `s`），与搜索正则二选一或同时存在
- **路径标准化**：决定 `postRoot` 如何归一化 URL
  - `strip-slash`：去掉尾斜杠
  - `page`：保留尾斜杠
  - `html-suffix`：剥离 `.html/N`（如 `/post.html/2` → `/post.html`）
  - 留空：原样保留
- **高级 → 正文/图片/标题选择器**：留空就用内置默认
- **高级 → 标题清理正则**：去掉标题里站点尾巴，例如 `\s*[-–]\s*我的站点\s*$`

### 2. 创建任务

在「下载工作台」：

1. 粘贴一个帖子 URL 或搜索 URL
2. 输入根文件夹名（默认 `下载`）
3. 点击「**开始任务**」
4. 浏览器右上角扩展图标会显示进行中状态；关闭页面后任务仍会保留在 storage

如果粘贴的 URL 域名未配置，扩展会自动建一条空白配置并引导你填写。

### 3. 归档结构

```
<根目录>/
  <搜索人名或空>/
    <帖子标题_8位哈希>/
      0001.jpg
      0002.jpg
      ...
```

例如：

```
下载/
  张三/
    某套图_3f7a1b2c/
      0001.jpg
      0002.webp
      ...
```

## 内置选择器默认

如果某字段留空，会使用以下默认：

| 字段 | 默认值 |
|---|---|
| `postBodySelector` | `article, main, [role="main"], .post, .entry-content, .post-content, .article-content` |
| `postImageSelector` | `img` |
| `postTitleSelector` | `h1, .post-title, .entry-title, .article-title, main h1` |
| `searchPostLinkSelector` | `a[href]` |
| `searchPageLinkSelector` | `a[href][rel="next"], .pagination a[href], .nav-links a[href], link[rel="next"]` |
| `postPageLinkSelector` | `link[rel="next"], link[rel="prev"], .pagination a[href], .page-links a[href]` |
| `minImageSize` | `180`（小于该宽或高的图片视为缩略图，不下载） |

排除选择器始终启用：`.wp-block-query`, `.related`, `aside`, `header`, `footer`, `.advertisement`, `.avatar`, `.emoji` 等。

## 常见站点模板

### 4KHD / HECOQ（已内嵌为测试 fixture）

```json
{
  "hostname": "www.4khd.com",
  "postPathPattern": "^/content/[^/]+/[^/]+\\.html(?:/\\d+)?/?$",
  "searchPathPattern": "^/search/([^/]+)(?:/page/\\d+)?/?$",
  "searchQueryParam": "s",
  "pathnameTransform": "html-suffix"
}
```

### mtldss

```json
{
  "hostname": "mtldss.top",
  "postPathPattern": "^/index\\.php/\\d{4}/\\d{2}/\\d{2}/[^/]+/?$",
  "searchPathPattern": "^/index\\.php/tag/([^/]+)(?:/page/\\d+)?/?$",
  "pathnameTransform": "page"
}
```

### 通用 WordPress 站点

```json
{
  "hostname": "yourblog.com",
  "postPathPattern": "^/\\d{4}/\\d{2}/[^/]+/?$",
  "searchPathPattern": "^/?s=([^&]+)",
  "searchQueryParam": "s"
}
```

## 开发

### 跑测试

```bash
pip install -r requirements.txt
playwright install chromium

# 跑全部
python3 -m unittest test_extension -v

# 跑单个
python3 -m unittest test_extension.ExtensionTests.test_post_download_pagination_dedup_and_restore
```

测试用 Playwright + 持久化 Chromium profile，会在临时目录创建扩展副本（注入固定 `host_permissions` 绕过权限弹窗）。

### 项目结构

```
manifest.json       # 扩展清单（MV3 + optional_host_permissions）
background.js       # Service Worker：图标点击、下载队列
core.js             # 纯函数库：URL 解析、HTML 解析、文件名生成
manager.html        # 管理面板（单页）
manager.css         # 样式
manager.js          # 任务状态机 + UI 交互
test_extension.py   # 端到端测试（unittest + Playwright）
assets/             # 图标
```

### 关键设计

- **状态持久化**：任务状态写入 `chrome.storage.local`，版本号 `v4`，老版本自动迁移
- **下载解耦**：`manager.js` 走 `chrome.runtime.sendMessage` 发到 `background.js` 的 Service Worker，统一处理 `onDeterminingFilename` 和并发
- **正则降级**：`compile()` 内部 `try/catch`，非法正则降为 `null` 而不抛错
- **跨域检测**：`siteLink()` 把站内链接归一为 `origin` 域名下的绝对 URL，跨域跳转直接丢弃

## 路线图

- [ ] 内置 CMS 模板下拉选择
- [ ] 实时预览图片数（先 dry-run 解析再开始下载）
- [ ] 失败页面的 manual retry 标记
- [ ] 站点配置导入/导出 JSON

## 协议

[MIT](LICENSE) © 2026 H-pony