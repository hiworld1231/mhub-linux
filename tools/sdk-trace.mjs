#!/usr/bin/env node

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
const output = path.resolve(argValue('--output', 'mhub-sdk-trace.jsonl'));

function log(message) {
  process.stderr.write(`[sdk-trace] ${message}\n`);
}

async function fetchTargets() {
  const response = await fetch(`http://127.0.0.1:${mainPort}/json/list`);
  if (!response.ok) throw new Error(`inspector returned HTTP ${response.status}`);
  return response.json();
}

function traceHookExpression() {
  return String.raw`
(() => {
  if (globalThis.__mhubLinuxSdkTraceInstalled) return 'already-installed';

  const cp = process.getBuiltinModule('child_process');
  const proto = cp.ChildProcess && cp.ChildProcess.prototype;
  const originalSpawn = proto && proto.spawn;

  if (typeof originalSpawn !== 'function') {
    return 'error: ChildProcess.prototype.spawn unavailable';
  }

  const emit = (direction, child, payload) => {
    try {
      console.log('__MHUB_SDK_TRACE__' + JSON.stringify({
        ts: Date.now(),
        direction,
        pid: child && child.pid || null,
        payload,
      }));
    } catch (error) {
      console.log('__MHUB_SDK_TRACE__' + JSON.stringify({
        ts: Date.now(),
        direction,
        pid: child && child.pid || null,
        serializationError: String(error),
      }));
    }
  };

  function wrap(child) {
    if (!child || child.__mhubLinuxSdkTraceWrapped) return;

    if (typeof child.send === 'function') {
      const originalSend = child.send;
      child.send = function(message, ...rest) {
        emit('main->worker', child, message);
        return originalSend.call(this, message, ...rest);
      };
    }

    if (typeof child.on === 'function') {
      child.on('message', (message) => emit('worker->main', child, message));
    }

    child.__mhubLinuxSdkTraceWrapped = true;
  }

  proto.spawn = function(options) {
    const result = originalSpawn.call(this, options);
    wrap(this);
    return result;
  };

  const originalFork = cp.fork;
  if (typeof originalFork === 'function') {
    cp.fork = function(...forkArgs) {
      const child = originalFork.apply(this, forkArgs);
      wrap(child);
      return child;
    };
  }

  globalThis.__mhubLinuxSdkTraceInstalled = true;
  return 'installed';
})()
`;
}

async function main() {
  const targets = await fetchTargets();
  const target = targets.find((entry) => entry.webSocketDebuggerUrl);
  if (!target) throw new Error(`no Node inspector target found on port ${mainPort}`);

  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, '');

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let nextId = 1;
  const pending = new Map();

  const command = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });

  ws.on('message', (raw) => {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (message.id && pending.has(message.id)) {
      const entry = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) entry.reject(new Error(message.error.message));
      else entry.resolve(message.result);
      return;
    }

    if (message.method !== 'Runtime.consoleAPICalled') return;
    const values = message.params?.args || [];
    for (const value of values) {
      const text = typeof value.value === 'string' ? value.value : '';
      if (!text.startsWith('__MHUB_SDK_TRACE__')) continue;

      const json = text.slice('__MHUB_SDK_TRACE__'.length);
      try {
        const record = JSON.parse(json);
        const line = JSON.stringify(record);
        fs.appendFileSync(output, `${line}\n`);
        process.stdout.write(`${line}\n`);
      } catch (error) {
        log(`could not parse trace record: ${error.message}`);
      }
    }
  });

  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });

  await command('Runtime.enable');
  const result = await command('Runtime.evaluate', {
    expression: traceHookExpression(),
    returnByValue: true,
  });

  const status = result?.result?.value;
  log(`hook: ${status}`);
  log(`writing JSONL to ${output}`);
  log('leave this running, then open V9 Pro and change one control at a time');
  log('press Ctrl+C when finished');

  const stop = () => {
    try { ws.close(); } catch {}
    process.exit(0);
  };

  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((error) => {
  log(error.stack || error.message || String(error));
  process.exit(1);
});
