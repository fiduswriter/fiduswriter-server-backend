#!/bin/bash
# Run the benchmark matrix for the PyPy environment.
set -u
export VENV="${VENV:-/tmp/kilo/pypy-venv}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

for clients in 1 5 20; do
    bash "$ROOT/bench/run.sh" python "$clients" "${1:-10}"
done
