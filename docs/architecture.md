> **历史架构说明（0.7.0 基线）。0.7.1 已修复 Origin 兼容性、移除许可勾选门槛并增强启动器，具体以 [更新说明](../UPDATE-0.7.1.md) 为准。下文的“未执行真实浏览器验证”是当时状态，不代表 0.7.1 当前验证状态。**

# 米画师归档器优化：代码审阅与混合架构

日期：2026-09-15。针对 Windows + Chrome；基线和参考提交见 THIRD_PARTY.md。

## 结论

优先消除任务对工作台页面生命周期的依赖，然后做持久队列、流水线与错误隔离；不要先无限提高并发，更不要把某个平台的 API 签名照搬到另一个平台。

本次交付是独立 Hybrid 0.7 预览源码包，原仓库保持不变。它已实现新的调度与本机下载路径，但不是实站验收后的正式发行版。

## 1. 原项目问题的代码证据

以下是静态审阅确认的行为，不是从截图猜测的性能实测。

### 工作台关闭就是任务关闭

- [`background.js`](https://github.com/Tera-Dark/artwork-archive/blob/d5a0a12e6c3d27e5e3094a65df209115223cfd12/extension/background.js)：`openManager(false)` 打开后台工作台；`CONTROL_START` 把任务交给工作台。`tabs.onRemoved` 将 `runView.phase` 写成 `closed`。
- [`page-button.js`](https://github.com/Tera-Dark/artwork-archive/blob/d5a0a12e6c3d27e5e3094a65df209115223cfd12/extension/page-button.js)：把 `closed` 映射为截图中的“工作台已关闭，任务未继续”。
- [`lifecycle.js`](https://github.com/Tera-Dark/artwork-archive/blob/d5a0a12e6c3d27e5e3094a65df209115223cfd12/extension/lifecycle.js)：页面离开、freeze、超过 90 秒的调度间隙等会停止任务。

因此后台 Service Worker 原本主要承担启动、转发和状态监测，而非持久任务执行。截图足以与此状态映射对应，但不能证明是谁关闭了工作台，也不能证明站点限流或用户操作是这一次中断的原因。

### 扫描重复导航成本高

- [`scan-service.js`](https://github.com/Tera-Dark/artwork-archive/blob/d5a0a12e6c3d27e5e3094a65df209115223cfd12/extension/scan-service.js)：先滚动收集，再解析缺少 URL 的卡片；扫描完成后才进入下载。
- [`navigation-service.js`](https://github.com/Tera-Dark/artwork-archive/blob/d5a0a12e6c3d27e5e3094a65df209115223cfd12/extension/navigation-service.js)：`resolveCard()` 点击卡片、等待、后退；必要时重开主页并重放滚动。`tabFor()` 共用一个 ownedTab。
- [`task-service.js`](https://github.com/Tera-Dark/artwork-archive/blob/d5a0a12e6c3d27e5e3094a65df209115223cfd12/extension/task-service.js)：详情经 `tabFor()` 和 `waitLoaded()` 获取，候选可复用，但不同阶段的往返仍有成本。

### 部分采集阻挡下载、错误向上传播

- `scanAndMaybeDownload()` 在后台扫描结果为 `partial` 时直接返回，要求工作台确认。
- 详情解析、队列部分处理路径抛出错误后，外层 `operate()` 停止本轮。
- “已收集 12 / 91，下载 0”可以由这种阶段串联和部分完成策略造成，不代表带宽一定差。

### 原项目已经有持久化，不应全部推倒

- [`state-store.js`](https://github.com/Tera-Dark/artwork-archive/blob/d5a0a12e6c3d27e5e3094a65df209115223cfd12/extension/state-store.js)：IndexedDB、增量脏记录、事务提交、任务 URL 索引。
- [`image-service.js`](https://github.com/Tera-Dark/artwork-archive/blob/d5a0a12e6c3d27e5e3094a65df209115223cfd12/extension/image-service.js)：Worker 解码验证与图片暂存提交。
- [`recovery-service.js`](https://github.com/Tera-Dark/artwork-archive/blob/d5a0a12e6c3d27e5e3094a65df209115223cfd12/extension/recovery-service.js)：ZIP 暂存恢复和下载历史核对，但把中断任务改为错误，要求手动检查和重置。

问题不是“完全没保存”，而是缺少独立执行、阶段检查点和安全自动恢复。这个区别决定了不能只增加一个 localStorage 字段就声称解决稳定性。

## 2. 从 XHS-Downloader 借鉴什么，不借鉴什么

| 已观察到的实现 | 本混合版处理 |
|---|---|
| `source/application/download.py`：Semaphore 有界并发；`source/module/static.py` 的 MAX_WORKERS=4 | 本机固定有界下载线程池，默认 3，最大 4；与页面导航节流分开 |
| `source/module/manager.py`：分离并复用请求/下载会话 | 每个下载线程复用 requests.Session，避免跨线程共享可变会话 |
| 下载临时文件 + Range | `.part` + Range/If-Range，额外严格校验 200/206/416 与实体一致性 |
| `source/module/recorder.py`：SQLite 作品 ID、元数据记录 | SQLite WAL 持久化 jobs / works / files / exports / meta，事务领取，成功记录幂等 |
| 浏览器脚本向本地主程序推送任务 | 扩展向配对后的回环 API 提交任务，界面不再拥有下载循环 |
| 下载进度回调与 GUI 队列 | 本机传输字节落盘，控制台轮询展示分阶段进度 |

参考：[download.py](https://github.com/JoeanAmier/XHS-Downloader/blob/47840a1bee8438324ff10753c4291148c46071c8/source/application/download.py)、[manager.py](https://github.com/JoeanAmier/XHS-Downloader/blob/47840a1bee8438324ff10753c4291148c46071c8/source/module/manager.py)、[recorder.py](https://github.com/JoeanAmier/XHS-Downloader/blob/47840a1bee8438324ff10753c4291148c46071c8/source/module/recorder.py)、[tools.py](https://github.com/JoeanAmier/XHS-Downloader/blob/47840a1bee8438324ff10753c4291148c46071c8/source/module/tools.py)、[GUI/backend.py](https://github.com/JoeanAmier/XHS-Downloader/blob/47840a1bee8438324ff10753c4291148c46071c8/source/GUI/backend.py)。

不直接移植的细节：

1. 审阅版本的下载路径根据临时文件长度发 Range，然后用 `ab` 写入；未见完整的 206 区间与 If-Range 实体一致性校验。不能把它当作严格续传的现成证明。
2. 通用 retry 包装按返回值重试，并不是分类指数退避。
3. 部分请求设置 `verify=False`；混合版不关闭 TLS 校验。
4. GUI 的内存任务队列不等于所有阶段都有崩溃恢复检查点。本混合版的持久 jobs/works/files 模型是新实现。
5. 不照搬 100 MiB 的单下载写入缓冲；本版按 256 KiB 读取并流式落盘。
6. 不复制小红书接口、签名、Cookie 提取；也不猜测米画师不存在的开放 API。

## 3. 已实现的数据流

```text
官网浮层 / 扩展控制台
           │ 已确认许可 + 主页/作品 URL
           ▼
Chrome Service Worker ────── 本机认证回环 API
  │  无常驻 UI 依赖                   │
  ├─ 列表标签页                       ▼
  │  直接链接优先                 SQLite / WAL
  │  无链接卡片普通点击          jobs / works / files
  │  扫描检查点                每次已提交变更是恢复边界
  └─ 详情标签页                       │
     DOM 候选 + 已加载详情复用          ▼
                               3 路本机下载线程
                               Session / 退避 / Range
                                      │
                                      ▼
                                .part → 校验 → images
                                      │
                                      ▼
                               独立 ZIP 快照导出线程
```

扩展 `setTimeout` 只用于活跃期快速调度，不是持久任务状态；回收后由 Chrome alarms / 浏览器启动事件恢复。这里没有用 offscreen 文档或静默音频伪造无限常驻。

### 浏览器侧

- `hybrid-worker.js`：列表和详情交替推进，避免其中一阶段饿死。
- 原页面适配器依旧使用公开 DOM；直接链接无需卡片往返。
- 若普通点击已打开详情，尝试复用已加载详情图片，减少再次访问。
- 每次新增链接先事务写入本机，再继续滚动/点击。
- 无链接点击的意图先写检查点，重启后优先核对已发生导航，而不是盲目重放点击。
- 仅自动任务标签页设置 `autoDiscardable: false`；检测到已丢弃页时尝试重载。它不是操作系统休眠或浏览器退出后的运行保证。
- 未解决卡片、长时间页面变化或滚动恢复失败均有边界，标为 partial 并允许补扫。

### 本机侧

- `jobs`：来源、许可确认时间、模式、暂停状态、扫描检查点与页面标示数量。
- `works`：作品 URL 幂等键、解析状态、重试次数、下次重试时间。
- `files`：任务/作品/图片序号唯一键、真实观察 URL、字节数、validator、内容哈希和路径。
- `exports`：异步快照导出状态。
- `meta`：全局访问暂停、本机配对来源、浏览器心跳。
- 领取下载使用 `BEGIN IMMEDIATE` 事务，避免同一个文件被多个下载线程同时领取。
- 程序重启将 `downloading` 回到 retry，实际 `.part` 长度而非 UI 数值是续传依据。
- 文件下载成功和导出成功分开统计；仅已提交任务的下载能在 Chrome 退出后继续。

## 4. 当前交付与尚未交付

### 已实现

- 与控制台生命周期解耦的浏览器调度和本机下载。
- 检查点、持久任务队列、边扫描边下载。
- 单项错误隔离、有限退避、访问暂停。
- 严格条件续传、格式与尺寸校验、URL/内容去重。
- 缺失/失效链接的显式重新解析入口。
- 成功图片流式打包 ZIP、来源清单、直链 TXT。
- Windows 启动脚本、新扩展控制台与响应式官网面板。

### 没有声称完成

- 米画师登录实站的字段/卡片全覆盖，以及真实速度与成功率对比。
- Windows 原生 EXE、自动启动托盘服务、Chrome 商店签名发布。
- 旧扩展 IndexedDB 的自动迁移。
- 浏览器关闭之后仍自动解析新的米画师页面。
- 私有接口、隐藏应用状态或网络响应捕获适配；当前不依赖这些尚未验证的机制。
- 系统休眠期间保持网络下载。
- 所有受保护的 CDN 地址都能无 Cookie 在本机下载。

## 5. 下一步优先级

1. **P0 实站采样**：以用户已获许可的 10 / 50 / 91 件作品主页分别验证卡片结构、懒加载、详情候选。对照来源清单，不只看 UI 完成数。
2. **P0 Windows / Chrome 故障验收**：关闭控制台、手动回收 SW、重启 Chrome、网络中断、本机程序重启、磁盘不足；不得误报成功或重复拼接字节。
3. **P1 提高列表发现效率**：若页面有可合法使用、正常加载的结构化作品数据，基于已脱敏样本添加可版本化适配器；验证后再替代部分 DOM 点击。不能在没有样本时编造接口 URL。
4. **P1 旧数据迁移**：显式导入旧来源清单，核验本地已有文件，成功后才继承完成状态。
5. **P1 运行体验**：打包 Windows 托盘程序、退出确认、存储空间提示、任务过滤和分页；最终可由一个安装器处理依赖和扩展配对。
6. **P2 大规模队列**：图片级事件日志、任务租约/多采集器所有权、同 URL 在途下载合并、更细的域级限流与失败指标。

## 6. 如何评价提速

建议在相同账号、同一已获许可作品集、相同网络环境分别记录：

- 从点击开始到第一张图片成功落盘的时间。
- 总发现 / 解析 / 下载耗时，分别统计。
- 页面完整导航次数与未解决卡片数。
- 实际保存图片数、总字节数、重复传输字节数。
- 网络错误后的恢复次数与成功率。
- 控制台关闭后 60 秒内队列推进情况。
- 整体与失败路径峰值内存、磁盘暂存、CPU。

合理预期是更早出现首张图片、减少部分重复页面访问、普通失败不再停止整批；在实站基准完成前，不宣称“快 5 倍”“100% 不断”或“91/91 必定全部下载”。
