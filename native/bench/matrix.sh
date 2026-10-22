#!/bin/bash
# Run the benchmark matrix: every arm, with a growing number of clients.
#
# Usage: bench/matrix.sh [duration]

set -u

DURATION="${1:-10}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

for arm in python native; do
    for clients in 1 5 20 50; do
        bash "$ROOT/bench/run.sh" "$arm" "$clients" "$DURATION"
    done
done
