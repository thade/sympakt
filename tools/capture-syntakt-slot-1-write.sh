#!/bin/sh
# Capture one explicitly authorized, non-recursive write to global slot 1.
# This is intentionally not a general upload tool: it can never target any
# other slot and requires a fresh acknowledgement on every invocation.

set -u

if [ "$#" -lt 2 ] || [ "$#" -gt 3 ]; then
  echo "Usage: SYMPAKT_SLOT_1_WRITE_ACK=I_AUTHORIZE_SLOT_1 $0 OUTPUT_DIRECTORY INPUT.wav [DEVICE_NUMBER]" >&2
  exit 64
fi

if [ "${SYMPAKT_SLOT_1_WRITE_ACK:-}" != "I_AUTHORIZE_SLOT_1" ]; then
  echo "Refusing slot 1 overwrite without SYMPAKT_SLOT_1_WRITE_ACK=I_AUTHORIZE_SLOT_1." >&2
  exit 77
fi

capture_directory=$1
input_wav=$2
capture_device=${3:-1}

case "$capture_device" in '' | *[!0-9]*) echo "DEVICE_NUMBER must be a non-negative integer." >&2; exit 64;; esac
if [ ! -f "$input_wav" ]; then echo "Input WAV does not exist: $input_wav" >&2; exit 66; fi
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
  "$capture_cli" -vv elektron:data-sample:ul "$input_wav" "$capture_device:/1" >"$capture_stdout" 2>"$capture_stderr"; then
  capture_status=0
else
  capture_status=$?
fi

input_sha256=$(shasum -a 256 "$input_wav" | awk '{print $1}')
printf '{"format":"sympakt-syntakt-capture/v1","intent":"authorized-slot-1-write-capture","operation":"upload-slot","device":%s,"slot":1,"inputSha256":"%s","elektroidCommit":"%s","exitStatus":%s}\n' \
  "$capture_device" "$input_sha256" "$capture_commit" "$capture_status" >"$capture_directory/manifest.json"

if [ "$capture_status" -eq 0 ]; then
  echo "Captured authorized slot-1 upload to $capture_directory"
else
  echo "Capture failed; slot 1 state is now unknown. Do not retry automatically; inspect before restoring." >&2
fi
exit "$capture_status"
