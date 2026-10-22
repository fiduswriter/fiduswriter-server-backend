#!/bin/bash
# The connection capacity: how many websockets can be held open at once.
#
# The clients connect and stay connected, without sending anything.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export VENV="${VENV:-/tmp/kilo/bench-venv}"

for arm in python native; do
    for clients in 100 500; do
        IDLE=1 bash "$ROOT/bench/run.sh" "$arm" "$clients" 10
    done
done
