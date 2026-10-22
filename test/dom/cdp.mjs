/**
 * Zero-dependency Chrome DevTools Protocol client.
 *
 * The test suite has to prove things that only a real renderer can answer:
 * that SMIL actually advances, that stroke dashes match the measured path at
 * several scales, that an interrupted transition does not jump. jsdom cannot
 * answer any of those. Pulling in Playwright for four assertions is not worth
 * the dependency, so this drives headless Chrome over its own WebSocket
 * (Node 18+ ships a global `WebSocket`).
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';

const CHROME_CANDIDATES = [
  process.env.CHROME_BIN,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium'
].filter(Boolean);

export function findChrome() {
  for (const candidate of CHROME_CANDIDATES) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error('no Chrome/Edge binary found; set CHROME_BIN');
}

export async function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

export async function launchChrome({ width = 1440, height = 900 } = {}) {
  const binary = findChrome();
  const port = await freePort();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'vivus-cdp-'));
  const args = [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--force-device-scale-factor=1',
    `--window-size=${width},${height}`,
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${port}`,
    'about:blank'
  ];
  const proc = spawn(binary, args, { stdio: 'ignore', windowsHide: true });

  const endpoint = await waitForEndpoint(port, 15000);
  const client = new CDP(endpoint);
  await client.connect();

  return {
    client,
    async close() {
      try {
        await client.send('Browser.close');
      } catch {
        /* ignore */
      }
      client.dispose();
      proc.kill();
      try {
        fs.rmSync(profile, { recursive: true, force: true });
      } catch {
        /* windows file locks */
      }
    }
  };
}

async function waitForEndpoint(port, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) {
        const json = await res.json();
        if (json.webSocketDebuggerUrl) return json.webSocketDebuggerUrl;
      }
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 120));
  }
  throw new Error('Chrome did not expose a debugging endpoint in time');
}

export class CDP {
  constructor(url) {
    this.url = url;
    this.ws = null;
    this.seq = 0;
    this.pending = new Map();
    this.events = new Map();
  }

  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;
      ws.addEventListener('open', () => resolve());
      ws.addEventListener('error', (err) => reject(err));
      ws.addEventListener('message', (event) => this._onMessage(event.data));
    });
  }

  _onMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.id && this.pending.has(msg.id)) {
      const { resolve, reject } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) reject(new Error(`${msg.error.message} ${msg.error.data ?? ''}`));
      else resolve(msg.result);
      return;
    }
    if (msg.method) {
      const handlers = this.events.get(msg.method) || [];
      for (const fn of handlers) fn(msg.params, msg.sessionId);
    }
  }

  send(method, params = {}, sessionId) {
    const id = ++this.seq;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(payload));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }
      }, 30000);
    });
  }

  on(method, fn) {
    if (!this.events.has(method)) this.events.set(method, []);
    this.events.get(method).push(fn);
  }

  async openPage(url, { width = 1440, height = 900 } = {}) {
    const { targetId } = await this.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true });

    const logs = [];
    this.on('Runtime.consoleAPICalled', (params, sid) => {
      if (sid !== sessionId) return;
      if (params.type === 'error') {
        logs.push(params.args.map((a) => a.value ?? a.description ?? a.type).join(' '));
      }
    });
    this.on('Runtime.exceptionThrown', (params, sid) => {
      if (sid !== sessionId) return;
      logs.push(params.exceptionDetails?.exception?.description || params.exceptionDetails?.text || 'exception');
    });

    const send = (method, params = {}) => this.send(method, params, sessionId);

    await send('Runtime.enable');
    await this.send('Page.enable', {}, sessionId);
    await this.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }, sessionId);
    await this.send('Page.navigate', { url }, sessionId);
    await this.waitForLoad(sessionId);

    return {
      sessionId,
      logs,
      async evaluate(expression) {
        const result = await send('Runtime.evaluate', {
          expression,
          awaitPromise: true,
          returnByValue: true,
          allowUnsafeEvalBlockedByCSP: true
        });
        if (result.exceptionDetails) {
          throw new Error(
            result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'evaluate failed'
          );
        }
        return result.result.value;
      },
      async screenshot({ clip } = {}) {
        const params = { format: 'png', captureBeyondViewport: false };
        if (clip) params.clip = { ...clip, scale: 1 };
        const { data } = await send('Page.captureScreenshot', params);
        return Buffer.from(data, 'base64');
      },
      async resize(w, h) {
        await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
      },
      async close() {
        await send('Target.closeTarget', { targetId });
      }
    };
  }

  waitForLoad(sessionId) {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, 8000);
      const handler = (params, sid) => {
        if (sid !== sessionId) return;
        if (params.name === 'load' || params.name === 'DOMContentLoaded') {
          clearTimeout(timer);
          // Give the page one frame to paint.
          setTimeout(resolve, 260);
        }
      };
      this.on('Page.lifecycleEvent', handler);
      this.on('Page.loadEventFired', () => {
        clearTimeout(timer);
        setTimeout(resolve, 260);
      });
    });
  }

  dispose() {
    if (this.ws) this.ws.close();
  }
}
