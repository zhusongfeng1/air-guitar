/**
 * 启动脚本健康检查。
 *
 * 起因：把中文写进 start.bat 之后，双击它整段命令全乱套（cmd 是按 ANSI/GBK 解析
 * .bat 的，跟 chcp 无关），窗口一闪而过、服务没起、浏览器打开是"拒绝连接"。
 * 这类问题肉眼看不出来（文件在编辑器里显示得好好的），必须机器验。
 *
 *   node tools/test_launcher.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
let pass = 0;
const fails = [];

function ok(name, cond, detail = '') {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fails.push(name + (detail ? ` —— ${detail}` : ''));
    console.log(`  ✗ ${name}${detail ? ` —— ${detail}` : ''}`);
  }
}

console.log('\n=== 启动脚本检查 ===\n');

// ---- start.bat ----
const batPath = path.join(ROOT, 'start.bat');
ok('start.bat 存在', fs.existsSync(batPath));
const batBuf = fs.readFileSync(batPath);
const nonAscii = [...batBuf].filter((b) => b > 127).length;
ok(
  'start.bat 是纯 ASCII（有中文就会被 cmd 按 GBK 曲解，整段命令失效）',
  nonAscii === 0,
  `发现 ${nonAscii} 个非 ASCII 字节`,
);
const bat = batBuf.toString('utf8');
ok('start.bat 会用 serve.js 起服务', bat.includes('tools\\serve.js'));
ok('start.bat 会先挂 open_when_ready 小助手', bat.includes('open_when_ready'));
// 关键顺序：必须先挂"等服务通了再开浏览器"的助手，而不是自己直接 start 打开网址
const lines = bat.split(/\r?\n/).map((l) => l.trim());
const helperLine = lines.findIndex((l) => l.includes('open_when_ready'));
const directOpen = lines.findIndex((l) => /^start\s+""\s+"http/.test(l));
ok(
  '不是"先开浏览器后起服务"（那会在冷启动的空档里显示拒绝连接）',
  directOpen === -1,
  directOpen >= 0 ? `第 ${directOpen + 1} 行直接 start 了网址` : '',
);
// 只看真正会被执行的那一行（注释里也可能出现 serve.js 字样）
const execServeLine = lines.findIndex((l) => /^(start .*)?".*NODE.*".*serve\.js/i.test(l) || /NODE=%NODE%.*serve\.js/.test(l));
const execHelperLine = lines.findIndex((l) => /^start .*open_when_ready/.test(l));
ok('小助手在起服务之前挂上', execHelperLine >= 0 && execServeLine >= 0 && execHelperLine < execServeLine,
  `helper=${execHelperLine + 1} serve=${execServeLine + 1}`);
ok('没找到 node/python 时有明确提示', /Neither|pause/i.test(bat));

// ---- serve.js ----
const serve = fs.readFileSync(path.join(ROOT, 'tools', 'serve.js'), 'utf8');
ok('serve.js 端口被占用时给人话（不是甩 EADDRINUSE 崩掉）', serve.includes('EADDRINUSE') && serve.includes('已经有服务在跑'));
ok('serve.js 带跨源隔离响应头（wasm 多线程需要）', serve.includes('Cross-Origin-Embedder-Policy'));
ok('serve.js 禁用缓存（改完刷新就能看到）', serve.includes('no-store'));

// ---- 小助手：真起一个服务，验它能不能等到就绪 ----
const PORT = 8791;
const serveProc = spawn(process.execPath, [path.join(HERE, 'serve.js'), String(PORT)], { stdio: 'ignore' });
const up = await new Promise((resolve) => {
  const t0 = Date.now();
  const tick = () => {
    http
      .get({ host: '127.0.0.1', port: PORT, path: '/', timeout: 800 }, (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      })
      .on('error', () => (Date.now() - t0 > 8000 ? resolve(false) : setTimeout(tick, 120)))
      .on('timeout', function () {
        this.destroy();
        Date.now() - t0 > 8000 ? resolve(false) : setTimeout(tick, 120);
      });
  };
  tick();
});
ok('serve.js 能起来并返回 200', up);

if (up) {
  // 注意：不能用管道(stdout:'pipe')捕获子进程输出 —— 受限沙箱里那会 spawn EPERM。
  // 重定向到文件，再把文件读回来。
  const tmpDir = path.join(ROOT, '.tmp');
  fs.mkdirSync(tmpDir, { recursive: true });
  const outFile = path.join(tmpDir, 'launcher-helper.out');
  const runHelper = () =>
    new Promise((resolve) => {
      const fd = fs.openSync(outFile, 'w');
      const p = spawn(process.execPath, [path.join(HERE, 'open_when_ready.mjs'), String(PORT), '--wait-only'], {
        stdio: ['ignore', fd, fd],
      });
      const t = setTimeout(() => p.kill(), 25000);
      p.on('close', (code) => {
        clearTimeout(t);
        fs.closeSync(fd);
        let out = '';
        try {
          out = fs.readFileSync(outFile, 'utf8');
        } catch {
          /* 读不到就算了 */
        }
        resolve({ code, out });
      });
    });

  const r = await runHelper();
  ok('小助手在服务就绪后正常退出（退出码 0）', r.code === 0, `退出码 ${r.code}`);
  ok('小助手报告了就绪地址', r.out.includes(`127.0.0.1:${PORT}`), r.out.trim().slice(0, 80));

  // 反例：服务停掉后，小助手应该超时失败而不是假装成功
  serveProc.kill();
  await new Promise((res) => setTimeout(res, 800));
  const r2 = await runHelper();
  ok('服务不在时小助手会失败（退出码非 0），不会假装打开成功', r2.code !== 0 && r2.code !== null, `退出码 ${r2.code}`);
} else {
  serveProc.kill();
}

// ---- 文档 ----
const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
ok('README 提到 start.bat 的用法', /start\.bat/.test(readme));

console.log(`\n结果：${pass} 通过，${fails.length} 失败`);
for (const f of fails) console.log(`  ✗ ${f}`);
process.exit(fails.length === 0 ? 0 : 1);
