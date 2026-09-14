# 准备提交 GitHub

## 应当使用哪个文件夹

- `artwork-archive/` 是源码仓库根目录，包含 README、LICENSE、extension、docs、tests、tools 和 .github。
- `extension/` 是浏览器“加载已解压的扩展程序”时要选择的目录。
- `artifacts/` 是本机生成结果，已经忽略，不提交 Git。
- 不要对包含真实实验图片、旧下载记录或其他项目的整个工作区执行 `git add .`。

安装包只用于加载扩展；GitHub 源码包额外包含文档、图标源文件和测试。源码 ZIP 解压后只有一层 `artwork-archive/`，请进入该目录建立仓库。

## 初次提交

本交付没有代为创建远程仓库、添加远程地址或推送。可以在源码根目录执行：

```bash
git init -b main
git add .
git status --short
git diff --cached --stat
```

**先检查暂存列表。** 不应出现作品图片、任务备份、Cookie、证书、下载目录、浏览器用户目录或个人备注。`docs/images/` 内的图标和模拟界面图是项目文档资源，可以提交。`.gitignore` 和源码导出工具是防误收措施，不是通用秘密扫描器。

确认后：

```bash
git commit -m "Initial public source for Artwork Archive 0.6.0"
```

在 GitHub 创建空仓库后，按 GitHub 给出的实际地址配置 `origin` 并推送；不要把示例账号当成真实远程地址。推送后到 Actions 检查轻量 CI；浏览器回归需在 Actions 中手动运行工作流。

## 导出一份不含本机产物的源码 ZIP

```bash
python tools/source_bundle.py
```

生成：

- `artifacts/artwork-archive-github.zip`
- `artifacts/artwork-archive-github.zip.sha256`
- `artifacts/source-inventory.json`：所收录源码文件及其 SHA-256。

工具仅允许指定顶层目录和文件进入导出，排除产物、依赖、常见私有数据目录和缓存，并拒绝证书、私钥、日志、嵌套 ZIP、环境文件及符号链接。仍应人工核对新加入的文件内容，特别是截图与 JSON。

## 日常维护

- 提交可维护的 SVG 和同步生成的 PNG，不只保留某个尺寸的位图。
- 用户指南和隐私说明修改后，重新生成扩展内离线 HTML 并格式化。
- 功能改动补测试、更新 CHANGELOG，权限变化应同步更新隐私说明。
- Issue / PR 模板已提供。反馈优先使用诊断白名单，不要求公开完整任务备份。
- 不在源码中存放发布账号、签名密钥或登录凭据。

详细命令见 [开发指南](development.md)，实际验证边界见 [验证记录](verification.md)。
