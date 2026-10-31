"""等本地服务通了再打开浏览器（Python 回退版，没装 Node 时用）。

    python tools/open_when_ready.py [port] [--wait-only]

和 tools/open_when_ready.mjs 行为一致：轮询到页面能返回 200 才开浏览器，
免得"先开浏览器后起服务"那不到 1 秒的空档让人以为打不开。
"""
import sys
import time
import urllib.error
import urllib.request
import webbrowser

args = [a for a in sys.argv[1:]]
wait_only = "--wait-only" in args
port = next((int(a) for a in args if a.isdigit()), 8765)
url = f"http://127.0.0.1:{port}/"

deadline = time.time() + 20
while time.time() < deadline:
    try:
        with urllib.request.urlopen(url, timeout=1.5) as res:
            if res.status == 200:
                break
    except (urllib.error.URLError, OSError):
        time.sleep(0.15)
else:
    print(f"[air-guitar] 等了 20 秒，{url} 还是连不上。", file=sys.stderr)
    print("[air-guitar] 看这个窗口上面打印的报错，或者端口被别的程序占了。", file=sys.stderr)
    sys.exit(1)

print(f"[air-guitar] 服务已就绪：{url}")
if wait_only:
    sys.exit(0)
webbrowser.open(url)
print("[air-guitar] 已打开浏览器（没弹出来的话，手动复制上面这个地址）")
