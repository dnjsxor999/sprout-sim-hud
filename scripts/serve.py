#!/usr/bin/env python3
"""Serve this folder for development with caching off: ``python3 scripts/serve.py [port]`` (``npm run serve``, port 8788).

Plain ``http.server`` sends no Cache-Control, so a browser keeps the page's ES modules (which import each other without
cache keys) by its own heuristic and a plain reload shows old code; this server answers every file with
``Cache-Control: no-store``, so a reload always fetches the current files. GitHub Pages serves the same page with its own
short cache; the cache key on ``src/app.js`` in index.html covers that case for the entry module only.
"""
import http.server
import os
import sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8788
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=ROOT, **k)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):  # quiet: one line per request is noise during a replay
        pass


if __name__ == "__main__":
    with http.server.ThreadingHTTPServer(("127.0.0.1", PORT), NoCacheHandler) as srv:
        print(f"serving {ROOT} at http://127.0.0.1:{PORT}/ (Cache-Control: no-store)", flush=True)
        srv.serve_forever()
