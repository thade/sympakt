#!/bin/sh
# Capture one explicitly authorized clear of global sample slot 1.
# This tool intentionally cannot target a different slot or run recursively.

set -u

if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then
  echo "Usage: SYMPAKT_SLOT_1_CLEAR_ACK=I_AUTHORIZE_SLOT_1_CLEAR $0 OUTPUT_DIRECTORY [DEVICE_NUMBER]" >&2
  exit 64
fi

if [ "${SYMPAKT_SLOT_1_CLEAR_ACK:-}" != "I_AUTHORIZE_SLOT_1_CLEAR" ]; then
  echo "Refusing slot 1 clear without SYMPAKT_SLOT_1_CLEAR_ACK=I_AUTHORIZE_SLOT_1_CLEAR." >&2
  exit 77
fi

capture_directory=$1
capture_device=${2:-1}

case "$capture_device" in '' | *[!0-9]*) echo "DEVICE_NUMBER must be a non-negative integer." >&2; exit 64;; esac
if [ -e "$capture_directory" ]; then echo "Refusing to overwrite existing capture path: $capture_directory" >&2; exit 73; fi

capture_script_directory=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
capture_source_directory="$capture_script_directory/../../../thirdparty/elektroid"
capture_cli=${ELEKTROID_CLI:-"$capture_source_directory/.capture-install/bin/elektroid-cli"}
if [ ! -x "$capture_cli" ]; then echo "Tracing Elektroid CLI is not executable: $capture_cli" >&2; exit 69; fi

mkdir -p "$capture_directory"
capture_commit=$(git -C "$capture_source_directory" rev-parse HEAD 2>/dev/null || printf 'unknown')
capture_trace="$capture_directory/trace.ndjson"
capture_stdout="$capture_directory/stdout.txt"
capture_stderr="$capture_directory/stderr.txt"

if ELEKTROID_DISABLE_STOP_ON_CONNECT=1 \
  ELEKTROID_SYSEX_TRACE="$capture_trace" \
  "$capture_cli" -vv elektron:data-sample:rm "$capture_device:/1" >"$capture_stdout" 2>"$capture_stderr"; then
  capture_status=0
else
  capture_status=$?
fi

printf '{"format":"sympakt-syntakt-capture/v1","intent":"authorized-slot-1-clear-capture","operation":"clear-slot","device":%s,"slot":1,"elektroidCommit":"%s","exitStatus":%s}\n' \
  "$capture_device" "$capture_commit" "$capture_status" >"$capture_directory/manifest.json"

if [ "$capture_status" -eq 0 ]; then
  echo "Captured authorized slot-1 clear to $capture_directory"
else
  echo "Clear failed; slot 1 state is unknown. Do not retry automatically; inspect before restoring." >&2
fi
exit "$capture_status"
