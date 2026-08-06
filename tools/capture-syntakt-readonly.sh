#!/bin/sh
# Capture a strictly read-only Elektroid/Syntakt MIDI transcript.
#
# Requires the locally instrumented Elektroid checkout at
# ../../thirdparty/elektroid by default. Override ELEKTROID_CLI to use another
# capture build. The script never invokes a write, rename, or delete command.

set -u

if [ "$#" -lt 2 ] || [ "$#" -gt 4 ]; then
  echo "Usage: $0 {info|list-root} OUTPUT_DIRECTORY [DEVICE_NUMBER]" >&2
  echo "       $0 download-slot OUTPUT_DIRECTORY SLOT_NUMBER [DEVICE_NUMBER]" >&2
  exit 64
fi

capture_operation=$1
capture_directory=$2
capture_device=${3:-1}
capture_slot=''

case "$capture_operation" in
  info)
    set -- info "$capture_device"
    ;;
  list-root)
    set -- elektron:data-sample:ls "$capture_device:/"
    ;;
  download-slot)
    if [ "$#" -lt 3 ] || [ "$#" -gt 4 ]; then
      echo "download-slot requires SLOT_NUMBER and an optional DEVICE_NUMBER." >&2
      exit 64
    fi
    capture_slot=$3
    capture_device=${4:-1}
    set -- elektron:data-sample:dl "$capture_device:/$capture_slot" "$capture_directory/download"
    ;;
  *)
    echo "Only info, list-root, and download-slot are permitted." >&2
    exit 64
    ;;
esac

case "$capture_device" in
  '' | *[!0-9]*)
    echo "DEVICE_NUMBER must be a non-negative integer." >&2
    exit 64
    ;;
esac

case "$capture_slot" in
  '' | *[!0-9]*)
    if [ "$capture_operation" = download-slot ]; then
      echo "SLOT_NUMBER must be a positive integer." >&2
      exit 64
    fi
    ;;
  0)
    echo "SLOT_NUMBER must be a positive integer." >&2
    exit 64
    ;;
esac

if [ -e "$capture_directory" ]; then
  echo "Refusing to overwrite existing capture path: $capture_directory" >&2
  exit 73
fi

capture_script_directory=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
capture_source_directory="$capture_script_directory/../../../thirdparty/elektroid"
capture_cli=${ELEKTROID_CLI:-"$capture_source_directory/.capture-install/bin/elektroid-cli"}

if [ ! -x "$capture_cli" ]; then
  echo "Tracing Elektroid CLI is not executable: $capture_cli" >&2
  exit 69
fi

mkdir -p "$capture_directory"
if [ "$capture_operation" = download-slot ]; then
  mkdir -p "$capture_directory/download"
fi

capture_commit=$(git -C "$capture_source_directory" rev-parse HEAD 2>/dev/null || printf 'unknown')
capture_trace="$capture_directory/trace.ndjson"
capture_stdout="$capture_directory/stdout.txt"
capture_stderr="$capture_directory/stderr.txt"

if ELEKTROID_DISABLE_STOP_ON_CONNECT=1 \
  ELEKTROID_SYSEX_TRACE="$capture_trace" \
  "$capture_cli" -vv "$@" >"$capture_stdout" 2>"$capture_stderr"; then
  capture_status=0
else
  capture_status=$?
fi

if [ "$capture_status" -eq 0 ] && [ "$capture_operation" = download-slot ]; then
  find "$capture_directory/download" -maxdepth 1 -type f -exec shasum -a 256 {} \; >"$capture_directory/download.sha256"
fi

if [ -n "$capture_slot" ]; then
  capture_slot_json=$capture_slot
else
  capture_slot_json=null
fi
printf '{"format":"sympakt-syntakt-capture/v1","intent":"read-only","operation":"%s","device":%s,"slot":%s,"elektroidCommit":"%s","exitStatus":%s}\n' \
  "$capture_operation" "$capture_device" "$capture_slot_json" "$capture_commit" "$capture_status" >"$capture_directory/manifest.json"

if [ "$capture_status" -eq 0 ]; then
  echo "Captured $capture_operation to $capture_directory"
else
  echo "Capture failed; see $capture_stderr" >&2
fi

exit "$capture_status"
