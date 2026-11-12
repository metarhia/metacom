'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');

class BrowserProtocol {
  #socket;
  #id = 0;
  #pending = new Map();
  versions = new Map();
  errors = [];

  constructor(socket) {
    this.#socket = socket;
    socket.addEventListener('message', ({ data }) => {
      const message = JSON.parse(data);
      if (message.id) {
        const request = this.#pending.get(message.id);
        if (!request) return;
        this.#pending.delete(message.id);
        clearTimeout(request.timer);
        if (message.error) {
          request.reject(new Error(JSON.stringify(message.error)));
        } else {
          request.resolve(message.result);
        }
      } else if (message.method === 'ServiceWorker.workerVersionUpdated') {
        for (const version of message.params.versions) {
          this.versions.set(version.versionId, version);
        }
      } else if (message.method === 'ServiceWorker.workerErrorReported') {
        this.errors.push(message.params);
      }
    });
  }

  request(method, params = {}, sessionId) {
    const id = ++this.#id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`Browser command timed out: ${method}`));
      }, 25000);
      this.#pending.set(id, { resolve, reject, timer });
      this.#socket.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }

  async page(url, newWindow = false, object = 'lab') {
    const { targetId } = await this.request('Target.createTarget', {
      url,
      newWindow,
    });
    const { sessionId } = await this.request('Target.attachToTarget', {
      targetId,
      flatten: true,
    });
    await this.request('Runtime.enable', {}, sessionId);
    await this.wait(sessionId, `Boolean(globalThis.${object})`);
    return sessionId;
  }

  async popup(opener, url) {
    await this.evaluate(opener, `lab.openWindow(${JSON.stringify(url)})`);
    let target;
    for (let attempt = 0; attempt < 100; attempt++) {
      const { targetInfos } = await this.request('Target.getTargets');
      target = targetInfos.find((entry) => entry.url === url);
      if (target) break;
      await delay(100);
    }
    assert.ok(target, 'Example popup did not open');
    const { sessionId } = await this.request('Target.attachToTarget', {
      targetId: target.targetId,
      flatten: true,
    });
    await this.wait(sessionId, 'Boolean(globalThis.lab)');
    return sessionId;
  }

  async evaluate(sessionId, expression) {
    const result = await this.request(
      'Runtime.evaluate',
      {
        expression,
        awaitPromise: true,
        returnByValue: true,
        userGesture: true,
      },
      sessionId,
    );
    if (result.exceptionDetails) {
      throw new Error(
        result.exceptionDetails.exception?.description ??
          JSON.stringify(result.exceptionDetails),
      );
    }
    return result.result.value;
  }

  async wait(sessionId, expression) {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await this.evaluate(sessionId, expression)) return;
      await delay(100);
    }
    throw new Error(`Browser condition timed out: ${expression}`);
  }

  close() {
    for (const request of this.#pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error('Browser closed'));
    }
    this.#pending.clear();
    this.#socket.close();
  }
}

test(
  'Real browser: RTC tabs/windows and worker owner bridge',
  { timeout: 120000 },
  async (t) => {
    let browser = null;
    const pages = [];
    let revision = 1;
    const routes = {
      '/metacom.mjs': path.resolve('metacom.mjs'),
      '/metautil.js': path.resolve('node_modules/metautil/metautil.mjs'),
      '/fixture.mjs': path.resolve('browser/fixture.mjs'),
      '/worker.mjs': path.resolve('browser/worker.mjs'),
      '/signaling.mjs': path.resolve('examples/webrtc/signaling.mjs'),
      '/example/': path.resolve('examples/webrtc/index.html'),
      '/example/app.mjs': path.resolve('examples/webrtc/app.mjs'),
      '/example/worker.mjs': path.resolve('examples/webrtc/worker.mjs'),
      '/example/signaling.mjs': path.resolve('examples/webrtc/signaling.mjs'),
      '/example/metacom.mjs': path.resolve('metacom.mjs'),
      '/example/metautil.js': path.resolve(
        'node_modules/metautil/metautil.mjs',
      ),
    };
    const server = http.createServer(async (req, res) => {
      try {
        const pathname = new URL(req.url, 'http://localhost').pathname;
        if (pathname === '/') {
          res.setHeader('Content-Type', 'text/html');
          return void res.end(
            '<!doctype html><script type="module" src="/fixture.mjs"></script>',
          );
        }
        if (!routes[pathname]) {
          res.writeHead(404);
          return void res.end();
        }
        res.setHeader(
          'Content-Type',
          pathname === '/example/' ? 'text/html' : 'text/javascript',
        );
        res.setHeader('Cache-Control', 'no-store');
        const source = await fs.readFile(routes[pathname], 'utf8');
        res.end(
          pathname === '/worker.mjs'
            ? `${source}\n// revision ${revision}\n`
            : source,
        );
      } catch (error) {
        res.writeHead(500);
        res.end(error.message);
      }
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => {
      server.closeAllConnections();
      server.close();
    });
    const origin = `http://127.0.0.1:${server.address().port}`;
    const profile = await fs.mkdtemp(
      path.join(os.tmpdir(), 'metacom-browser-'),
    );
    const chrome = spawn(
      process.env.CHROME_BIN ?? '/usr/bin/google-chrome',
      [
        '--headless=new',
        '--no-sandbox',
        '--disable-gpu',
        '--no-first-run',
        '--no-default-browser-check',
        '--remote-debugging-port=0',
        `--user-data-dir=${profile}`,
        'about:blank',
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    let diagnostics = '';
    chrome.stderr.on('data', (data) => {
      diagnostics += data.toString();
    });
    t.after(async () => {
      if (browser) {
        if (browser.errors.length) {
          console.log('Worker errors:', browser.errors);
        }
        await Promise.allSettled(
          pages.map((page) =>
            browser.evaluate(
              page,
              'globalThis.lab ? lab.close() : globalThis.example?.close()',
            ),
          ),
        );
        browser.close();
      }
      chrome.kill();
      await Promise.race([once(chrome, 'exit'), delay(2000)]);
      if (chrome.exitCode === null) chrome.kill('SIGKILL');
      await fs.rm(profile, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 200,
      });
    });
    let endpoint;
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        const [port, route] = (
          await fs.readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')
        )
          .trim()
          .split('\n');
        endpoint = `ws://127.0.0.1:${port}${route}`;
        break;
      } catch {
        await delay(100);
      }
    }
    assert.ok(endpoint, `Chrome did not start: ${diagnostics}`);
    const socket = new WebSocket(endpoint);
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', reject, { once: true });
    });
    browser = new BrowserProtocol(socket);
    const version = await browser.request('Browser.getVersion');
    console.log(`Verified browser: ${version.product}, ${version.userAgent}`);
    const host = await browser.page(`${origin}/?role=host`);
    const one = await browser.page(`${origin}/?role=one`);
    const two = await browser.page(`${origin}/?role=two`, true);
    pages.push(host, one, two);

    await t.test(
      'separate tabs/windows, independent callers and fragmentation',
      async () => {
        await browser.evaluate(host, `lab.startHost('host', ['one', 'two'])`);
        await Promise.all([
          browser.evaluate(one, `lab.connect('one', 'host')`),
          browser.evaluate(two, `lab.connect('two', 'host')`),
        ]);
        await browser.evaluate(host, 'lab.hostReady');
        const results = await Promise.all([
          browser.evaluate(one, `lab.exercise('one')`),
          browser.evaluate(two, `lab.exercise('two')`),
        ]);
        assert.deepEqual(
          results.map((result) => result.marker),
          ['one', 'two'],
        );
        await browser.evaluate(one, 'lab.close()');
        assert.equal(
          (await browser.evaluate(two, `lab.exercise('survivor')`)).bytes,
          100000,
        );
        await browser.evaluate(two, 'lab.close()');
        await browser.evaluate(host, 'lab.closeHost()');
      },
    );

    const answerer = await browser.page(`${origin}/?role=answerer`);
    pages.push(answerer);
    await t.test('host offers and caller answers', async () => {
      const answering = browser.evaluate(
        answerer,
        `lab.connect('answerer', 'host', 'answerer')`,
      );
      await delay(100);
      await browser.evaluate(
        host,
        `lab.startHost('host', ['answerer'], 'offerer')`,
      );
      await answering;
      await browser.evaluate(host, 'lab.hostReady');
      assert.equal(
        (await browser.evaluate(answerer, `lab.exercise('answerer')`)).active,
        true,
      );
      await browser.evaluate(answerer, 'lab.close()');
      await browser.evaluate(host, 'lab.closeHost()');
    });

    const owner = await browser.page(`${origin}/?role=owner`);
    const tabA = await browser.page(`${origin}/?role=worker-tab-a`);
    const tabB = await browser.page(`${origin}/?role=worker-tab-b`);
    pages.push(owner, tabA, tabB);
    await browser.request('ServiceWorker.enable', {}, owner);
    await t.test(
      'real service worker, local methods and shared RTC upstream',
      async () => {
        await browser.evaluate(owner, 'lab.startWorker()');
        await browser.evaluate(host, `lab.startHost('host', ['owner'])`);
        await browser.evaluate(owner, 'lab.attachOwner()');
        await browser.evaluate(host, 'lab.hostReady');
        await Promise.all([
          browser.evaluate(tabA, 'lab.connectWorker()'),
          browser.evaluate(tabB, 'lab.connectWorker()'),
        ]);
        const results = await Promise.all([
          browser.evaluate(tabA, `lab.exercise('worker-a')`),
          browser.evaluate(tabB, `lab.exercise('worker-b')`),
        ]);
        assert.ok(results.every((result) => result.bytes === 100000));
      },
    );
    await t.test('owner closure and fresh attachment', async () => {
      await browser.evaluate(owner, 'lab.closeOwner()');
      await browser.wait(owner, 'lab.ownerClosed()');
      await browser.evaluate(host, 'lab.closeHost()');
      await browser.evaluate(host, `lab.startHost('host', ['owner'])`);
      await browser.evaluate(owner, 'lab.attachOwner()');
      await browser.evaluate(host, 'lab.hostReady');
      assert.equal(
        (await browser.evaluate(tabA, `lab.exercise('reattached')`)).active,
        true,
      );
    });
    await t.test(
      'worker termination resets the owner and permits reattachment',
      async () => {
        const active = [...browser.versions.values()].find(
          (entry) =>
            entry.scriptURL === `${origin}/worker.mjs` &&
            entry.status === 'activated' &&
            entry.runningStatus === 'running',
        );
        assert.ok(active, 'No running service worker version reported');
        await browser.request(
          'ServiceWorker.stopWorker',
          { versionId: active.versionId },
          owner,
        );
        await browser.wait(owner, 'lab.ownerClosed()');
        await browser.evaluate(host, 'lab.closeHost()');
        await browser.evaluate(host, `lab.startHost('host', ['owner'])`);
        await browser.evaluate(owner, 'lab.attachOwner()');
        await browser.evaluate(host, 'lab.hostReady');
        await browser.wait(tabA, 'lab.connected()');
        assert.equal(
          (await browser.evaluate(tabB, `lab.exercise('restarted')`)).active,
          true,
        );
      },
    );
    await t.test(
      'controller replacement closes the obsolete owner connection',
      async () => {
        revision++;
        await browser.evaluate(owner, 'lab.updateWorker()');
        await browser.wait(owner, 'lab.ownerClosed()');
        await browser.evaluate(host, 'lab.closeHost()');
        await browser.evaluate(host, `lab.startHost('host', ['owner'])`);
        await browser.evaluate(owner, 'lab.attachOwner()');
        await browser.evaluate(host, 'lab.hostReady');
        await browser.wait(tabA, 'lab.connected()');
        assert.equal(
          (await browser.evaluate(tabA, `lab.exercise('updated')`)).active,
          true,
        );
      },
    );
    await t.test(
      'example window signaling validates the popup source',
      async () => {
        const caller = await browser.page(`${origin}/?role=popup&mode=window`);
        const popup = await browser.popup(
          caller,
          `${origin}/?role=popup-host&mode=window`,
        );
        pages.push(caller, popup);
        await browser.evaluate(popup, `lab.startHost('host', ['popup'])`);
        const connecting = browser.evaluate(
          caller,
          `lab.connect('popup', 'host')`,
        );
        await browser.evaluate(
          caller,
          `window.postMessage({
        protocol: 'metacom:rtc', version: 999, source: 'host',
        target: 'popup', generation: 'untrusted',
      }, location.origin)`,
        );
        await connecting;
        assert.equal(
          (await browser.evaluate(caller, `lab.exercise('window')`)).bytes,
          100000,
        );
        await browser.evaluate(caller, 'lab.close()');
        await browser.evaluate(popup, 'lab.close()');
      },
    );
    await Promise.all(
      pages.map((page) => browser.evaluate(page, 'lab.close()')),
    );
    await t.test(
      'runnable tab example uses the documented public APIs',
      async () => {
        const exampleHost = await browser.page(
          `${origin}/example/?role=host&peer=caller`,
          false,
          'example',
        );
        const exampleCaller = await browser.page(
          `${origin}/example/?role=caller`,
          false,
          'example',
        );
        pages.push(exampleHost, exampleCaller);
        await browser.evaluate(exampleCaller, 'example.ready');
        assert.deepEqual(
          await browser.evaluate(exampleCaller, 'example.result'),
          { hello: 'caller' },
        );
        await browser.evaluate(exampleHost, 'example.close()');
        await browser.evaluate(exampleCaller, 'example.close()');
      },
    );
    await t.test(
      'runnable worker example includes local and remote methods',
      async () => {
        const exampleHost = await browser.page(
          `${origin}/example/?role=host&peer=owner`,
          false,
          'example',
        );
        const exampleOwner = await browser.page(
          `${origin}/example/?role=owner`,
          false,
          'example',
        );
        pages.push(exampleHost, exampleOwner);
        await browser.evaluate(exampleOwner, 'example.ready');
        const exampleClient = await browser.page(
          `${origin}/example/?role=worker-client`,
          false,
          'example',
        );
        pages.push(exampleClient);
        await browser.evaluate(exampleClient, 'example.ready');
        assert.deepEqual(
          await browser.evaluate(exampleClient, 'example.result'),
          {
            hello: 'worker-client',
            sum: 5,
          },
        );
      },
    );
  },
);
