#!/usr/bin/env bash
# Brings the five lab machines up, making the key first if there isn't one.
set -euo pipefail
cd "$(dirname "$0")"
source ./machines.sh

KEY=keys/lab_ed25519

if [ ! -f "$KEY" ]; then
  mkdir -p keys
  ssh-keygen -t ed25519 -N '' -C portway-lab -f "$KEY" -q
  echo "made a new key at lab/$KEY"
fi

docker compose up -d --build

# Each container installs its host keys and its authorized_keys on first boot,
# so "the container is running" and "you can log in" are a few seconds apart.
printf 'waiting for sshd'
for entry in "${LAB_MACHINES[@]}"; do
  read -r port _ user _ _ <<< "$entry"
  for _ in $(seq 1 60); do
    ssh -q -o BatchMode=yes -o StrictHostKeyChecking=no \
        -o UserKnownHostsFile=/dev/null -o ConnectTimeout=2 \
        -i "$KEY" -p "$port" "$user@127.0.0.1" true 2>/dev/null && break
    printf '.'
    sleep 2
  done
done
echo

printf '\n%-12s %-6s %-8s %s\n' MACHINE PORT USER 'REPORTS ITSELF AS'
for entry in "${LAB_MACHINES[@]}"; do
  read -r port name user _ _ <<< "$entry"
  os=$(ssh -q -o BatchMode=yes -o StrictHostKeyChecking=no \
           -o UserKnownHostsFile=/dev/null -o ConnectTimeout=3 \
           -i "$KEY" -p "$port" "$user@127.0.0.1" \
           '. /etc/os-release 2>/dev/null; echo "${PRETTY_NAME:-unknown}"' 2>/dev/null) \
     || os='NOT ANSWERING'
  printf '%-12s %-6s %-8s %s\n' "$name" "$port" "$user" "$os"
done

echo
echo "next: ./import.sh   — puts these five into Portway"
