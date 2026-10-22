#!/bin/bash
# Attribute the cost of the Python consumer: the per frame work (the rights
# lookup) and the periodic save (every DOC_SAVE_INTERVAL versions).
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CONFIG=/home/johannes/src/fiduswriter/fiduswriter-server-backend/fiduswriter/configuration.py

run() {
    local interval="$1" refresh="$2" label="$3"
    sed -i "s/^DOC_SAVE_INTERVAL = .*/DOC_SAVE_INTERVAL = $interval/" "$CONFIG"
    sed -i "s/^AUTHORIZATION_REFRESH_INTERVAL = .*/AUTHORIZATION_REFRESH_INTERVAL = $refresh/" "$CONFIG"
    echo "--- $label (save interval: $interval, rights refresh: $refresh)"
    bash "$ROOT/bench/run.sh" python 1 10 | grep -E "^(throughput|latency us p50|latency us p99|server cpu)"
}

run 30 0 "default"
run 30 60 "rights cached"
run 1000000 0 "no periodic save"
run 1000000 60 "no periodic save, rights cached"

# Restore the defaults
sed -i "s/^DOC_SAVE_INTERVAL = .*/DOC_SAVE_INTERVAL = 30/" "$CONFIG"
sed -i "s/^AUTHORIZATION_REFRESH_INTERVAL = .*/AUTHORIZATION_REFRESH_INTERVAL = 0/" "$CONFIG"
