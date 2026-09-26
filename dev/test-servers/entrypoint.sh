#!/bin/sh
# Install the mounted public key for root and deploy, then run sshd in the foreground.
set -e
for home in /root /home/deploy /home/viewer; do
  mkdir -p "$home/.ssh"
  if [ -f /authorized_keys ]; then cp /authorized_keys "$home/.ssh/authorized_keys"; fi
  chmod 700 "$home/.ssh"
  [ -f "$home/.ssh/authorized_keys" ] && chmod 600 "$home/.ssh/authorized_keys"
done
chown -R deploy:deploy /home/deploy/.ssh
chown -R viewer:viewer /home/viewer/.ssh
[ -x /usr/bin/ssh-keygen ] && ssh-keygen -A >/dev/null 2>&1 || true
# Optional firewall for trying Portway's port checks (compose sets PORTWAY_UFW=1).
if [ "${PORTWAY_UFW:-}" = 1 ] && command -v ufw >/dev/null 2>&1; then
  ufw allow 22/tcp >/dev/null
  ufw allow from 113.161.0.0/16 to any port 3001 proto tcp >/dev/null
  ufw allow 9000/tcp >/dev/null
  ufw --force enable >/dev/null || echo "ufw could not be enabled" >&2
fi
exec /usr/sbin/sshd -D -e
