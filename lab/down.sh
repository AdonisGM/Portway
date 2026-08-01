#!/usr/bin/env bash
# Takes the machines away. `--purge` also removes their rows from Portway and
# their host keys from known_hosts, so nothing is left pointing at ports that
# are no longer listening.
set -euo pipefail
cd "$(dirname "$0")"

docker compose down -v

if [ "${1:-}" = "--purge" ]; then
  db="$HOME/.portway/portway.db"
  if [ -f "$db" ]; then
    for name in lab-alpine lab-debian lab-ubuntu lab-alma lab-suse; do
      id=$(sqlite3 "$db" "SELECT id FROM hosts WHERE name = '$name';")
      [ -n "$id" ] && sqlite3 "$db" \
        "DELETE FROM command_log WHERE host_id=$id;
         DELETE FROM tunnels    WHERE host_id=$id;
         DELETE FROM hosts      WHERE id=$id;"
    done
    echo "removed the lab hosts from Portway"
  fi

  kh="$HOME/.ssh/known_hosts"
  if [ -f "$kh" ]; then
    cp "$kh" "$kh.portway-lab-bak"
    grep -vE '^\[127\.0\.0\.1\]:220[1-5] ' "$kh.portway-lab-bak" > "$kh"
    chmod 600 "$kh"
    rm -f "$kh.portway-lab-bak"
    echo "removed the lab host keys from known_hosts"
  fi
fi
