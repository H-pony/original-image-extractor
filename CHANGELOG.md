# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.5.0] - 2026-09-20

### Changed — 通用化
- **核心库 `core.js` 全参数化**：所有硬编码的 hosts、URL 正则、CSS 选择器改为 `SiteConfig` 字段
- **`manifest.host_permissions` 清空**：改为 `optional_host_permissions`，首次访问新域名时按需授权
- **`manager.html` 去品牌**：移除「4KHD / mtldss / 每天来点色色」等具体站名
- **站点卡片区 → 域名配置表单**：用户可自定义每个域名的 postPathPattern / searchPathPattern / 路径标准化 / 高级选择器
- **状态版本从 3 升到 4**：老 state 自动按 `url.origin` 找回 site 配置
- **`navigator.locks` key**：`4khd-task-manager` → `downloader-task-manager`

### Added
- **域名配置 UI**：增删改 site 配置，进阶字段折叠在 `<details>` 里
- **`SITE_GENERIC` 默认支持**：只配 hostname 就能用 DEFAULTS 抓到任意页面正文图
- **`compile(site)` / `matchSite(value, sites)`** 工具函数
- **测试覆盖通用化**：新增 9 个测试用例（站点列表渲染、增删改、非法正则、未配置域名、DEFAULTS 路径）
- **端到端测试自举**：临时副本注入固定 host_permissions，绕过 `chrome.permissions.request` 弹窗

### Removed
- 硬编码的 `hecoq.uuss.uk` / `4khd.com` / `mtldss.top` 白名单
- 硬编码的 4khd `.html/N` 路径 transform（现在叫 `html-suffix`，可配置）
- 硬编码的搜索/帖子路径正则
- UI 上的站点跳转卡片

### Internal
- `core.js` 暴露 `DEFAULTS` 让 UI 复用默认选择器
- `core.parsePage` / `core.inputURL` / `core.postRoot` / `core.searchKey` 都接受 `site` 参数

## [1.4.1] - 2026-09-18

- 原始发布：「帖子图床提取器」，固定支持 `hecoq.uuss.uk` / `www.4khd.com` / `mtldss.top`
- 自适应滚动下载（4-24 路动态窗口）
- 失败自动重试（最多 3 次）
- 跨任务状态持久化

[1.5.0]: https://github.com/H-pony/original-image-extractor/compare/v1.4.1...v1.5.0
[1.4.1]: https://github.com/H-pony/original-image-extractor/releases/tag/v1.4.1