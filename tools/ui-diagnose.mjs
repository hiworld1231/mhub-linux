#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import WebSocket from 'ws';

const args = process.argv.slice(2);

function argValue(name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

const rendererPort = Number(argValue('--renderer-port', '9222'));
const output = path.resolve(argValue('--output', 'mhub-ui-diagnostics.json'));

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
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message || JSON.stringify(message.error)));
      else pending.resolve(message.result);
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

  async evaluate(expression) {
    const result = await this.command('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    }, 30000);

    const value = result?.result;
    if (value?.subtype === 'error') throw new Error(value.description || 'Runtime.evaluate failed');
    return value?.value;
  }

  close() {
    try {
      this.ws?.close();
    } catch {}
  }
}

const diagnosticExpression = String.raw`
(async () => {
  const styleSheets = [];
  for (const sheet of Array.from(document.styleSheets || [])) {
    let ruleCount = null;
    let accessError = null;
    try {
      ruleCount = sheet.cssRules ? sheet.cssRules.length : 0;
    } catch (error) {
      accessError = String(error);
    }
    styleSheets.push({ href: sheet.href, ruleCount, accessError });
  }

  const fonts = Array.from(document.fonts || []).map((font) => ({
    family: font.family,
    status: font.status,
    weight: font.weight,
    style: font.style,
  }));

  const images = Array.from(document.images || []).map((img) => ({
    src: img.currentSrc || img.src,
    complete: img.complete,
    naturalWidth: img.naturalWidth,
    naturalHeight: img.naturalHeight,
    width: img.clientWidth,
    height: img.clientHeight,
  }));

  const brokenImages = images.filter((img) => img.complete && img.naturalWidth === 0);

  const resources = performance.getEntriesByType('resource').map((entry) => ({
    name: entry.name,
    initiatorType: entry.initiatorType,
    duration: Math.round(entry.duration),
    transferSize: entry.transferSize,
    encodedBodySize: entry.encodedBodySize,
    decodedBodySize: entry.decodedBodySize,
  }));

  const suspiciousResources = resources.filter((entry) => {
    if (!entry.name) return false;
    if (!/mchose|cdn\.|woff|ttf|otf|\.css|\.js|\.png|\.jpe?g|\.webp|\.svg/i.test(entry.name)) return false;
    return entry.decodedBodySize === 0 && entry.encodedBodySize === 0;
  });

  const bodyStyle = document.body ? getComputedStyle(document.body) : null;
  const htmlStyle = document.documentElement ? getComputedStyle(document.documentElement) : null;

  const pseudoIconProblems = [];
  for (const element of Array.from(document.querySelectorAll('[class*="icon"], [class*="mc-icon"]')).slice(0, 300)) {
    const before = getComputedStyle(element, '::before');
    const after = getComputedStyle(element, '::after');
    const rect = element.getBoundingClientRect();
    const record = {
      tag: element.tagName,
      className: typeof element.className === 'string' ? element.className : '',
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      fontFamily: getComputedStyle(element).fontFamily,
      beforeContent: before.content,
      beforeFontFamily: before.fontFamily,
      afterContent: after.content,
      afterFontFamily: after.fontFamily,
    };
    if ((before.content && before.content !== 'none' && before.content !== 'normal') ||
        (after.content && after.content !== 'none' && after.content !== 'normal') ||
        /icon/i.test(record.className)) {
      pseudoIconProblems.push(record);
    }
  }

  return {
    location: location.href,
    title: document.title,
    readyState: document.readyState,
    bodyChildCount: document.body ? document.body.children.length : null,
    bodyTextLength: document.body ? document.body.innerText.length : null,
    bodyTextSample: document.body ? document.body.innerText.slice(0, 500) : null,
    bodyBackground: bodyStyle?.backgroundColor || null,
    bodyColor: bodyStyle?.color || null,
    htmlBackground: htmlStyle?.backgroundColor || null,
    viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
    fonts,
    styleSheets,
    brokenImages,
    suspiciousResources: suspiciousResources.slice(0, 200),
    pseudoIcons: pseudoIconProblems.slice(0, 120),
    htmlSample: document.documentElement ? document.documentElement.outerHTML.slice(0, 3000) : null,
  };
})()
`;

async function inspectTarget(target) {
  const client = new CDPClient(target.webSocketDebuggerUrl);
  await client.connect();
  try {
    await client.command('Runtime.enable');
    return await client.evaluate(diagnosticExpression);
  } finally {
    client.close();
  }
}

async function main() {
  const targets = await fetchTargets();
  const interesting = targets.filter((target) =>
    ['page', 'iframe'].includes(target.type) && target.webSocketDebuggerUrl,
  );

  const report = {
    generatedAt: new Date().toISOString(),
    rendererPort,
    targets: [],
  };

  for (const target of interesting) {
    const entry = {
      id: target.id,
      type: target.type,
      title: target.title,
      targetUrl: target.url,
    };

    try {
      entry.document = await inspectTarget(target);
    } catch (error) {
      entry.error = error.stack || error.message || String(error);
    }

    report.targets.push(entry);
    process.stderr.write(`[ui-diagnose] ${target.type} ${target.title || target.url}\n`);
  }

  fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
  process.stderr.write(`[ui-diagnose] wrote ${output}\n`);
}

main().catch((error) => {
  process.stderr.write(`[ui-diagnose] ${error.stack || error.message || String(error)}\n`);
  process.exit(1);
});
