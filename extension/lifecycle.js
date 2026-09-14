// Browser suspension is not a background-execution guarantee. A long scheduling gap is a stop.
class ArchiveLifecycle {
  constructor(interrupt) {
    this.interrupt = interrupt;
    this.active = false;
    this.lastWall = Date.now();
    this.lastMono = performance.now();
    setInterval(() => this.check(), 10000);
    document.addEventListener('freeze', () =>
      this.pause('工作台被冻结，已停止调度；恢复后请人工继续'),
    );
    window.addEventListener('pagehide', () =>
      this.pause('工作台已关闭或离开，任务已停止；已提交的图片暂存可恢复'),
    );
    document.addEventListener('visibilitychange', () => this.check());
  }
  start() {
    this.lastWall = Date.now();
    this.lastMono = performance.now();
    this.active = true;
  }
  finish() {
    this.active = false;
  }
  pause(message) {
    if (!this.active) return;
    this.active = false;
    this.interrupt(message);
  }
  check() {
    const wall = Date.now(),
      mono = performance.now();
    if (
      this.active &&
      (wall - this.lastWall > 90000 || mono - this.lastMono > 90000 || wall < this.lastWall - 5000)
    )
      this.pause(
        '检测到休眠、时钟跳变或超过 90 秒的后台节流，已停止本轮。已验证图片保留在本地暂存；检查官网后再手动继续，不会自动重试。',
      );
    this.lastWall = wall;
    this.lastMono = mono;
  }
}
