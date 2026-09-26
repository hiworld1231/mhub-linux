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
  const timer = setTimeout(() => controller.abort(), 1000);
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

      if (message.error) {
        entry.reject(new Error(message.error.message || JSON.stringify(message.error)));
      } else {
        entry.resolve(message.result);
      }
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
    const result = await this.command(
      'Runtime.evaluate',
      {
        expression,
        returnByValue: true,
        awaitPromise,
      },
      timeoutMs,
    );

    const value = result?.result;
    if (value?.subtype === 'error') {
      throw new Error(value.description || 'Runtime.evaluate failed');
    }

    return value?.value;
  }

  close() {
    try {
      this.ws?.close();
    } catch {
      // Ignore close races.
    }
  }
}

const audioHookExpression = String.raw`
(() => {
  if (globalThis.__mhubLinuxAudioHookInstalled) return 'already-installed';

  const cp = process.getBuiltinModule('child_process');
  const proto = cp.ChildProcess && cp.ChildProcess.prototype;
  const originalSpawn = proto && proto.spawn;

  if (typeof originalSpawn !== 'function') {
    return 'error: ChildProcess.prototype.spawn unavailable';
  }

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
    if (!child || child.__mhubLinuxSendWrapped) return;
    if (typeof child.send !== 'function') return;

    const originalSend = child.send;
    child.send = function(message, ...rest) {
      if (rewrite(message)) {
        console.log('[mhub-linux] rewrote audio worker sdkType: cmedia_2025 -> fake');
      }
      return originalSend.call(this, message, ...rest);
    };

    child.__mhubLinuxSendWrapped = true;
  }

  proto.spawn = function(options) {
    const result = originalSpawn.call(this, options);
    wrapSend(this);
    return result;
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
  return 'installed';
})()
`;

async function findMainTarget() {
  const list = await fetchJson(`http://127.0.0.1:${mainPort}/json/list`);
  return list.find((item) => item.webSocketDebuggerUrl) || null;
}

async function installMainHookAndResume(target) {
  const client = new CDPClient(target.webSocketDebuggerUrl);
  await client.connect();

  try {
    await client.command('Runtime.enable');

    if (audioShim) {
      const result = await client.evaluate(audioHookExpression, false);
      log(`audio compatibility hook: ${result}`);
    } else {
      log('audio compatibility hook disabled');
    }

    // The launcher uses --inspect-brk so the hook is installed before M HUB's
    // main bundle creates the SDK worker. Always resume even if the shim is off.
    await client.command('Runtime.runIfWaitingForDebugger').catch(() => {});
  } finally {
    client.close();
  }
}

function loadFonts() {
  if (!fontDir) return null;

  const definitions = [
    ['iconfont', '400', 'iconfont.woff2'],
    ['MiSans', '400', 'MiSans-Regular.woff2'],
    ['MiSans', '600', 'MiSans-Semibold.woff2'],
    ['MiSans', '700', 'MiSans-Bold.woff2'],
  ];

  const fonts = [];
  for (const [family, weight, fileName] of definitions) {
    const filePath = path.join(fontDir, fileName);
    if (!fs.existsSync(filePath)) {
      log(`font missing: ${filePath}`);
      return null;
    }

    fonts.push({
      family,
      weight,
      b64: fs.readFileSync(filePath).toString('base64'),
    });
  }

  return fonts;
}

function makeFontInjectionExpression(fonts) {
  return `
(async () => {
  if (globalThis.__mhubLinuxFontsInstalled) return 'already-installed';
  if (!globalThis.document || !document.head) return 'not-ready';

  const fonts = ${JSON.stringify(fonts)};

  function decodeBase64(value) {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
  }

  for (const font of fonts) {
    const face = new FontFace(
      font.family,
      decodeBase64(font.b64),
      { weight: font.weight, style: 'normal' },
    );
    await face.load();
    document.fonts.add(face);
  }

  let style = document.getElementById('mhub-linux-font-fix');
  if (style) style.remove();

  style = document.createElement('style');
  style.id = 'mhub-linux-font-fix';
  style.textContent = \`
    .iconfont,
    [class^="icon-"],
    [class*=" icon-"] {
      font-family: iconfont !important;
    }

    html, body {
      font-family: MiSans, "PingFang SC", Helvetica, Arial, sans-serif;
    }
  \`;
  document.head.appendChild(style);

  await document.fonts.ready;
  globalThis.__mhubLinuxFontsInstalled = true;

  return {
    iconfont: document.fonts.check('16px iconfont'),
    misans400: document.fonts.check('400 16px MiSans'),
    misans600: document.fonts.check('600 16px MiSans'),
    misans700: document.fonts.check('700 16px MiSans'),
  };
})()
`;
}

async function injectFontsIntoTarget(target, fonts) {
  const client = new CDPClient(target.webSocketDebuggerUrl);
  await client.connect();

  try {
    await client.command('Runtime.enable');
    const already = await client.evaluate('globalThis.__mhubLinuxFontsInstalled === true');
    if (already) return false;

    const result = await client.evaluate(makeFontInjectionExpression(fonts), true, 60000);
    if (result === 'not-ready') return false;

    log(`fonts injected: ${target.type} ${target.title || target.url}`);
    return true;
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

async function main() {
  log(`bridge starting (main=${mainPort}, renderer=${rendererPort}, audioShim=${audioShim})`);

  const deadline = Date.now() + startupTimeoutMs;
  let mainTarget = null;

  while (Date.now() < deadline) {
    try {
      mainTarget = await findMainTarget();
      if (mainTarget) break;
    } catch {
      // Inspector is not listening yet.
    }
    await sleep(100);
  }

  if (!mainTarget) {
    throw new Error(`M HUB main inspector did not appear on port ${mainPort}`);
  }

  try {
    await installMainHookAndResume(mainTarget);
  } catch (error) {
    // A failed shim must never leave M HUB permanently paused at --inspect-brk.
    log(`main hook failed: ${error.message}`);
    try {
      const rescue = new CDPClient(mainTarget.webSocketDebuggerUrl);
      await rescue.connect();
      await rescue.command('Runtime.runIfWaitingForDebugger').catch(() => {});
      rescue.close();
    } catch {}
  }

  const fonts = loadFonts();
  if (!fonts) log('font injection disabled because one or more local font files are missing');

  let missedMainChecks = 0;

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

    if (fonts) {
      try {
        const targets = await rendererTargets();
        for (const target of targets) {
          try {
            await injectFontsIntoTarget(target, fonts);
          } catch (error) {
            log(`font injection retry for ${target.title || target.url}: ${error.message}`);
          }
        }
      } catch {
        // Renderer debugging port is not ready yet, or the renderer is reloading.
      }
    }

    await sleep(1500);
  }
}

main().catch((error) => {
  log(`fatal: ${error.stack || error}`);
  process.exit(1);
});
