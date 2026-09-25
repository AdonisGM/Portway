#!/usr/bin/env bash
# Start, stop or inspect the local SSH test servers (dev/test-servers).
# Usage: scripts/test-servers.sh [up|down|status|logs]
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../dev/test-servers"

case "${1:-up}" in
  up)
    docker compose up -d --build
    echo
    echo "ssh -p 2201 root@127.0.0.1    # Ubuntu 24.04"
    echo "ssh -p 2202 deploy@127.0.0.1  # Debian 12 (password: portway)"
    echo "ssh -p 2203 root@127.0.0.1    # Alpine 3.20"
    ;;
  down) docker compose down ;;
  status) docker compose ps ;;
  logs) docker compose logs -f ;;
  *) echo "Usage: $0 [up|down|status|logs]" >&2; exit 1 ;;
esac
