# 开发与发布指南

## 环境分层

- 扩展运行：桌面 Chrome / Edge，Manifest V3；不需要 Python / Node。
- 静态检查、单元测试、格式化：Node.js 20+。`npm ci` 安装固定版本的 Prettier，不增加扩展运行时依赖。
- 打包、生成帮助页：Python 3.10+，只用标准库。
- 浏览器回归：建议 Linux / WSL，需 OpenSSL、Playwright 和 Pillow。测试不应使用真实浏览器用户目录。
- 绘制图标：可选 CairoSVG + Pillow，见 design/README.md。

## 开发加载

到 `chrome://extensions` 选择本仓库的 `extension/`。修改文件后，在扩展管理页点重新加载，再刷新工作台和官网页面。

工作台使用普通脚本及明确的共享状态，不使用打包器或远程模块。核心采集逻辑与 UI 分开，但并非完全解耦；修改状态字段时需要同时检查核心和呈现层。

## 代码检查

```bash
npm ci
npm run check
npm test
npm run format:check
python -m unittest discover -s tests/packaging
```

`check` 验证版本一致性、清单、入口文件、权限白名单、JS 语法、PNG 尺寸、禁止远程脚本及测试配置边界。它不是完整安全审计。

单元测试涵盖链接识别、预设、错误分类、分页、诊断隐私白名单、ZIP 路径约束、CRC 和 UTF-8 条目。

Python 格式化为可选开发步骤：

```bash
python -m pip install -r requirements-format.txt
python -m black --check tools tests
# 需要修正时去掉 --check
```

## 浏览器测试

```bash
python -m pip install -r requirements-dev.txt
python -m playwright install --with-deps chromium
python tests/e2e/run.py
```

输出在 `artifacts/browser-tests/`，已被 Git 忽略。浏览器配置、证书和下载缓存在临时目录中创建并清理。测试图片由代码生成，不包含真实画师图像。

测试使用本机 HTTPS 服务，以及**仅测试浏览器**的域名映射与测试证书参数。这些内容不得复制进发行扩展。测试没有关闭 Chromium 的常规弹窗阻止，以验证卡片导航捕获的正常行为。

分卷测试会在测试运行时临时降低内存阈值，便于覆盖边界分支；发行配置依然有 64 MB 下限。它不是 256 MB、多小时任务的压力测试。

可以验证打包后解压出的目录：

```bash
AA_EXT=/absolute/path/to/extracted-extension python tests/e2e/run.py
```

该写法是 POSIX 环境变量语法。测试已验证的环境为 Linux Chromium；不要把它描述成对 Windows 文件管理器或所有 Edge 版本的验证。

## 文档与图标

用户指南和隐私文档的源文件在 `docs/`。修改后：

```bash
python tools/render_docs.py
npm run format
```

生成 `extension/help.html` 和 `extension/privacy.html`。帮助页完全离线，没有远程资源或执行脚本。

图标的可选生成命令见 `design/README.md`。提交 SVG 改动时应同步提交 PNG 和预览图，不应在运行时从外部服务生成图标。

## 打包

```bash
python tools/package.py
```

- 只收集 `extension/` 的发行文件及根目录 LICENSE。
- ZIP 根目录直接包含 manifest.json，不再包一层文件夹。
- 固定条目时间、排序与权限元数据，使相同源文件产生相同 ZIP。
- 自动校验文件齐全、CRC、根目录结构，并输出 `.zip.sha256`。
- 不包括测试、证书、浏览器参数、截图、node_modules、实验样本或工作台记录。

也可用 `--output` 指定输出 ZIP 路径。

## 发版核对

1. 同步 `package.json`、`extension/manifest.json` 和必要的 UI / 文档版本标记。
2. 更新 CHANGELOG，核对新增权限和数据行为。
3. 运行文档生成、格式检查、静态检查与单元测试。
4. 打包，在新目录解压，并用该目录跑浏览器回归。
5. 保留校验值及测试范围说明；不要把模拟测试说成实站通过。
6. 如有权限或网站行为变化，在获得许可的实际使用环境中做小批量验收。
7. 提醒使用者先备份，再升级或更换开发版目录。

工作流只生成构建产物，不自动提交到商店，也不自动上传用户内容。首次推送 GitHub 后可在 Actions 查看检查结果；这里没有代用户创建远程仓库或推送。

源码导出与首次提交步骤见 [GitHub 仓库准备指南](repository.md)。

## 0.6.0 持久层回归

新增场景直接检查真实 IndexedDB，不为旧测试保留 `stateV2` 双写。使用原生事务 abort 注入中止，不在扩展中提供测试开关。API 成功/ID 未落盘场景会实际启动浏览器下载后悬停 API 返回，再关闭并重开工作台。

Playwright 默认将下载文件名改成 GUID；严格文件名归属场景临时恢复浏览器默认下载行为，使用临时 profile 的下载目录，随后恢复测试拦截。没有为了测试放宽发行包的归属规则。

休眠测试通过修改生命周期时钟基线注入长间隔，不代表真实 Windows 系统睡眠测试。24 MP JPEG 和 Worker 并发测试验证尺寸、字节哈希及串行性，不将 JS 堆或分卷阈值冒充浏览器进程 RSS 上限。5000 队列测试的耗时和写入计数保存在结果 JSON。
