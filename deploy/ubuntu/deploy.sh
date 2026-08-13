#!/usr/bin/env bash
#
# Updates the H5P Studio stack on this host from the current checkout.
#
# Usage (on the server, from the repo root):
#   ./deploy/ubuntu/deploy.sh
#
# The SQLite database and the H5P data directory live in named Docker volumes,
# so a rebuild keeps existing content and results. Both are backed up first
# anyway, because a rebuild that fails halfway is a bad time to discover the
# backup step was skipped.
set -euo pipefail

cd "$(dirname "$0")"

# Pin the project name. Compose otherwise derives it from the directory
# ("ubuntu"), which builds a second, parallel stack on fresh empty volumes and
# then fails to bind the port the real one already holds.
PROJECT=lms-h5p
export COMPOSE_PROJECT_NAME="$PROJECT"

if [ ! -f .env ]; then
    echo "ERROR: deploy/ubuntu/.env is missing. Copy .env.example and fill in the secrets." >&2
    exit 1
fi

# Refuse to run with the placeholder secrets still in place.
if grep -q 'replace-with-a-random' .env; then
    echo "ERROR: .env still contains placeholder secrets. Generate real ones:" >&2
    echo "         openssl rand -base64 32" >&2
    exit 1
fi

STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_DIR="./backups/$STAMP"
mkdir -p "$BACKUP_DIR"

echo "==> Backing up volumes to $BACKUP_DIR"
# Read the volumes through a throwaway container: the host has no direct path
# to them, and this works the same whether or not the stack is running.
for vol in api-data h5p-data; do
    full="${PROJECT}_${vol}"
    if docker volume inspect "$full" >/dev/null 2>&1; then
        docker run --rm \
            -v "$full:/from:ro" \
            -v "$PWD/$BACKUP_DIR:/to" \
            alpine tar czf "/to/$vol.tar.gz" -C /from .
        echo "    $full -> $BACKUP_DIR/$vol.tar.gz"
    else
        echo "    $full does not exist yet, skipping"
    fi
done

echo "==> Building images"
docker compose -p "$PROJECT" build

echo "==> Restarting stack"
docker compose -p "$PROJECT" up -d

echo "==> Waiting for health"
PUBLIC_ORIGIN="$(grep -E '^PUBLIC_ORIGIN=' .env | cut -d= -f2-)"
for _ in $(seq 1 60); do
    if curl -fsS -m 5 "${PUBLIC_ORIGIN}/backend/health" >/dev/null 2>&1; then
        echo
        echo "OK: ${PUBLIC_ORIGIN}"
        curl -fsS -m 5 "${PUBLIC_ORIGIN}/backend/health"
        echo
        curl -fsS -m 5 "${PUBLIC_ORIGIN}/h5p-engine/api/embed-origins"
        echo
        exit 0
    fi
    printf '.'
    sleep 5
done

echo >&2
echo "ERROR: stack did not become healthy. Recent logs:" >&2
docker compose -p "$PROJECT" logs --tail 40 >&2
exit 1
