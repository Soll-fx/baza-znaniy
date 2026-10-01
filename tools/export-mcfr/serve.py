#!/usr/bin/env python3
"""Локальный сервер для crawler.js.

Страница базы знаний открыта по https, а сервер слушает по http,
поэтому нужен заголовок Access-Control-Allow-Origin — без него
браузер молча блокирует загрузку.
"""
import http.server
import socketserver
import sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
DIR = "/Users/soll/Documents/Nick/бухгалтер/tools/export-mcfr"


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=DIR, **kw)

    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self.end_headers()

    def log_message(self, fmt, *args):
        sys.stderr.write("%s\n" % (fmt % args))


socketserver.TCPServer.allow_reuse_address = True
with socketserver.TCPServer(("127.0.0.1", PORT), Handler) as httpd:
    print(f"crawler.js -> http://127.0.0.1:{PORT}/crawler.js")
    print("Ctrl+C — остановить")
    sys.stdout.flush()
    httpd.serve_forever()
