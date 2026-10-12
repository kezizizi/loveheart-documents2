"""带禁用缓存头的静态服务器。

为什么不用 `python -m http.server`：它只发 Last-Modified、不发 Cache-Control，
浏览器于是按「启发式缓存」自行决定新鲜期（约为文件年龄的 10%）——
在这段时间内直接吃缓存、连条件请求都不发，结果就是我改了文件、用户刷新却还是旧的。

这里给所有响应加上 no-store，从根上消除这一类「改了却看不到」的问题。
"""
import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer


class NoCacheHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()

    def log_message(self, fmt, *args):
        # 默认每个请求打一行日志，噪音太大；只保留错误
        if args and str(args[1]).startswith(('4', '5')):
            super().log_message(fmt, *args)


def main():
    root = sys.argv[1]
    port = int(sys.argv[2]) if len(sys.argv) > 2 else 8777
    handler = partial(NoCacheHandler, directory=root)
    httpd = ThreadingHTTPServer(('127.0.0.1', port), handler)
    print('serving %s at http://127.0.0.1:%d/ (no-store)' % (root, port), flush=True)
    httpd.serve_forever()


if __name__ == '__main__':
    main()
