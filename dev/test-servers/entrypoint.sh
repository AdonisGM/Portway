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
  ufw allow 8443/tcp comment 'Admin panel' >/dev/null
  ufw allow OpenSSH >/dev/null
  ufw deny from 203.0.113.7 >/dev/null
  ufw --force enable >/dev/null || echo "ufw could not be enabled" >&2
  # Something listening on every address (blocked by the firewall) and
  # something on loopback only, for the firewall screen's groups.
  if command -v python3 >/dev/null 2>&1; then
    mkdir -p /srv/www && echo portway > /srv/www/index.html
    (cd /srv/www && python3 -m http.server 8080 --bind 0.0.0.0 >/dev/null 2>&1 &)
    (cd /srv/www && python3 -m http.server 5000 --bind 127.0.0.1 >/dev/null 2>&1 &)
  fi
fi
# Private Docker daemon from compose.yml's dind service, shared through /dind.
# deploy is in the docker group here, so it reaches Docker without sudo.
if [ -d /dind ]; then
  getent group docker >/dev/null || groupadd -g 2375 docker
  usermod -aG docker deploy
  ln -sf /dind/docker.sock /var/run/docker.sock
fi
exec /usr/sbin/sshd -D -e
