# REHEARSAL STUB helpers (not the reviewed children). Prompts are the REAL prompt strings (check-mac.sh asserts each one occurs in reference/).
S="$HOME/hone-s1"; . "$S/stub.cfg"
slog() { echo "$1" >> "$S/stub.log"; }
sdie() { slog "$ME: STOP $*"; echo "STOP: $*" >&2; exit 1; }
hsha() { printf '%s' "$1" | shasum -a 256 | cut -d' ' -f1; }
sask() { local _v; IFS= read -r -p "$2" _v </dev/tty || sdie "no tty"; [ -z "${3:-}" ] || [ "$_v" = "$3" ] || sdie "$1: unexpected answer"; printf -v "$1" '%s' "$_v"; slog "$ME: $1 answered"; }
ssecret() { local _v; IFS= read -rs -p "$2" _v </dev/tty || sdie "no tty"; echo >&2; [ "$(hsha "$_v")" = "$3" ] || sdie "$1: authentication failed"; slog "$ME: $1 accepted"; }
