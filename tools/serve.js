/**
 * 零依赖静态服务器：ES module + wasm 需要 http(s) 环境，file:// 会被浏览器拦。
 *
 *   node tools/serve.js [port]
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.join(__dirname, '..', 'web');
const port = Number(process.argv[2]) || 8765;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.task': 'application/octet-stream',
  '.onnx': 'application/octet-stream',
  '.data': 'application/octet-stream',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
};

// wasm 多线程需要 cross-origin isolation
const ISO_HEADERS = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'cross-origin',
  'Cache-Control': 'no-store',
};

function send(res, code, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(code, { 'Content-Type': type, ...ISO_HEADERS });
  res.end(body);
}

const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  if (urlPath === '/' || urlPath === '') urlPath = '/index.html';

  // 防目录穿越
  const target = path.normalize(path.join(WEB_ROOT, urlPath));
  if (!target.startsWith(WEB_ROOT)) return send(res, 403, 'forbidden');

  fs.stat(target, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, 'not found: ' + urlPath);
    const type = MIME[path.extname(target).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': st.size,
      ...ISO_HEADERS,
    });
    fs.createReadStream(target).pipe(res);
  });
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    // 多半是上一个窗口还开着。不是错误，别让小白用户以为是崩了。
    console.log(`[air-guitar] 端口 ${port} 已经有服务在跑了。`);
    console.log(`[air-guitar] 直接用这个地址就行：http://127.0.0.1:${port}/`);
    console.log('[air-guitar] （如果想重启，先把之前那个黑窗口关掉。）');
    process.exit(0);
  }
  console.error('[air-guitar] 起服务失败：', err.message);
  process.exit(1);
});

server.listen(port, '127.0.0.1', () => {
  console.log(`[air-guitar] http://127.0.0.1:${port}/`);
  console.log(`[air-guitar] web 根目录: ${WEB_ROOT}`);
  console.log('按 Ctrl+C 结束');
});
