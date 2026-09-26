#!/usr/bin/env node

import process from 'node:process';
import WebSocket from 'ws';

const args = process.argv.slice(2);

function argValue(name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

const rendererPort = Number(argValue('--renderer-port', '9222'));
const once = args.includes('--once');

function log(message) {
  process.stderr.write(`[ui-fix] ${message}\n`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchTargets() {
  const response = await fetch(`http://127.0.0.1:${rendererPort}/json/list`);
  if (!response.ok) throw new Error(`renderer inspector returned HTTP ${response.status}`);
  return response.json();
}

class CDPClient {
  constructor(url) {
    this.url = url;
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
  }

  async connect() {
    this.ws = new WebSocket(this.url, { maxPayload: 32 * 1024 * 1024 });
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
      if (message.error) entry.reject(new Error(message.error.message || JSON.stringify(message.error)));
      else entry.resolve(message.result);
    });
  }

  command(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const result = await this.command('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });

    const value = result?.result;
    if (value?.subtype === 'error') throw new Error(value.description || 'Runtime.evaluate failed');
    return value?.value;
  }

  close() {
    try { this.ws?.close(); } catch {}
  }
}

const patchExpression = String.raw`
(() => {
  if (!globalThis.document || !document.documentElement) return { status: 'not-ready' };

  const isTray = document.title === 'M HUB - Tray' || /\/tray\.html(?:$|[?#])/.test(location.href);

  function repairIconClasses(root = document) {
    let repaired = 0;
    const nodes = root.querySelectorAll ? root.querySelectorAll('.iconfont') : [];
    for (const el of nodes) {
      for (const name of [...el.classList]) {
        if (/^icon-.*_linea$/.test(name)) {
          const fixed = name + 'r';
          if (!el.classList.contains(fixed)) {
            el.classList.add(fixed);
            repaired += 1;
          }
        }
      }
    }
    return repaired;
  }

  let style = document.getElementById('mhub-linux-beta-ui-fix');
  if (!style) {
    style = document.createElement('style');
    style.id = 'mhub-linux-beta-ui-fix';
    document.head?.appendChild(style);
  }

  style.textContent = isTray ? \`
    html,
    body,
    #tray-app,
    .tray-body {
      background: #151515 !important;
      background-color: #151515 !important;
      color-scheme: dark !important;
    }

    html,
    body {
      width: 100% !important;
      min-height: 100% !important;
    }
  \` : \`
    html[theme-mode="dark"],
    html[theme-mode="dark"] body {
      color-scheme: dark !important;
    }
  \`;

  const repaired = repairIconClasses(document);

  if (!globalThis.__mhubLinuxBetaUiObserver) {
    globalThis.__mhubLinuxBetaUiObserver = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node?.nodeType === 1) {
            if (node.matches?.('.iconfont')) repairIconClasses(node.parentElement || document);
            else repairIconClasses(node);
          }
        }
      }
    });
    globalThis.__mhubLinuxBetaUiObserver.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
  }

  const unresolvedFontFaces = [];
  for (const sheet of [...document.styleSheets]) {
    let rules;
    try { rules = sheet.cssRules; } catch { continue; }
    if (!rules) continue;
    for (const rule of [...rules]) {
      if (rule.type !== CSSRule.FONT_FACE_RULE) continue;
      const family = rule.style.getPropertyValue('font-family').replace(/["']/g, '').trim();
      if (!family) continue;
      const status = [...document.fonts]
        .filter((face) => face.family.replace(/["']/g, '') === family)
        .map((face) => face.status);
      if (status.some((value) => value === 'error' || value === 'unloaded')) {
        unresolvedFontFaces.push({
          family,
          cssText: rule.cssText,
          sheet: sheet.href || null,
          status,
        });
      }
    }
  }

  return {
    status: 'patched',
    title: document.title,
    href: location.href,
    isTray,
    repairedIconClasses: repaired,
    unresolvedFontFaces,
    bodyBackground: getComputedStyle(document.body).backgroundColor,
    htmlBackground: getComputedStyle(document.documentElement).backgroundColor,
  };
})()
`;

async function patchTarget(target) {
  const client = new CDPClient(target.webSocketDebuggerUrl);
  await client.connect();
  try {
    await client.command('Runtime.enable');
    return await client.evaluate(patchExpression);
  } finally {
    client.close();
  }
}

async function runPass() {
  const targets = await fetchTargets();
  const relevant = targets.filter((target) => {
    if (!['page', 'iframe'].includes(target.type)) return false;
    if (!target.webSocketDebuggerUrl) return false;
    return /mchose/i.test(`${target.title || ''} ${target.url || ''}`);
  });

  for (const target of relevant) {
    try {
      const result = await patchTarget(target);
      log(`${target.type} ${target.title || target.url}: ${JSON.stringify(result)}`);
    } catch (error) {
      log(`${target.type} ${target.title || target.url}: ${error.message}`);
    }
  }
}

async function main() {
  do {
    try {
      await runPass();
    } catch (error) {
      log(error.message || String(error));
    }

    if (once) break;
    await sleep(1500);
  } while (true);
}

main().catch((error) => {
  log(error.stack || error.message || String(error));
  process.exit(1);
});
