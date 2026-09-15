# 参考项目与实现取舍

检查日期：2026-09-15。下面区分“实际读到的实现”“本版采用的设计”和“没有验证的部分”，不以仓库存在或星数代替运行证据。

## 1. storyAura/MihuashiDownloader

- 仓库：https://github.com/storyAura/MihuashiDownloader
- 本地检查提交：`a6a132beecbd216a8b08e032ad08eacf4c0ec24d`
- 许可：MIT。
- 实际阅读：README、`content/page-bridge.js`、`content/shared.js` 和内容脚本中的面板/配置逻辑。
- 检查时提交历史很短，不能称为经过长期验证的成熟产品。

**有用经验**：浮动面板可把用户选择、过滤、数量、并发、暂停放在站点内；作品卡片不一定有 `<a>`，但已挂载 Vue 组件的 artwork props/已加载 artworks 列表可能含真实作品 ID。

**本版独立实现**：`extension/adapter.js` 在已挂载作品卡片和有限祖先组件中读取作品 ID；只返回 ID 对应的公共详情链接。已加载列表可一次发现多项，避免逐卡点击往返。找不到可用 ID 时才回退普通点击。控件是独立设计的扩展来源 iframe，嵌入站点的闭合 ShadowRoot。

**没有照搬**：全站 fetch/XHR JSON 拦截、主动调用详情 API 补全、广泛扫描应用状态，以及剥离图片后缀猜原图。没有复制该仓库的源文件。

## 2. Mihuashi/virtual-waterfall-list

- 仓库：https://github.com/Mihuashi/virtual-waterfall-list
- 本地检查提交：`f8b38238097232d74893ff1e50e911d207aaccd8`
- 实际阅读：README，特别是 `nowItems` 可视区域数据和绝对定位示例。

**影响**：虚拟列表会移除视口外卡片。因此“当前 DOM 数量没有增加”不等于没有新作品，“到底一次”也不能证明懒加载完成。本版累计存储已发现 ID；探测实际滚动容器；监测加载和静默时长；补扫不清空已发现记录。

**边界**：这是对虚拟化机制的证据，不是当前生产米画师页面一定使用该版本组件的证据。

## 3. xuejianxianzun/PixivBatchDownloader

- 仓库：https://github.com/xuejianxianzun/PixivBatchDownloader
- 许可：GPL-3.0。
- 实际经 GitHub 文件树和 raw 文件读取：
  - `src/ts/download/Resume.ts` 的已返回部分：任务数据与状态分离、状态检查点、分块保存及串行保存链。
  - `src/ts/setting/CrawlNumber.ts`：明确的数量输入、边界、设置保存与重置。
  - `src/ts/setting/SettingsPanelShell.ts` 的已返回部分：站内设置壳、分区、下载摘要与开始/暂停操作。

**采用设计原则而非代码**：明确数量上限、持久任务/文件状态、页内分区控制。MHS 的恢复必须额外服从“默认不自动启动”，没有照搬其恢复触发行为。没有复制 GPL 源代码、模板或样式。

## 4. JoeanAmier/XHS-Downloader

- 仓库：https://github.com/JoeanAmier/XHS-Downloader
- 许可：GPL；原任务阶段已克隆和查看相关流程。
- 参考方向：浏览器与本机职责分离、批量队列、数量/图片序号配置、持久历史。
- 没有复制 GPL 下载实现，也没有引入关闭 TLS 校验或不校验 Range 就追加的做法。

用户提供的项目名链接指向这个参考仓库，**不意味着 MHS-Downloader 已发布到该地址，也不意味着获得了其官方背书**。

## 5. Tera-Dark/artwork-archive / 已交付 Hybrid

- 原始仓库：https://github.com/Tera-Dark/artwork-archive
- 原任务阶段检查提交：`d5a0a12e6c3d27e5e3094a65df209115223cfd12`
- MIT；保留许可与署名。
- 0.8.0 继承已交付 Hybrid 0.7.1 的 SQLite/Range 校验/原子保存/导出基础；删除旧独立控制台和旧队列策略重复实现，加入新的执行策略与页内 UI。

## 本版没有宣称的结果

- 没有使用你的登录 Cookie 或访问你的私人作品。
- 没有对真实米画师站点做 91 幅完整性验收或真实吞吐量基准。
- 合成页面的 14→91 测试验证恢复逻辑和真实扩展传输，不证明线上 DOM 永远兼容。
- Windows BAT 经过结构检查，尚未在 Windows 执行；Linux Chromium 不等于 Windows Chrome 实测。
