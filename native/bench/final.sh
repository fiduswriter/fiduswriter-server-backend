#!/bin/bash
# The final benchmark: every configuration, three times.
#
# The results are written to a file, one block per run, so that they can be
# aggregated (the machine is shared, so a single run is not reliable).
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export VENV="${VENV:-/tmp/kilo/bench-venv}"
REPEATS="${REPEATS:-3}"
DURATION="${DURATION:-8}"

{
    echo "# load average at the start: $(cat /proc/loadavg)"
    for arm in ${ARMS:-python native}; do
        for clients in 1 5 20; do
            # Unthrottled single client measures the implementation cost;
            # multiple clients at unlimited rate livelock on sibling version
            # collisions on BOTH arms (the real frontend types ~5-10/s), so
            # the multi-client runs use a realistic per-client rate.
            if [ "$clients" -gt 1 ]; then
                export RATE="${RATE:-10}"
            else
                unset RATE
            fi
            for repeat in $(seq 1 "$REPEATS"); do
                echo "### arm=$arm clients=$clients repeat=$repeat"
                bash "$ROOT/bench/run.sh" "$arm" "$clients" "$DURATION" |
                    grep -E "^(throughput|latency us p50|latency us p90|latency us p99|server cpu|server rss|dropped)"
            done
        done
    done
} > "${1:-/tmp/kilo/final-results.txt}" 2>&1
