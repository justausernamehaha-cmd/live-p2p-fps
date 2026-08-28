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
exec python3 -m http.server "$PORT" --bind 0.0.0.0
