#!/usr/bin/env bash
# Puts the five lab machines into Portway's database.
#
# Straight into SQLite rather than through the app, because the app has no way
# to be told about a host from outside. Written to be run twice: each machine is
# removed by name first, so re-importing updates rather than duplicating — the
# `name` column is unique and a second insert would simply fail.
set -euo pipefail
cd "$(dirname "$0")"
source ./machines.sh

DB="$HOME/.portway/portway.db"
KEY="$(cd "$(dirname keys/lab_ed25519)" && pwd)/lab_ed25519"

[ -f "$DB" ] || { echo "no database at $DB — start Portway once first"; exit 1; }
[ -f "$KEY" ] || { echo "no key — run ./up.sh first"; exit 1; }

now=$(date +%s)
for entry in "${LAB_MACHINES[@]}"; do
  read -r port name user group _ <<< "$entry"
  id=$(sqlite3 "$DB" "SELECT id FROM hosts WHERE name = '$name';")
  if [ -n "$id" ]; then
    sqlite3 "$DB" "DELETE FROM command_log WHERE host_id=$id;
                   DELETE FROM tunnels    WHERE host_id=$id;
                   DELETE FROM hosts      WHERE id=$id;"
  fi
  sqlite3 "$DB" "INSERT INTO hosts
      (name, address, port, user, group_id, auth, key_path,
       agent_forwarding, keep_alive, save_to_keychain, unlock_via_keychain,
       favorite, created_at, updated_at)
    VALUES
      ('$name', '127.0.0.1', $port, '$user', '$group', 'key', '$KEY',
       0, 0, 0, 0, 0, $now, $now);"
  echo "imported $name  ($user@127.0.0.1:$port)"
done

echo
echo "Portway reads its host list once, at startup — restart it to see these."
