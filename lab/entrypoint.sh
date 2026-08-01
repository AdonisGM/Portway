#!/bin/sh
# Shared by all five images. POSIX sh, because one of these machines is busybox.
set -e

# The key is mounted in rather than baked into the image, so regenerating it
# does not mean rebuilding five containers. It arrives owned by whatever Docker
# Desktop decided; sshd refuses an authorized_keys it does not like the look of,
# so it is copied into place with the ownership and mode sshd wants.
install -d -m 700 -o "$LAB_USER" -g "$LAB_GROUP" "$LAB_HOME/.ssh"
install -m 600 -o "$LAB_USER" -g "$LAB_GROUP" /tmp/authorized_keys "$LAB_HOME/.ssh/authorized_keys"

# Host keys are per-container and per-run. They land in known_hosts on first
# connect and are what `down.sh --purge` tells you to clear.
ssh-keygen -A >/dev/null 2>&1

# Debian and Ubuntu's sshd will not start without this, and /run is a tmpfs.
mkdir -p /run/sshd

# Something to look at over SFTP, with more than one owner so the Owner column
# has something to resolve.
if [ ! -d "$LAB_HOME/files" ]; then
  install -d -m 755 -o "$LAB_USER" -g "$LAB_GROUP" "$LAB_HOME/files"
  echo "$LAB_OS" > "$LAB_HOME/files/os.txt"
  cp /etc/os-release "$LAB_HOME/files/os-release" 2>/dev/null || true
  install -d -m 755 -o "$LAB_USER" -g "$LAB_GROUP" "$LAB_HOME/files/logs"
  for n in 1 2 3; do
    head -c 4096 /dev/urandom > "$LAB_HOME/files/logs/run-$n.log" 2>/dev/null || true
  done
  chown -R "$LAB_USER:$LAB_GROUP" "$LAB_HOME/files"
  # One file owned by somebody else, and one by an id with no name at all —
  # the two cases the SFTP owner column has to tell apart.
  echo "owned by ops" > "$LAB_HOME/files/ops-only.txt"
  chown ops:ops "$LAB_HOME/files/ops-only.txt" 2>/dev/null || true
  echo "owned by nobody in particular" > "$LAB_HOME/files/orphan.txt"
  chown 4242:4243 "$LAB_HOME/files/orphan.txt" 2>/dev/null || true
fi

exec /usr/sbin/sshd -D -e
