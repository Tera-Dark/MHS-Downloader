# 来源与许可证

## 基线代码

- Artwork Archive: https://github.com/Tera-Dark/artwork-archive
- 审阅提交：`d5a0a12e6c3d27e5e3094a65df209115223cfd12`（0.6.0）
- 许可证：MIT，原许可证保存在根目录 `LICENSE`。
- 本混合版复用其 `extension/scanner.js`、`extension/core-policy.js` 与四个图标。
- 新的混合版调度、页面面板、控制台、本机引擎、测试与文档为本次新实现，按 MIT 提供。

## 设计参考，没有复制其实现代码

- XHS-Downloader: https://github.com/JoeanAmier/XHS-Downloader
- 审阅提交：`47840a1bee8438324ff10753c4291148c46071c8`
- 许可证：GPL-3.0，见其 LICENSE。
- 参考异步有限并发、请求会话复用、本机下载记录、临时文件续传和浏览器推送本机任务的设计。
- **本项目不包含 XHS-Downloader 的 Python 源码、签名实现、接口适配或素材。** 不将 GPL 源码直接混入原 MIT 扩展。如果未来复制其受版权保护的实现，应另行审查 GPL 分发及源码提供义务。

## 运行依赖（首次启动通过 pip 安装，不在此源码包中捆绑）

- requests: https://github.com/psf/requests ，Apache-2.0。
- Pillow: https://github.com/python-pillow/Pillow ，许可证详见其 LICENSE（HPND 等相关声明）。
- Python 标准库：SQLite、HTTPServer、zipfile 等。

软件许可不授予米画师作品的复制、再发布或商业使用许可。
