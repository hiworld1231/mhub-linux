import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import WebSocket from 'ws';

const args = process.argv.slice(2);

function argValue(name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

const mainPort = Number(argValue('--main-port', '9229'));
const rendererPort = Number(argValue('--renderer-port', '9222'));
const fontDir = argValue('--font-dir', '');
const audioShim = !args.includes('--no-audio-shim');
const startupTimeoutMs = Number(argValue('--startup-timeout-ms', '60000'));

function log(message) {
  process.stdout.write(`[${new Date().toISOString()}] ${message}\n`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1200);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

class CDPClient {
  constructor(url) {
    this.url = url;
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
  }

  async connect() {
    this.ws = new WebSocket(this.url, { maxPayload: 64 * 1024 * 1024 });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('WebSocket connect timeout')), 5000);
      this.ws.once('open', () => {
        clearTimeout(timer);
        resolve();
      });
      this.ws.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });

    this.ws.on('message', (raw) => {
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        return;
      }

      if (!message.id || !this.pending.has(message.id)) return;
      const entry = this.pending.get(message.id);
      this.pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) entry.reject(new Error(message.error.message || JSON.stringify(message.error)));
      else entry.resolve(message.result);
    });

    this.ws.on('close', () => {
      for (const [, entry] of this.pending) {
        clearTimeout(entry.timer);
        entry.reject(new Error('Inspector connection closed'));
      }
      this.pending.clear();
    });
  }

  command(method, params = {}, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression, awaitPromise = false, timeoutMs = 30000) {
    const response = await this.command(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise },
      timeoutMs,
    );
    const value = response?.result;
    if (value?.subtype === 'error') throw new Error(value.description || 'Runtime.evaluate failed');
    return value?.value;
  }

  close() {
    try { this.ws?.close(); } catch {}
  }
}

function mainRuntimePatch(enableAudioShim) {
  const result = { audioShim: 'disabled', windowPatch: 'already-installed' };

  if (enableAudioShim && !globalThis.__mhubLinuxAudioHookInstalled) {
    const cp = process.getBuiltinModule('child_process');
    const proto = cp.ChildProcess && cp.ChildProcess.prototype;
    const originalSpawn = proto && proto.spawn;

    if (typeof originalSpawn === 'function') {
      function rewrite(value, seen = new Set()) {
        if (!value || typeof value !== 'object' || seen.has(value)) return false;
        seen.add(value);
        let changed = false;
        try {
          if (value.sdkType === 'cmedia_2025') {
            value.sdkType = 'fake';
            changed = true;
          }
          for (const key of Object.keys(value)) {
            if (rewrite(value[key], seen)) changed = true;
          }
        } catch {}
        return changed;
      }

      function wrapSend(child) {
        if (!child || child.__mhubLinuxSendWrapped || typeof child.send !== 'function') return;
        const originalSend = child.send;
        child.send = function(message, ...rest) {
          if (rewrite(message)) console.log('[mhub-linux] rewrote audio worker sdkType: cmedia_2025 -> fake');
          return originalSend.call(this, message, ...rest);
        };
        child.__mhubLinuxSendWrapped = true;
      }

      proto.spawn = function(options) {
        const spawnResult = originalSpawn.call(this, options);
        wrapSend(this);
        return spawnResult;
      };

      const originalFork = cp.fork;
      if (typeof originalFork === 'function') {
        cp.fork = function(...forkArgs) {
          const child = originalFork.apply(this, forkArgs);
          wrapSend(child);
          return child;
        };
      }

      globalThis.__mhubLinuxAudioHookInstalled = true;
      result.audioShim = 'installed';
    } else {
      result.audioShim = 'spawn-unavailable';
    }
  } else if (enableAudioShim) {
    result.audioShim = 'already-installed';
  }

  if (!globalThis.__mhubLinuxElectronWindowPatchInstalled) {
    try {
      const Module = process.getBuiltinModule('module');
      const originalLoad = Module._load;
      const proxyCache = new WeakMap();

      function positionNearCursor(win, electron) {
        try {
          const screen = electron && electron.screen;
          if (!screen || typeof screen.getCursorScreenPoint !== 'function') return false;
          const point = screen.getCursorScreenPoint();
          const display = typeof screen.getDisplayNearestPoint === 'function'
            ? screen.getDisplayNearestPoint(point)
            : null;
          const area = (display && (display.workArea || display.bounds)) || null;
          if (!area) return false;

          const bounds = win.getBounds();
          const gap = 10;
          const rightHalf = point.x >= area.x + area.width / 2;
          const bottomHalf = point.y >= area.y + area.height / 2;
          let x = rightHalf ? point.x - bounds.width - gap : point.x + gap;
          let y = bottomHalf ? point.y - bounds.height - gap : point.y + gap;
          x = Math.max(area.x, Math.min(x, area.x + area.width - bounds.width));
          y = Math.max(area.y, Math.min(y, area.y + area.height - bounds.height));

          const setter = win.__mhubLinuxOriginalSetPosition || win.setPosition.bind(win);
          setter(Math.round(x), Math.round(y), false);
          return true;
        } catch {
          return false;
        }
      }

      function installTrayBehavior(win, electron) {
        if (!win || win.__mhubLinuxTrayBehaviorInstalled) return;
        win.__mhubLinuxTrayBehaviorInstalled = true;
        win.__mhubLinuxTrayWindow = true;

        try { win.setBackgroundColor('#151515'); } catch {}
        try { if (typeof win.setOpacity === 'function') win.setOpacity(1); } catch {}

        if (typeof win.setPosition === 'function') {
          const originalSetPosition = win.setPosition.bind(win);
          win.__mhubLinuxOriginalSetPosition = originalSetPosition;
          win.setPosition = function(x, y, animate) {
            if (this.__mhubLinuxTrayWindow && Number(x) <= 2 && Number(y) <= 2) {
              if (positionNearCursor(this, electron)) return;
            }
            return originalSetPosition(x, y, animate);
          };
        }

        if (typeof win.show === 'function') {
          const originalShow = win.show.bind(win);
          win.show = function(...showArgs) {
            try { this.setBackgroundColor('#151515'); } catch {}
            positionNearCursor(this, electron);
            const value = originalShow(...showArgs);
            setTimeout(() => positionNearCursor(this, electron), 0);
            return value;
          };
        }

        if (typeof win.showInactive === 'function') {
          const originalShowInactive = win.showInactive.bind(win);
          win.showInactive = function(...showArgs) {
            try { this.setBackgroundColor('#151515'); } catch {}
            positionNearCursor(this, electron);
            const value = originalShowInactive(...showArgs);
            setTimeout(() => positionNearCursor(this, electron), 0);
            return value;
          };
        }

        try {
          win.on('show', () => {
            setTimeout(() => positionNearCursor(win, electron), 0);
            setTimeout(() => positionNearCursor(win, electron), 50);
          });
        } catch {}
      }

      function patchElectron(electron) {
        if (!electron || (typeof electron !== 'object' && typeof electron !== 'function')) return electron;
        if (proxyCache.has(electron)) return proxyCache.get(electron);

        const OriginalBrowserWindow = electron.BrowserWindow;
        if (typeof OriginalBrowserWindow !== 'function') return electron;

        class BrowserWindowCompat extends OriginalBrowserWindow {
          constructor(options = {}) {
            const source = options && typeof options === 'object' ? options : {};
            const width = Number(source.width) || 0;
            const height = Number(source.height) || 0;
            const compact = (!width || width <= 600) && (!height || height <= 600);
            const likelyTray = source.transparent === true && compact;
            const next = { ...source };

            if (likelyTray) {
              next.transparent = false;
              next.backgroundColor = '#151515';
            }

            super(next);
            if (likelyTray) installTrayBehavior(this, electron);

            try {
              this.webContents.on('did-finish-load', () => {
                let url = '';
                try { url = this.webContents.getURL(); } catch {}
                if (/\/tray\.html(?:$|[?#])/.test(url)) installTrayBehavior(this, electron);
              });
            } catch {}
          }
        }

        const proxy = new Proxy(electron, {
          get(target, prop, receiver) {
            if (prop === 'BrowserWindow') return BrowserWindowCompat;
            return Reflect.get(target, prop, receiver);
          },
        });
        proxyCache.set(electron, proxy);
        return proxy;
      }

      Module._load = function(request, parent, isMain) {
        const exported = originalLoad.call(this, request, parent, isMain);
        return request === 'electron' ? patchElectron(exported) : exported;
      };

      globalThis.__mhubLinuxElectronWindowPatchInstalled = true;
      globalThis.__mhubLinuxOriginalModuleLoad = originalLoad;
      result.windowPatch = 'installed';
    } catch (error) {
      result.windowPatch = `error: ${String(error && (error.stack || error))}`;
    }
  }

  return result;
}

function loadFonts() {
  if (!fontDir) return [];
  const definitions = [
    ['iconfont', '400', 'iconfont.woff2', true],
    ['MiSans', '400', 'MiSans-Regular.woff2', true],
    ['MiSans', '600', 'MiSans-Semibold.woff2', true],
    ['MiSans', '700', 'MiSans-Bold.woff2', true],
    ['Unifont', '400', 'Unifont.ttf', false],
    ['UnifontPixel', '400', 'Rubik-Bold.ttf', false],
  ];

  const fonts = [];
  for (const [family, weight, fileName, required] of definitions) {
    const filePath = path.join(fontDir, fileName);
    if (!fs.existsSync(filePath)) {
      if (required) log(`font missing: ${filePath}`);
      continue;
    }
    fonts.push({ family, weight, b64: fs.readFileSync(filePath).toString('base64') });
  }
  return fonts;
}

async function rendererRuntimePatch(fonts) {
  if (!globalThis.document || !document.documentElement || !document.head) {
    return { status: 'not-ready' };
  }

  const isTray = document.title === 'M HUB - Tray' || /\/tray\.html(?:$|[?#])/.test(location.href);
  const loaded = [];

  if (!globalThis.__mhubLinuxFontsInstalled && Array.isArray(fonts) && fonts.length) {
    function decodeBase64(value) {
      const binary = atob(value);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return bytes.buffer;
    }

    for (const font of fonts) {
      try {
        const face = new FontFace(font.family, decodeBase64(font.b64), {
          weight: font.weight,
          style: 'normal',
        });
        await face.load();
        document.fonts.add(face);
        loaded.push(`${font.family}:${font.weight}`);
      } catch {}
    }
    globalThis.__mhubLinuxFontsInstalled = true;
  }

  function repairIconClasses(root = document) {
    let repaired = 0;
    const nodes = root.querySelectorAll ? root.querySelectorAll('.iconfont') : [];
    for (const el of nodes) {
      for (const name of [...el.classList]) {
        if (/^icon-.*_linea$/.test(name)) {
          const fixed = `${name}r`;
          if (!el.classList.contains(fixed)) {
            el.classList.add(fixed);
            repaired += 1;
          }
        }
      }
    }
    return repaired;
  }

  let style = document.getElementById('mhub-linux-ui-fix');
  if (!style) {
    style = document.createElement('style');
    style.id = 'mhub-linux-ui-fix';
    document.head.appendChild(style);
  }

  style.textContent = `
    .iconfont,
    .iconfont::before,
    .iconfont::after,
    [class^="icon-"],
    [class^="icon-"]::before,
    [class^="icon-"]::after,
    [class*=" icon-"],
    [class*=" icon-"]::before,
    [class*=" icon-"]::after {
      font-family: iconfont !important;
    }

    html, body {
      font-family: MiSans, "PingFang SC", Helvetica, Arial, sans-serif;
      color-scheme: dark;
    }

    ${isTray ? `
      html, body, #tray-app, .tray-body, .tray-top, .tray-bottom {
        background: #151515 !important;
        background-color: #151515 !important;
        color-scheme: dark !important;
      }
    ` : ''}
  `;

  const repaired = repairIconClasses(document);

  if (!globalThis.__mhubLinuxUiObserver) {
    globalThis.__mhubLinuxUiObserver = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node && node.nodeType === 1) repairIconClasses(node);
        }
      }
    });
    globalThis.__mhubLinuxUiObserver.observe(document.documentElement, { childList: true, subtree: true });
  }

  const failureText = String(document.body?.innerText || '');
  const loadFailed = /Загрузка не удалась|Load failed|Failed to load|加载失败|載入失敗/i.test(failureText);
  let retry = null;

  if (loadFailed && !globalThis.__mhubLinuxReloadScheduled) {
    const key = 'mhub-linux-network-retry';
    let count = 0;
    try { count = Number(sessionStorage.getItem(key) || '0') || 0; } catch {}
    if (count < 4) {
      const delays = [1200, 2500, 5000, 9000];
      const delay = delays[Math.min(count, delays.length - 1)];
      try { sessionStorage.setItem(key, String(count + 1)); } catch {}
      globalThis.__mhubLinuxReloadScheduled = true;
      retry = { attempt: count + 1, delay };
      setTimeout(() => location.reload(), delay);
    }
  } else if (!loadFailed) {
    setTimeout(() => {
      try { sessionStorage.removeItem('mhub-linux-network-retry'); } catch {}
    }, 10000);
  }

  return {
    status: 'patched',
    title: document.title,
    isTray,
    repairedIconClasses: repaired,
    loadedFonts: loaded,
    loadFailed,
    retry,
  };
}

async function findMainTarget() {
  const list = await fetchJson(`http://127.0.0.1:${mainPort}/json/list`);
  return list.find((item) => item.webSocketDebuggerUrl) || null;
}

async function installMainPatchAndResume(target) {
  const client = new CDPClient(target.webSocketDebuggerUrl);
  await client.connect();
  try {
    await client.command('Runtime.enable');
    const expression = `(${mainRuntimePatch.toString()})(${JSON.stringify(audioShim)})`;
    const result = await client.evaluate(expression, false);
    log(`main compatibility patch: ${JSON.stringify(result)}`);
    await client.command('Runtime.runIfWaitingForDebugger').catch(() => {});
  } finally {
    client.close();
  }
}

async function rendererTargets() {
  const list = await fetchJson(`http://127.0.0.1:${rendererPort}/json/list`);
  return list.filter((item) => {
    if (!['page', 'iframe'].includes(item.type)) return false;
    if (!item.webSocketDebuggerUrl) return false;
    return /mchose/i.test(`${item.title || ''} ${item.url || ''}`);
  });
}

async function patchRendererTarget(target, fonts) {
  const client = new CDPClient(target.webSocketDebuggerUrl);
  await client.connect();
  try {
    await client.command('Runtime.enable');
    const expression = `(${rendererRuntimePatch.toString()})(${JSON.stringify(fonts)})`;
    return await client.evaluate(expression, true, 60000);
  } finally {
    client.close();
  }
}

async function main() {
  log(`bridge starting (main=${mainPort}, renderer=${rendererPort}, audioShim=${audioShim})`);

  const deadline = Date.now() + startupTimeoutMs;
  let mainTarget = null;
  while (Date.now() < deadline) {
    try {
      mainTarget = await findMainTarget();
      if (mainTarget) break;
    } catch {}
    await sleep(100);
  }

  if (!mainTarget) throw new Error(`M HUB main inspector did not appear on port ${mainPort}`);

  try {
    await installMainPatchAndResume(mainTarget);
  } catch (error) {
    log(`main patch failed: ${error.message}`);
    try {
      const rescue = new CDPClient(mainTarget.webSocketDebuggerUrl);
      await rescue.connect();
      await rescue.command('Runtime.runIfWaitingForDebugger').catch(() => {});
      rescue.close();
    } catch {}
  }

  const fonts = loadFonts();
  if (!fonts.length) log('no local fonts available; renderer font injection disabled');

  let missedMainChecks = 0;
  const reported = new Map();

  while (true) {
    try {
      const current = await findMainTarget();
      missedMainChecks = current ? 0 : missedMainChecks + 1;
    } catch {
      missedMainChecks += 1;
    }

    if (missedMainChecks >= 8) {
      log('M HUB main process is gone; bridge exiting');
      return;
    }

    try {
      const targets = await rendererTargets();
      for (const target of targets) {
        try {
          const result = await patchRendererTarget(target, fonts);
          const signature = JSON.stringify(result);
          if (reported.get(target.id) !== signature) {
            log(`renderer patch: ${target.type} ${target.title || target.url}: ${signature}`);
            reported.set(target.id, signature);
          }
        } catch (error) {
          log(`renderer patch retry for ${target.title || target.url}: ${error.message}`);
        }
      }
    } catch {}

    await sleep(1500);
  }
}

main().catch((error) => {
  log(`fatal: ${error.stack || error}`);
  process.exit(1);
});
