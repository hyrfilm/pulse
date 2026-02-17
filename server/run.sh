#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

PULSE_ADDR="${PULSE_ADDR:-:8080}"
PULSE_PERIOD_MS="${PULSE_PERIOD_MS:-1000}"

echo "Building..."
go build -o pulse .

echo "Starting pulse server on ${PULSE_ADDR} (period=${PULSE_PERIOD_MS}ms)"
PULSE_ADDR="$PULSE_ADDR" PULSE_PERIOD_MS="$PULSE_PERIOD_MS" exec ./pulse
