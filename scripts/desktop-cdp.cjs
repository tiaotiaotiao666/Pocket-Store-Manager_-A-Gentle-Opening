#!/usr/bin/env node
/**
 * 桌面端 CDP 走查工具（P5 交付验证用，不进入产品运行时）。
 *
 * 为什么不走 UIA：Windows UI Automation 对 Electron 自绘控件经常读不到可点击节点，
 * 追查那类失败会滑进 ACL/权限排查。这里改用 Chromium DevTools Protocol：
 * 真实窗口、真实渲染进程、真实鼠标事件（Input.dispatchMouseEvent），
 * 截图来自 Page.captureScreenshot，等于用户看到的画面。
 *
 * 用法（先启动 vite + electron --remote-debugging-port=9222）：
 *   node scripts/desktop-cdp.cjs list
 *   node scripts/desktop-cdp.cjs dump
 *   node scripts/desktop-cdp.cjs shot .arts/p5/page.png
 *   node scripts/desktop-cdp.cjs eval "document.title"
 */
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_PORT = Number(process.env.DESKTOP_CDP_PORT || 9222);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function listTargets(port = DEFAULT_PORT) {
  const response = await fetch('http://127.0.0.1:' + port + '/json/list');
  if (!response.ok) throw new Error('CDP /json/list 返回 ' + response.status);
  return response.json();
}

async function findPageTarget(port = DEFAULT_PORT, match = '127.0.0.1:5173') {
  const targets = await listTargets(port);
  const pages = targets.filter((item) => item.type === 'page' && item.webSocketDebuggerUrl);
  const matched = pages.filter((item) => String(item.url || '').includes(match));
  const target = matched[0] || pages[0];
  if (!target) throw new Error('没有可用的 page target：' + JSON.stringify(targets.map((t) => t.type)));
  return target;
}

class CdpSession {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    ws.on('message', (raw) => {
      let message = null;
      try {
        message = JSON.parse(String(raw));
      } catch (error) {
        return;
      }
      if (!message.id) return;
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      if (message.error) entry.reject(new Error(message.error.message || JSON.stringify(message.error)));
      else entry.resolve(message.result);
    });
  }

  send(method, params = {}, timeoutMs = 30000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('CDP 超时：' + method));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression, { awaitPromise = true } = {}) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise,
      returnByValue: true,
      userGesture: true,
    });
    if (result.exceptionDetails) {
      const detail = result.exceptionDetails.exception && result.exceptionDetails.exception.description;
      throw new Error('页面求值异常：' + (detail || result.exceptionDetails.text));
    }
    return result.result ? result.result.value : undefined;
  }

  async screenshot(filePath) {
    const shot = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    const absolute = path.resolve(filePath);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, Buffer.from(shot.data, 'base64'));
    return absolute;
  }

  /**
   * 真鼠标点击：先用 DOM 找到元素中心点，再让浏览器派发 mousePressed/mouseReleased，
   * 而不是 element.click() —— 这样点到的是用户真正点到的坐标。
   */
  async clickAt(selectorExpression) {
    // 两遍测量：先 scrollIntoView，再按视口差补偿窗口滚动。
    // 应用是固定布局 + 内部滚动，只 scrollIntoView 不保证元素进入可视区，
    // 之前出现过「算出的坐标在视口外 → 鼠标点到空白」的假点击。
    const measure = `(() => {
      const el = ${selectorExpression};
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      if (!rect || rect.width === 0 || rect.height === 0) return null;
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, w: rect.width, h: rect.height,
               vw: window.innerWidth, vh: window.innerHeight };
    })()`;
    await this.evaluate(`(() => {
      let el = ${selectorExpression};
      if (!el) return false;
      // 逐层找可滚动祖先，把元素滚到容器中间。应用是固定布局，
      // window 本身不滚动，只调 scrollIntoView 不会动 .chat-stream 这类内层容器。
      let node = el;
      while (node && node !== document.body) {
        const style = window.getComputedStyle(node);
        const scrollable = /(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight + 4;
        if (scrollable) {
          const nodeRect = node.getBoundingClientRect();
          const elRect = el.getBoundingClientRect();
          const target = elRect.top - nodeRect.top + node.scrollTop - node.clientHeight / 2 + elRect.height / 2;
          node.scrollTop = Math.max(0, target);
        }
        node = node.parentElement;
      }
      if (el.scrollIntoView) el.scrollIntoView({ block: 'center', inline: 'center' });
      return true;
    })()`);
    await sleep(50);
    let box = await this.evaluate(measure);
    if (!box) throw new Error('元素不可见或不存在：' + selectorExpression);
    // 兜底：真实滚轮事件。应用里有多个独立滚动面板，程序化 scrollTop 不一定命中
    // 目标元素所在的容器，用滚轮在视口中滚是用户真实操作，也能覆盖嵌套容器。
    let wheelTries = 0;
    while ((box.y < 4 || box.y > box.vh - 4) && wheelTries < 24) {
      const delta = box.y > box.vh / 2 ? Math.min(400, Math.max(80, box.y - box.vh / 2)) : -Math.min(400, Math.max(80, box.vh / 2 - box.y));
      await this.send('Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        x: Math.round(box.vw / 2),
        y: Math.round(box.vh / 2),
        deltaX: 0,
        deltaY: Math.round(delta),
        button: 'none',
      });
      await sleep(120);
      const next = await this.evaluate(measure);
      if (!next) throw new Error('元素滚动后消失：' + selectorExpression);
      if (Math.abs(next.y - box.y) < 2) {
        // 滚不动了，换个窗口内滚动：直接用 window.scrollBy
        await this.evaluate(`window.scrollBy(0, ${Math.round(delta)})`);
        await sleep(100);
      }
      box = next;
      wheelTries += 1;
    }
    if (box.y < 4 || box.y > box.vh - 4 || box.x < 4 || box.x > box.vw - 4) {
      await this.evaluate(`window.scrollBy(0, ${Math.round(box.y - box.vh / 2)})`);
      await sleep(80);
      box = await this.evaluate(measure);
      if (!box) throw new Error('元素滚动后不可见：' + selectorExpression);
    }
    if (box.y < 0 || box.y > box.vh || box.x < 0 || box.x > box.vw) {
      throw new Error('元素在视口外，点击会落空：' + selectorExpression + ' y=' + Math.round(box.y));
    }
    const point = { x: Math.round(box.x), y: Math.round(box.y) };
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point, button: 'none', clickCount: 0 });
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
    return point;
  }

  async clickByText(text, selector = 'button, [role="button"], a, label') {
    const expression = `(() => {
      const wanted = ${JSON.stringify(text)};
      const nodes = Array.from(document.querySelectorAll(${JSON.stringify(selector)}));
      const hit = nodes.find((node) => (node.innerText || node.textContent || '').trim().includes(wanted));
      return hit || null;
    })()`;
    return this.clickAt(expression);
  }

  /**
   * 通用文本点击：先找完全匹配的最小可见元素，再退回包含匹配的最小元素。
   * 界面里「跳过」「项目操作」这类可点元素常常是 div/span 而不是 button，
   * 只按标签筛会漏掉，所以这里按「文本 + 面积最小 + 可见」挑目标。
   */
  async clickText(text, { exact = true } = {}) {
    const expression = `(() => {
      const wanted = ${JSON.stringify(text)};
      const all = Array.from(document.querySelectorAll('body *'));
      const candidates = [];
      for (const node of all) {
        const own = (node.innerText || '').trim();
        if (!own) continue;
        if (node.children.length > 3) continue;
        const matchExact = own === wanted;
        const matchContains = own.includes(wanted);
        if (${exact ? 'matchExact' : 'matchExact || matchContains'}) {
          const rect = node.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) continue;
          candidates.push({ node, area: rect.width * rect.height });
        }
      }
      if (!candidates.length) return null;
      candidates.sort((a, b) => a.area - b.area);
      return candidates[0].node;
    })()`;
    return this.clickAt(expression);
  }

  async typeInto(selectorExpression, text) {
    const ok = await this.evaluate(`(() => {
      const el = ${selectorExpression};
      if (!el) return false;
      el.focus();
      return true;
    })()`);
    if (!ok) throw new Error('输入框不存在：' + selectorExpression);
    for (const char of text) {
      await this.send('Input.insertText', { text: char });
      await sleep(8);
    }
    return true;
  }

  async waitFor(expression, { timeoutMs = 30000, intervalMs = 300, label = '' } = {}) {
    const deadline = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < deadline) {
      try {
        const value = await this.evaluate(expression);
        last = value;
        if (value) return value;
      } catch (error) {
        last = String(error.message || error);
      }
      await sleep(intervalMs);
    }
    throw new Error('等待超时' + (label ? '：' + label : '') + '；最后结果=' + JSON.stringify(last));
  }

  /** 抓取当前可见控件清单，用于确定选择器（走查期间人工确认用）。 */
  async dumpControls() {
    return this.evaluate(`(() => {
      const clean = (text) => (text || '').replace(/\\s+/g, ' ').trim().slice(0, 60);
      const controls = Array.from(document.querySelectorAll('button, [role="button"], a, input, textarea, select'))
        .filter((node) => {
          const rect = node.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        })
        .map((node) => ({
          tag: node.tagName.toLowerCase(),
          role: node.getAttribute('role') || '',
          type: node.getAttribute('type') || '',
          text: clean(node.innerText || node.value || node.getAttribute('aria-label') || node.getAttribute('placeholder') || ''),
          disabled: Boolean(node.disabled),
          visible: true,
        }));
      const headings = Array.from(document.querySelectorAll('h1, h2, h3, [data-phase], .phase, .step-title'))
        .filter((node) => {
          const rect = node.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        })
        .map((node) => ({ tag: node.tagName.toLowerCase(), text: clean(node.innerText) }));
      return { url: location.href, controls, headings, bodyText: clean(document.body.innerText) };
    })()`);
  }

  close() {
    try {
      this.ws.close();
    } catch (error) {
      /* ignore */
    }
  }
}

async function connect({ port = DEFAULT_PORT, match = '127.0.0.1:5173' } = {}) {
  const target = await findPageTarget(port, match);
  const WebSocket = require('ws');
  const ws = new WebSocket(target.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  const session = new CdpSession(ws);
  await session.send('Page.enable');
  await session.send('Runtime.enable');
  session.target = target;
  return session;
}

module.exports = { connect, listTargets, findPageTarget, CdpSession, sleep, DEFAULT_PORT };

if (require.main === module) {
  const [command, ...rest] = process.argv.slice(2);
  (async () => {
    if (command === 'list') {
      const targets = await listTargets();
      console.log(JSON.stringify(targets.map((item) => ({ type: item.type, url: item.url, title: item.title })), null, 2));
      return;
    }
    const session = await connect();
    try {
      if (command === 'dump') {
        console.log(JSON.stringify(await session.dumpControls(), null, 2));
      } else if (command === 'shot') {
        console.log(await session.screenshot(rest[0] || '.arts/p5/shot.png'));
      } else if (command === 'eval') {
        console.log(JSON.stringify(await session.evaluate(rest.join(' ')), null, 2));
      } else if (command === 'click') {
        console.log(JSON.stringify(await session.clickByText(rest.join(' '))));
      } else {
        console.log('用法：list | dump | shot <file> | eval <expr> | click <text>');
      }
    } finally {
      session.close();
    }
  })().catch((error) => {
    console.error('desktop-cdp 失败：' + (error && error.message ? error.message : error));
    process.exitCode = 1;
  });
}
