#!/bin/bash
# HON66 launcher for the Linux gate scripts. It passes credential FILE PATHS (never values) to ONE reviewed gate script in a clean
# environment. It never reads the files, never prints them, and never puts a credential on a command line: only the two paths travel,
# as environment names HONE_GATE_TOKEN_FILE / HONE_GATE_PASSWORD_FILE, and the gate script reads and validates the files itself
# (absolute, regular, no symlink, one hard link, owner, mode 600, one line).
#   hone-gate-launch.sh [--token-file PATH] [--password-file PATH] -- GATE-SCRIPT
# Which credential each gate takes is fixed here: a missing REQUIRED one, or a FORBIDDEN one, is refused before the script starts.
set -u
die() { echo "launcher: STOP: $*" >&2; exit 1; }
tf=""; pf=""
while [ $# -gt 0 ]; do
  case "$1" in
    --token-file) [ $# -ge 2 ] || die "--token-file needs a path"; tf="$2"; shift 2 ;;
    --password-file) [ $# -ge 2 ] || die "--password-file needs a path"; pf="$2"; shift 2 ;;
    --) shift; break ;;
    *) die "unknown argument (only --token-file, --password-file, --, then the gate script)" ;;
  esac
done
[ $# -eq 1 ] || die "exactly one gate script after --"
gate="$1"
case "$(basename "$gate")" in
  window-s0a.sh|window-s1read.sh|window-gap-read.sh) need_t=1; need_p=1 ;;      # reads: one PAT (Database Read + Backups Read) and a present password
  pitr-backups.sh) need_t=1; need_p=0 ;;                                        # backups list: the PAT only, no password
  window-row4.sh) need_t=0; need_p=0 ;;                                         # no hosted call, no credential
  *) die "not one of the reviewed gate scripts: $(basename "$gate")" ;;
esac
[ -f "$gate" ] && [ ! -L "$gate" ] || die "the gate script is missing or a symlink"
if [ "$need_t" = 1 ]; then [ -n "$tf" ] || die "this gate needs --token-file"; else [ -z "$tf" ] || die "this gate takes no token (refused)"; fi
if [ "$need_p" = 1 ]; then [ -n "$pf" ] || die "this gate needs --password-file"; else [ -z "$pf" ] || die "this gate takes no database password (refused)"; fi
for p in $tf $pf; do case "$p" in /*) ;; *) die "credential file paths must be absolute" ;; esac; done
nodebin=$(command -v node) || die "node not found"
pathv="/usr/local/bin:/usr/bin:/bin:$(dirname "$nodebin")"
args=(env -i HOME="$HOME" PATH="$pathv" TERM="${TERM:-dumb}" LANG="${LANG:-C}")
[ -z "$tf" ] || args+=(HONE_GATE_TOKEN_FILE="$tf")
[ -z "$pf" ] || args+=(HONE_GATE_PASSWORD_FILE="$pf")
exec "${args[@]}" /bin/bash "$gate"
