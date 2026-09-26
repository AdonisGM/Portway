#!/bin/sh
# Fill pw-debian's private Docker daemon (the dind service) with a realistic
# mix for trying Portway's Docker screens. Never touches the host's Docker.
# Usage: scripts/test-servers.sh seed
set -e
mkdir -p /srv/shop/web
cat > /srv/shop/web/index.html <<'HTML'
<h1>shop</h1>
HTML
cat > /srv/shop/docker-compose.yml <<'YAML'
name: shop
services:
  web:
    image: nginx:1.27-alpine
    restart: unless-stopped
    ports: ["0.0.0.0:8080:80"]
    depends_on: [api]
  api:
    image: traefik/whoami:v1.10
    restart: unless-stopped
    ports: ["127.0.0.1:9000:80"]
    environment:
      DATABASE_URL: postgres://shop:secret@db:5432/shop
      REDIS_URL: redis://cache:6379
    healthcheck:
      test: ["CMD", "/whoami", "--help"]
      interval: 10s
  db:
    image: postgres:16-alpine
    restart: unless-stopped
    ports: ["0.0.0.0:5432:5432"]
    environment: { POSTGRES_USER: shop, POSTGRES_PASSWORD: secret, POSTGRES_DB: shop }
    volumes: [db-data:/var/lib/postgresql/data]
  cache:
    image: redis:7-alpine
    restart: unless-stopped
    volumes: [cache-data:/data]
  migrate:
    image: busybox:1.36
    restart: "no"
    command: ["sh", "-c", "echo 'applying 3 migrations'; sleep 1; echo 'migrations done'"]
    depends_on: [db]
volumes:
  db-data:
  cache-data:
YAML
cd /srv/shop && docker compose up -d

# A container started by hand, outside any compose project.
docker rm -f whoami-lab >/dev/null 2>&1 || true
docker run -d --name whoami-lab --restart unless-stopped -p 127.0.0.1:9100:80 traefik/whoami:v1.10 >/dev/null

# One that keeps crashing, for the "restarting" state.
docker rm -f flaky-worker >/dev/null 2>&1 || true
docker run -d --name flaky-worker --restart always busybox:1.36 sh -c 'echo "worker starting"; echo "ERROR cannot reach queue" >&2; exit 1' >/dev/null

# A dangling image: build the same tag twice with different content.
tmp=$(mktemp -d)
for v in 1 2; do
  printf 'FROM busybox:1.36\nRUN echo build-%s > /version\n' "$v" > "$tmp/Dockerfile"
  docker build -q -t portway/demo:latest "$tmp" >/dev/null
done
rm -rf "$tmp"

# A tagged image no container uses, and a volume nothing mounts.
docker pull -q alpine:3.19 >/dev/null
docker volume create old-data >/dev/null

docker ps -a --format 'table {{.Names}}\t{{.Status}}'
