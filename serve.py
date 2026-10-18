"""Local dev server: http://localhost:8000

Same as `python -m http.server`, but forces correct MIME types (Windows registry settings can make
Python serve .js as text/plain, which breaks JavaScript modules) and disables caching.
"""

import functools
import http.server
from pathlib import Path

PORT = 8000
ROOT = Path(__file__).resolve().parent


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".html": "text/html",
        ".js": "text/javascript",
        ".css": "text/css",
        ".json": "application/json",
        ".svg": "image/svg+xml",
    }

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


if __name__ == "__main__":
    handler = functools.partial(Handler, directory=str(ROOT))
    with http.server.ThreadingHTTPServer(("localhost", PORT), handler) as server:
        print(f"Serving {ROOT} at http://localhost:{PORT}  (Ctrl+C to stop)")
        server.serve_forever()
