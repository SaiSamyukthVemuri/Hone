#!/bin/bash
# INSTALLER-MACOS negatives. Run on the macOS runner after the positive install. For each case: a COPY of the
# installer with exactly ONE expected-sha constant changed (one hex digit), a fresh HOME and a fresh TMPDIR.
# Asserts: exactly one STOP line, exit 1, nothing at $HOME/hone-s1/supabase-cli, and no execution of any
# downloaded binary (the sh -x trace never shows the --version call and the CLI's own output is absent).
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
INST="${INSTALLER:-$HERE/hone-s1-install.sh}"
EV="${RUNNER_TEMP:-/tmp}/installer-evidence${EVIDENCE_SUFFIX:-}"; mkdir -p "$EV"
fails=0
note() { echo "$*"; }
bad() { fails=$((fails+1)); echo "FAIL: $*"; }

flip() { # flip <VAR> : change the first hex digit of that constant in a copy, print the copy's path
  var="$1"; copy="$EV/install-$var.sh"
  cp "$INST" "$copy"
  line="$(grep -n "^$var=" "$copy" | cut -d: -f1)"
  [ -n "$line" ] || { echo "no such constant $var" >&2; exit 2; }
  old="$(sed -n "${line}p" "$copy")"; val="${old#*=}"; first="${val%"${val#?}"}"
  if [ "$first" = "0" ]; then new_first=1; else new_first=0; fi
  sed "${line}s/=$first/=$new_first/" "$copy" > "$copy.tmp" && mv "$copy.tmp" "$copy"
  changed="$(diff "$INST" "$copy" | grep -c '^>')"
  [ "$changed" = 1 ] || { echo "expected exactly one changed line in the copy of $var, got $changed" >&2; exit 2; }
  echo "$copy"
}
runcase() { # runcase <label> <script> [pre-hook]
  label="$1"; script="$2"
  h="$(mktemp -d "$EV/home.XXXXXX")"; t="$(mktemp -d "$EV/tmp.XXXXXX")"
  [ -n "${3:-}" ] && "$3" "$h"
  out="$EV/$label.out"; trace="$EV/$label.trace"
  ( cd "$EV" && HOME="$h" TMPDIR="$t" /bin/sh -x "$script" > "$out" 2> "$trace" ); rc=$?
  stops="$(grep -c '^STOP:' "$trace" || true)"
  note "----- $label"
  note "exit: $rc"; note "STOP lines on stderr: $stops"; grep '^STOP:' "$trace" | sed 's/^/  /'
  [ "$rc" = 1 ] || bad "$label: exit $rc, want 1"
  [ "$stops" = 1 ] || bad "$label: $stops STOP lines, want exactly 1"
  if [ "$label" = codesign-failure ]; then
    # v2 moves supabase-go into place BEFORE it runs codesign, so on this STOP the (hash-verified, unsigned-check-failed)
    # file remains installed, unexecuted. Reported as a finding; asserted exactly.
    if [ -e "$h/hone-s1/supabase-cli" ]; then note "FINDING: destination remains after a codesign STOP; contents: [$(ls "$h/hone-s1/supabase-cli" | tr '\n' ' ')]"; fi
    [ "$(ls "$h/hone-s1/supabase-cli" 2>/dev/null | tr '\n' ' ')" = "supabase-go " ] || bad "$label: expected only supabase-go to remain"
  else
    [ ! -e "$h/hone-s1/supabase-cli" ] || { [ "$label" = existing-destination ] || bad "$label: $h/hone-s1/supabase-cli exists"; }
  fi
  # no execution of anything downloaded: the version call and its env never appear in the trace, and no CLI output
  if grep -q -e 'SUPABASE_TELEMETRY_DISABLED' -e '--version' "$trace"; then bad "$label: the --version execution appears in the trace"; else note "no execution: the --version call never appears in the shell trace"; fi
  if grep -q -e 'Supabase CLI' -e 'Usage:' "$out" "$trace"; then bad "$label: CLI output present"; else note "no execution: no CLI output"; fi
  # a downloaded binary invoked as a COMMAND would be a trace line whose first word is a path ending in /supabase or /supabase-go
  if grep -E '^\++ +[^ ]*/supabase(-go)?( |$)' "$trace" >/dev/null; then bad "$label: a binary was invoked"; else note "no execution: no trace line runs x/supabase, supabase-go or the installed binary as a command"; fi
}

# the four constants of the assignment
runcase archive-sha "$(flip SHA_ARCHIVE)"
runcase checksums-sha "$(flip SHA_CHECKSUMS)"
runcase inner-supabase-sha "$(flip SHA_SUPABASE)"
runcase inner-supabase-go-sha "$(flip SHA_SUPABASE_GO)"
# an existing destination
mkdest() { mkdir -p "$1/hone-s1/supabase-cli"; }
runcase existing-destination "$INST" mkdest
# extra: tamper the DOWNLOAD itself (a curl shim appends one byte), which reaches the archive/checksums hash checks
mkdir -p "$EV/shim"
cat > "$EV/shim/curl" <<'SH'
#!/bin/sh
# real curl, then tamper the file named by -o if it matches $TAMPER
real=/usr/bin/curl
"$real" "$@" || exit $?
out=""; prev=""; for a in "$@"; do [ "$prev" = "-o" ] && out="$a"; prev="$a"; done
[ "$out" = "$TAMPER" ] && printf 'x' >> "$out"
exit 0
SH
chmod +x "$EV/shim/curl"
for tamper in supabase_2.102.0_darwin_arm64.tar.gz checksums.txt; do
  PATH="$EV/shim:$PATH" TAMPER="$tamper" runcase "tampered-download-$tamper" "$INST"
done
if [ "${STUB_CODESIGN:-}" = 1 ]; then
  # v2 codesign-failure case WITHOUT re-signing or touching the system: a COPY of the installer whose two
  # /usr/bin/codesign references point at a stub that exits 1. Only the path in the copy changes.
  mkdir -p "$EV/stub"
  printf '#!/bin/sh\necho "stub codesign: invalid signature (simulated)" >&2\nexit 1\n' > "$EV/stub/codesign"; chmod +x "$EV/stub/codesign"
  cp "$INST" "$EV/install-codesign-stub.sh"
  n="$(grep -c '/usr/bin/codesign' "$EV/install-codesign-stub.sh")"
  sed "s#/usr/bin/codesign#$EV/stub/codesign#g" "$EV/install-codesign-stub.sh" > "$EV/install-codesign-stub.sh.tmp" && mv "$EV/install-codesign-stub.sh.tmp" "$EV/install-codesign-stub.sh"
  note "codesign-stub copy: $n lines changed (path only)"
  runcase codesign-failure "$EV/install-codesign-stub.sh"
  grep -q '^STOP: codesign rejects supabase-go; not running it' "$EV/codesign-failure.trace" && note "STOP text is the codesign refusal" || bad "codesign-failure: wrong STOP text"
fi
echo "negative failures: $fails"
[ "$fails" -eq 0 ]
