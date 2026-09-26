#!/usr/bin/env node

import process from 'node:process';
import WebSocket from 'ws';

const args = process.argv.slice(2);

function argValue(name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

const mainPort = Number(argValue('--main-port', '9229'));

function log(message) {
  process.stderr.write(`[window-fix] ${message}\n`);
}

async function fetchTarget() {
  const response = await fetch(`http://127.0.0.1:${mainPort}/json/list`);
  if (!response.ok) throw new Error(`main inspector returned HTTP ${response.status}`);
  const targets = await response.json();
  return targets.find((target) => target.webSocketDebuggerUrl) || null;
}

class CDPClient {
  constructor(url) {
    this.url = url;
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
  }

  async connect() {
    this.ws = new WebSocket(this.url, { maxPayload: 16 * 1024 * 1024 });
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

const expression = String.raw`
(() => {
  const details = { status: 'starting', loader: null, windows: [] };
  let electron = null;

  try {
    if (process.mainModule && typeof process.mainModule.require === 'function') {
      electron = process.mainModule.require('electron');
      details.loader = 'process.mainModule.require';
    }
  } catch (error) {
    details.mainModuleError = String(error && (error.stack || error));
  }

  if (!electron) {
    try {
      const Module = process.getBuiltinModule('module');
      const req = Module.createRequire(process.cwd() + '/mhub-linux-window-fix.cjs');
      electron = req('electron');
      details.loader = 'Module.createRequire';
    } catch (error) {
      details.createRequireError = String(error && (error.stack || error));
    }
  }

  if (!electron || !electron.BrowserWindow) {
    details.status = 'electron-unavailable';
    details.processVersion = process.version;
    details.cwd = process.cwd();
    return details;
  }

  const BrowserWindow = electron.BrowserWindow;
  const windows = BrowserWindow.getAllWindows();

  for (const win of windows) {
    const row = {
      id: win.id,
      title: '',
      url: '',
      visible: null,
      backgroundBefore: null,
      backgroundAfter: null,
      applied: false,
      errors: [],
    };

    try { row.title = win.getTitle(); } catch (error) { row.errors.push('getTitle: ' + error); }
    try { row.url = win.webContents && win.webContents.getURL ? win.webContents.getURL() : ''; } catch (error) { row.errors.push('getURL: ' + error); }
    try { row.visible = win.isVisible(); } catch (error) { row.errors.push('isVisible: ' + error); }
    try { row.backgroundBefore = typeof win.getBackgroundColor === 'function' ? win.getBackgroundColor() : null; } catch (error) { row.errors.push('getBackgroundColor: ' + error); }

    const isTray = row.title === 'M HUB - Tray' || /\/tray\.html(?:$|[?#])/.test(row.url);
    row.isTray = isTray;

    if (isTray) {
      try {
        if (typeof win.setBackgroundColor === 'function') {
          win.setBackgroundColor('#151515');
          row.applied = true;
        }
      } catch (error) {
        row.errors.push('setBackgroundColor: ' + error);
      }

      try {
        if (typeof win.setOpacity === 'function') win.setOpacity(1);
      } catch (error) {
        row.errors.push('setOpacity: ' + error);
      }

      try { row.backgroundAfter = typeof win.getBackgroundColor === 'function' ? win.getBackgroundColor() : null; } catch (error) { row.errors.push('getBackgroundColor after: ' + error); }
    }

    details.windows.push(row);
  }

  details.status = 'ok';
  details.count = windows.length;
  return details;
})()
`;

async function main() {
  const target = await fetchTarget();
  if (!target) throw new Error(`no Node inspector target found on port ${mainPort}`);

  const client = new CDPClient(target.webSocketDebuggerUrl);
  await client.connect();

  try {
    await client.command('Runtime.enable');
    const result = await client.evaluate(expression);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    client.close();
  }
}

main().catch((error) => {
  log(error.stack || error.message || String(error));
  process.exit(1);
});
