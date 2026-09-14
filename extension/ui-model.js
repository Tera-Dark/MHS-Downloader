// Pure UI rules shared by the workbench and Node tests. No browser or network access.
(function (root) {
  const PRESETS = {
    recommended: { label: '省心推荐', interval: 2, concurrency: 2, volumeMB: 128 },
    gentle: { label: '慢速轻量', interval: 5, concurrency: 1, volumeMB: 64 },
    faster: { label: '较快处理', interval: 1, concurrency: 3, volumeMB: 128 },
  };
  function parseInput(value) {
    const text = String(value || '').trim();
    const candidates =
      text.match(/(?<![\w.@/\-])(?:https?:\/\/)?(?:www\.)?mihuashi\.com\/[^\s<>"\]\)]+/gi) || [];
    const profiles = new Set(),
      artworks = new Set();
    for (let raw of candidates) {
      raw = raw.replace(/[，。；,;.]+$/g, '');
      if (!/^https?:/i.test(raw)) raw = 'https://' + raw;
      try {
        const u = new URL(raw);
        if (
          u.username ||
          u.password ||
          u.port ||
          !['mihuashi.com', 'www.mihuashi.com'].includes(u.hostname)
        )
          continue;
        const path = u.pathname.replace(/\/$/, '');
        const url = 'https://www.mihuashi.com' + path;
        if (/^\/artworks\/\d+$/.test(path)) artworks.add(url);
        else if (/^\/(profiles\/\d+|users\/[^/]+)$/.test(path)) profiles.add(url);
      } catch {}
    }
    return { profiles: [...profiles], artworks: [...artworks] };
  }
  function presetFor(c) {
    return (
      Object.keys(PRESETS).find((k) =>
        ['interval', 'concurrency', 'volumeMB'].every((p) => Number(c[p]) === PRESETS[k][p]),
      ) || 'custom'
    );
  }
  function classifyError(error) {
    const text = String(error?.message || error || '');
    if (/HTTP\s*401\b|登录|验证码|安全验证|验证弹窗/.test(text))
      return {
        code: 'AUTH',
        title: '请先在官网完成登录或验证',
        advice:
          '点击“查看任务网页”，在官网自行处理。回到这里重置未完成项，再手动继续；不要发送密码或 Cookie。',
      };
    if (/HTTP\s*403\b/.test(text))
      return {
        code: 'HTTP_403',
        title: '网站暂时拒绝了访问',
        advice:
          '先检查官网是否能正常打开。登录不一定能解决 403；若仍受限，请停止请求并确认平台允许的访问方式。不要连续重试。',
      };
    if (/HTTP\s*429\b/.test(text))
      return {
        code: 'HTTP_429',
        title: '网站提示访问过于频繁',
        advice: '本轮已停止。请等待网站恢复并检查提示；之后可选择“慢速轻量”，再手动重置任务。',
      };
    if (/所选网页|下拉框/.test(text))
      return {
        code: 'PAGE_SELECTION',
        title: '请先选择有效的官网页面',
        advice:
          '请打开主页，刷新下拉列表再选择。若已经粘贴主页链接，可以直接收集，不必再点“使用所选页面”。',
      };
    if (/预期地址|后退|滚动位置|离开主页/.test(text))
      return {
        code: 'NAVIGATION',
        title: '扫描页面没有正确返回主页',
        advice:
          '已找到的作品链接会保留。这不等于未登录；请检查任务网页、确认主页链接，并在停止后手动继续。',
      };
    if (/许可|使用范围/.test(text))
      return {
        code: 'CONSENT',
        title: '开始前，请确认本次使用范围',
        advice: '勾选链接输入框下方的确认项。公开可见不等于获得使用授权。',
      };
    if (/手动停止|手动暂停/.test(text))
      return {
        code: 'PAUSED',
        title: '本轮已停止',
        advice:
          '已保存文件不受影响。当前工作台若还有 ZIP 缓冲，可点击“保存已缓冲 ZIP”。关闭工作台会丢失未保存缓冲。',
      };
    if (/缓冲/.test(text))
      return {
        code: 'BUFFER',
        title: '先处理上次还没保存的图片',
        advice: '选择“保存已缓冲 ZIP”，或明确丢弃缓冲，再开始新的任务。',
      };
    if (/quota|QUOTA|空间不足|存储容量/i.test(text))
      return {
        code: 'STORAGE',
        title: '本地记录空间可能不足',
        advice:
          '先导出任务与来源，再清理不再需要的记录。不要直接卸载扩展，以免丢失尚未导出的记录。',
      };
    if (/没有待处理|没有需要|已处理过/.test(text))
      return {
        code: 'EMPTY',
        title: '暂时没有可继续处理的作品',
        advice: '成功项会自动跳过。若有失败项，请先检查官网，再点击该项“重置”或“重置未完成项”。',
      };
    if (/候选|合格|大图|作品列表|未找到/.test(text))
      return {
        code: 'NO_IMAGE',
        title: '暂时没找到可保存的作品图片',
        advice:
          '在任务网页确认作品已加载，可尝试手动打开大图。特殊图集或改版页面可能不支持；请保留诊断信息反馈。',
      };
    if (/下载中断|下载响应|下载记录|下载超过|USER_CANCELED/.test(text))
      return {
        code: 'DOWNLOAD',
        title: '浏览器没有完成保存',
        advice:
          '查看浏览器下载记录，检查拦截提示和磁盘空间。文件确认可用前，工具不会把任务算作成功。',
      };
    if (/fetch|network|网络|连接|timeout|超时|45 秒|25 秒/i.test(text))
      return {
        code: 'NETWORK',
        title: '连接没有顺利完成',
        advice:
          '检查网络和官网是否可访问。若只有 ZIP 直连失败，可人工确认后改为“逐张下载”，不会自动切换或重试。',
      };
    return {
      code: 'OTHER',
      title: '这一步暂时没有完成',
      advice: '查看下方详细原因。可先打开任务网页检查，或复制不含作品链接和备注的诊断信息反馈。',
    };
  }
  function filterTasks(tasks, filter = 'all', query = '') {
    const q = String(query).trim().toLowerCase();
    return tasks.filter((t) => {
      const pass =
        filter === 'all' ||
        (filter === 'pending' && ['queued', 'ready'].includes(t.status)) ||
        (filter === 'done' && t.status === 'done') ||
        (filter === 'attention' && ['error', 'staged'].includes(t.status));
      return (
        pass &&
        (!q ||
          [t.id, t.artist, t.url].some((v) =>
            String(v || '')
              .toLowerCase()
              .includes(q),
          ))
      );
    });
  }
  function paginate(items, page = 0, size = 25) {
    size = [25, 50, 100].includes(Number(size)) ? Number(size) : 25;
    const pages = Math.max(1, Math.ceil(items.length / size));
    page = Math.min(Math.max(0, Number(page) || 0), pages - 1);
    return {
      page,
      pages,
      size,
      total: items.length,
      items: items.slice(page * size, (page + 1) * size),
    };
  }
  function diagnostics(state, version, agent = '') {
    const tasks = state.tasks || [],
      counts = {};
    for (const t of tasks) counts[t.status] = (counts[t.status] || 0) + 1;
    return {
      tool: 'Artwork Archive',
      version,
      generated_at: new Date().toISOString(),
      environment: {
        chrome_major: agent.match(/(?:Chrome|Chromium)\/(\d+)/)?.[1] || 'unknown',
        platform: /Windows/.test(agent)
          ? 'Windows'
          : /Macintosh/.test(agent)
            ? 'macOS'
            : /Linux/.test(agent)
              ? 'Linux'
              : 'other',
      },
      task_counts: counts,
      image_records: tasks.reduce((n, t) => n + (t.files || []).length, 0),
      scan_count: (state.scans || []).length,
      recent_error_codes: (state.logs || [])
        .filter((l) => l.error)
        .slice(-10)
        .map((l) => classifyError(l.message).code),
      settings: {
        mode: ['zip', 'native'].includes(state.settings?.mode) ? state.settings.mode : 'unknown',
        interval: Number(state.settings?.interval) || null,
        concurrency: Number(state.settings?.concurrency) || null,
        volumeMB: Number(state.settings?.volumeMB) || null,
      },
      privacy:
        'No artwork URLs, artist names, file paths, authorization notes, image data, cookies or full logs included.',
    };
  }
  function imageLinks(tasks) {
    const links = new Set();
    for (const task of tasks || []) {
      const values = [
        ...(task.candidates || []).filter((c) => c.kind === 'detail_display').map((c) => c.url),
        ...(task.files || []).map((f) => f.image_url),
      ];
      for (const value of values) {
        try {
          const u = new URL(value);
          if (
            u.protocol === 'https:' &&
            !u.username &&
            !u.password &&
            !u.port &&
            ['www.mihuashi.com', 'image-assets.mihuashi.com'].includes(u.hostname) &&
            !/!artwork\.square|!avatar\./.test(u.href)
          )
            links.add(u.href);
        } catch {}
      }
    }
    return [...links];
  }
  root.ArchiveUI = {
    imageLinks,
    PRESETS,
    parseInput,
    presetFor,
    classifyError,
    filterTasks,
    paginate,
    diagnostics,
  };
})(globalThis);
