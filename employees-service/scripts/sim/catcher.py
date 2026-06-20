#!/usr/bin/env python3
"""Tiny event catcher — receives the room's callback events ({turn_id, event})
and appends each to /tmp/room_runs.jsonl. Run inside hm-employees so the
orchestrator's callback_url=http://127.0.0.1:8077 reaches it."""
import http.server
import json

LOG = "/tmp/room_runs.jsonl"
open(LOG, "w").close()


class H(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        n = int(self.headers.get("Content-Length", 0) or 0)
        body = self.rfile.read(n)
        try:
            with open(LOG, "a") as f:
                f.write(body.decode("utf-8", "ignore") + "\n")
        except Exception:
            pass
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(b'{"ok":true}')

    def log_message(self, *a):
        pass


print("catcher up on 127.0.0.1:8077", flush=True)
http.server.HTTPServer(("127.0.0.1", 8077), H).serve_forever()
