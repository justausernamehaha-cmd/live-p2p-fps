#!/usr/bin/env bash
# Serve the game over HTTP. ES modules cannot be loaded from file://, so even
# single-player testing needs this. Any static host works just as well.
set -euo pipefail
PORT="${1:-8080}"
cd "$(dirname "$0")"
IP=$(ip route get 1.1.1.1 2>/dev/null | awk '{print $7; exit}')
echo "  this machine : http://localhost:$PORT"
[ -n "${IP:-}" ] && echo "  same wi-fi   : http://$IP:$PORT   <- open this on the phone"
echo
# no-store: a browser that keeps one module and refetches another runs a build
# that never existed ("./portal.js does not provide an export named ...")
exec python3 -c '
import sys, http.server
class H(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()
http.server.ThreadingHTTPServer(("0.0.0.0", int(sys.argv[1])), H).serve_forever()
' "$PORT"
