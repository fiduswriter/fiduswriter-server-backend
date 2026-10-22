#!/bin/bash
# Run the websocket benchmarks for one arm.
#
# Usage: bench/run.sh <arm> [clients] [duration]
#
#   arm: python   the Django Channels consumer (the stock Granian)
#        native   the native Rust websockets route
#
# The script starts the server, runs the load generator and prints the
# results, together with the CPU time the server used.

set -u

ARM="${1:-python}"
CLIENTS="${2:-1}"
DURATION="${3:-10}"
PORT=8099
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="$(cd "$ROOT/../fiduswriter" && pwd)"
VENV="${VENV:-/tmp/kilo/bench-venv}"
LOADER="$ROOT/target/release/wsload"

COOKIE_FILE=/tmp/kilo/bench-session
DOCUMENT_FILE=/tmp/kilo/bench-document

echo "=== arm: $ARM, clients: $CLIENTS, duration: ${DURATION}s ==="

# The document and the session
if [ ! -f "$COOKIE_FILE" ]; then
    (cd "$APP" && PROJECT_PATH="$APP" "$VENV/bin/python" "$ROOT/bench/setup_document.py" > /tmp/kilo/bench-setup.log 2>&1)
    grep -E "^(DOCUMENT_ID|COOKIE)=" /tmp/kilo/bench-setup.log > /tmp/kilo/bench-env
    COOKIE_FILE=/tmp/kilo/bench-env
fi
. /tmp/kilo/bench-env
COOKIE="${COOKIE#COOKIE=}"
DOCUMENT="${DOCUMENT_ID#DOCUMENT_ID=}"

# Reset the benchmark document to a fixed state, so that every run starts
# from version 0 (the sessions load the document from the database; without
# the reset the version accumulated by the previous run breaks the
# catch-up of the load generator).
RESET='
import os
from document.models import Document
Document.objects.filter(pk=int(os.environ["DOCUMENT_ID"])).update(
    content={"type": "doc", "content": [
        {"type": "title", "content": [{"type": "text", "text": "Title"}]},
        {"type": "paragraph", "content": [{"type": "text", "text": "Hello world"}]},
    ]},
    version=0,
    diffs=[],
    comments={},
    bibliography={},
    title="Benchmark Document",
)
'
(cd "$APP" && PROJECT_PATH="$APP" DOCUMENT_ID="$DOCUMENT" "$VENV/bin/python" manage.py shell -c "$RESET" > /dev/null 2>&1)

# The extension module: the native one registers the Rust route.
if [ "$ARM" = "native" ]; then
    (cd "$ROOT" && "$VENV/bin/python" install.py target/release/libfiduswriter_native.so > /dev/null)
else
    # The stock Granian module: the websockets are served by Django.
    STOCK=/tmp/kilo/granian-cpython.so
    case "$VENV" in
        *pypy*) STOCK=/tmp/kilo/granian-pypy.so ;;
    esac
    for target in "$VENV"/lib/python*/site-packages/granian/_granian*.so; do
        [ -f "$target" ] || continue
        cp "$STOCK" "$target"
    done
fi

# The server. Stale benchmark servers would keep listening on the port
# (Granian sets SO_REUSEPORT) and the connections would be load balanced
# between them: kill them first.
pkill -f "$VENV/bin/python -m granian" 2>/dev/null
sleep 0.5
cd "$APP"
PATH="$VENV/bin:$PATH" \
PYTHONPATH="$(dirname "$APP")" \
PROJECT_PATH="$APP" \
FIDUSWRITER_SCHEMA_PATH="$APP/static-libs/json/schema.json" \
"$VENV/bin/python" -m granian --interface asgi --host 127.0.0.1 --port "$PORT" \
    --workers-kill-timeout 10 \
    fiduswriter.asgi:application > /tmp/kilo/bench-server.log 2>&1 &
SERVER_PID=$!
trap 'kill $SERVER_PID 2>/dev/null; pkill -f "$VENV/bin/python -m granian" 2>/dev/null' EXIT

# Wait for the server
for _ in $(seq 1 40); do
    if curl -sS -o /dev/null --max-time 2 "http://127.0.0.1:$PORT/api/base/configuration/" 2>/dev/null; then
        break
    fi
    sleep 0.5
done
sleep 1

# The CPU time of the server, before and after the run
read_cpu() {
    local pid total=0
    for pid in "$SERVER_PID" $(pgrep -P "$SERVER_PID" 2>/dev/null); do
        local ticks
        ticks=$(awk '{print $14 + $15}' "/proc/$pid/stat" 2>/dev/null)
        total=$((total + ${ticks:-0}))
    done
    echo "$total"
}
worker_pid() {
    local pid
    pid=$(pgrep -P "$SERVER_PID" 2>/dev/null | tail -1)
    echo "${pid:-$SERVER_PID}"
}
CPU_BEFORE=$(read_cpu)
RSS_BEFORE=$(awk '/VmRSS/{print $2}' "/proc/$(worker_pid)/status" 2>/dev/null || echo 0)

"$LOADER" --url "ws://127.0.0.1:$PORT/ws/document/$DOCUMENT/" \
          --cookie "$COOKIE" --clients "$CLIENTS" --duration "$DURATION" \
          --rate "${RATE:-0}" ${IDLE:+--idle}

CPU_AFTER=$(read_cpu)
RSS_AFTER=$(awk '/VmRSS/{print $2}' "/proc/$(worker_pid)/status" 2>/dev/null || echo 0)

# The ticks are USER_HZ (usually 100) per second.
echo "server cpu time: $(awk "BEGIN{printf \"%.2f\", ($CPU_AFTER - $CPU_BEFORE) / 100}")s"
echo "server rss: ${RSS_AFTER} kB"

# SIGTERM first; the graceful shutdown can wedge (the Python consumer's
# disconnect handling vs. the lifespan flush race under many simultaneous
# disconnects), so hard-kill after a grace period.
kill $SERVER_PID 2>/dev/null
for _ in $(seq 1 20); do
    if ! kill -0 $SERVER_PID 2>/dev/null; then
        break
    fi
    sleep 0.5
done
pkill -9 -f "$VENV/bin/python -m granian" 2>/dev/null
wait $SERVER_PID 2>/dev/null
exit 0
