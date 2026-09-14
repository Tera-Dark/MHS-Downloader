'use strict';
const App = {
  state: { tasks: [], logs: [], scans: [], archives: [], settings: {} },
  run: {
    busy: false,
    stop: false,
    fatal: null,
    ownedTab: null,
    lastNavigate: 0,
    C: null,
    saveChain: Promise.resolve(),
    inboxBusy: false,
    initialized: false,
    stateLoaded: false,
    managerTabId: null,
    remoteStarting: false,
    runPhase: 'idle',
    viewChain: Promise.resolve(),
    accessHold: null,
    storageFault: false,
    operationStarting: false,
    runStamp: '',
  },
  store: new ArchiveStateStore(),
  api: {},
  $: (id) => document.getElementById(id),
  version: chrome.runtime.getManifest().version,
  configKeys: [
    'profile',
    'artist',
    'mode',
    'selection',
    'interval',
    'concurrency',
    'maxWorks',
    'volumeMB',
    'folder',
    'note',
  ],
  labels: {
    queued: '等待处理',
    reading: '读取页面',
    ready: '预览就绪',
    downloading: '正在下载',
    staged: '已取图 · 待保存 ZIP',
    done: '已完成',
    error: '已停止 / 需检查',
  },
  delay: (ms) => new Promise((r) => setTimeout(r, ms)),
  Paused: class extends Error {
    constructor(message = '已手动停止本轮') {
      super(message);
    }
  },
  NavigationMismatch: class extends Error {},
};
for (const name of [
  'view-service',
  'task-service',
  'run-service',
  'navigation-service',
  'scan-service',
  'download-service',
  'recovery-service',
])
  Object.assign(App.api, ArchiveServices[name](App));
App.images = new ArchiveImageService(App.store);
App.lifecycle = new ArchiveLifecycle((message) => {
  App.run.stop = true;
  App.run.fatal = new Error(message);
  App.api.abortFetches();
  App.state.recovery = { at: new Date().toISOString(), message };
  App.api.status(message);
  App.api.log(message, true);
});
ArchiveController(App);
ArchiveWorkbenchUI(App);
