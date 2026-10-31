/**
 * 等本地服务真的能访问了，再打开浏览器。
 *
 * 为什么需要它：原来 start.bat 是「先 start 打开浏览器，再起服务」，
 * 而 Node 冷启动要 0.3~1 秒才真正 listen，这段时间里浏览器访问就是「拒绝连接」，
 * 看起来就像"打不开了"。改成先在这里轮询，通了再开。
 *
 *   node tools/open_when_ready.mjs [port] [--wait-only]
 *
 * --wait-only 只等并报告，不开浏览器（用于自动化验证）。
 */
import { spawn } from 'node:child_process';
import http from 'node:http';

const args = process.argv.slice(2);
const waitOnly = args.includes('--wait-only');
const port = Number(args.find((a) => /^\d+$/.test(a))) || 8765;
const url = `http://127.0.0.1:${port}/`;
const TIMEOUT_MS = 20000;
const STEP_MS = 150;

// 用 http.get 而不是 fetch：老版本 Node 没有全局 fetch，这个写法哪个版本都能跑
function ready() {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: 1500 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.on('error', () => resolve(false));
  });
}

function openBrowser(target) {
  if (process.platform === 'win32') {
    // start 是 cmd 内建命令，必须走 cmd
    spawn('cmd', ['/c', 'start', '', target], { detached: true, stdio: 'ignore' }).unref();
  } else if (process.platform === 'darwin') {
    spawn('open', [target], { detached: true, stdio: 'ignore' }).unref();
  } else {
    spawn('xdg-open', [target], { detached: true, stdio: 'ignore' }).unref();
  }
}

const deadline = Date.now() + TIMEOUT_MS;
let ok = false;
while (Date.now() < deadline) {
  if (await ready()) {
    ok = true;
    break;
  }
  await new Promise((r) => setTimeout(r, STEP_MS));
}

if (!ok) {
  console.error(`[air-guitar] 等了 ${TIMEOUT_MS / 1000} 秒，${url} 还是连不上。`);
  console.error('[air-guitar] 服务可能没起来：看这个窗口上面打印的报错，或者端口被别的程序占了。');
  process.exit(1);
}

console.log(`[air-guitar] 服务已就绪：${url}`);
if (waitOnly) {
  process.exit(0);
}
openBrowser(url);
console.log('[air-guitar] 已打开浏览器（没弹出来的话，手动复制上面这个地址）');
