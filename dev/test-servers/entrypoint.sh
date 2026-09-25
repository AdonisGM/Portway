#!/bin/sh
# Install the mounted public key for root and deploy, then run sshd in the foreground.
set -e
for home in /root /home/deploy; do
  mkdir -p "$home/.ssh"
  if [ -f /authorized_keys ]; then cp /authorized_keys "$home/.ssh/authorized_keys"; fi
  chmod 700 "$home/.ssh"
  [ -f "$home/.ssh/authorized_keys" ] && chmod 600 "$home/.ssh/authorized_keys"
done
chown -R deploy:deploy /home/deploy/.ssh
[ -x /usr/bin/ssh-keygen ] && ssh-keygen -A >/dev/null 2>&1 || true
exec /usr/sbin/sshd -D -e
