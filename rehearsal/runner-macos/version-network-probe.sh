#!/bin/bash
# R4 measurement: does supabase-go make a network call for --version, and what does a seeded supabase/.temp/cli-latest change?
# The binary is run with telemetry off, no GitHub token, and HTTPS_PROXY/HTTP_PROXY/ALL_PROXY pointing at a refusing local sink
# that records every connection attempt. Only --version and `db query --help` are run: no --linked, no hosted call.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
BIN="${1:?path to the installed supabase-go}"
T="$(mktemp -d "${RUNNER_TEMP:-/tmp}/probe.XXXXXX")"
PORT=18765
python3 "$HERE/proxy-sink.py" "$PORT" "$T/sink.log" & SINK=$!
sleep 1
probe() { # label cwd args...
  label="$1"; cwd="$2"; shift 2; : > "$T/sink.log"
  out="$( cd "$cwd" && env -u GITHUB_TOKEN -u GH_TOKEN SUPABASE_TELEMETRY_DISABLED=1 DO_NOT_TRACK=1 HTTPS_PROXY="http://127.0.0.1:$PORT" HTTP_PROXY="http://127.0.0.1:$PORT" ALL_PROXY="http://127.0.0.1:$PORT" NO_PROXY="" "$BIN" "$@" 2>&1 | head -3 | tr '\n' '|' )"; rc=${PIPESTATUS[0]:-0}
  sleep 1
  echo "--- $label"; echo "    cmd: supabase-go $*"; echo "    output (first lines): $out"
  echo "    outbound attempts seen by the sink: $(grep -c . "$T/sink.log")"; sed 's/^/      /' "$T/sink.log"
}
mkdir -p "$T/none" "$T/seeded/supabase/.temp"
echo "v2.102.0" > "$T/seeded/supabase/.temp/cli-latest"
probe "A: --version, no cli-latest" "$T/none" --version
probe "B: --version, fresh cli-latest seeded" "$T/seeded" --version
probe "C: db query --help, no cli-latest" "$T/none" --agent no db query --help
probe "D: db query --help, fresh cli-latest seeded" "$T/seeded" --agent no db query --help
kill $SINK 2>/dev/null
echo "cli-latest after the seeded runs: [$(cat "$T/seeded/supabase/.temp/cli-latest")]"
