#!/usr/bin/env bash
# Starts or stops the local PostgreSQL 16 used by `npm run test:pg`.
#   scripts/pg-test-db.sh start   # docker run postgres:16-alpine, container rollercoaster-pg, 127.0.0.1:55432
#   scripts/pg-test-db.sh stop    # removes the container (its data is throwaway)
# Idempotent: start reuses a running container and restarts a stopped one.
# URL: postgres://rollercoaster:rollercoaster@127.0.0.1:55432/rollercoaster
set -eu

NAME="${PG_TEST_CONTAINER:-rollercoaster-pg}"
PORT="${PG_TEST_PORT:-55432}"
IMAGE="postgres:16-alpine"
URL="postgres://rollercoaster:rollercoaster@127.0.0.1:${PORT}/rollercoaster"

running() { [ "$(docker inspect -f '{{.State.Running}}' "$NAME" 2>/dev/null || true)" = "true" ]; }
exists() { docker inspect "$NAME" >/dev/null 2>&1; }

wait_ready() {
  for _ in $(seq 1 60); do
    if docker exec "$NAME" pg_isready -U rollercoaster -d rollercoaster >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  echo "pg-test-db: PostgreSQL did not become ready in 60 s" >&2
  return 1
}

case "${1:-}" in
  start)
    if running; then
      :
    elif exists; then
      docker start "$NAME" >/dev/null
    else
      docker run -d --name "$NAME" \
        -e POSTGRES_USER=rollercoaster -e POSTGRES_PASSWORD=rollercoaster -e POSTGRES_DB=rollercoaster \
        -p "127.0.0.1:${PORT}:5432" "$IMAGE" >/dev/null
    fi
    wait_ready
    echo "$URL"
    ;;
  stop)
    if exists; then
      docker rm -f "$NAME" >/dev/null
    fi
    echo "pg-test-db: stopped"
    ;;
  *)
    echo "usage: $0 start|stop" >&2
    exit 2
    ;;
esac
