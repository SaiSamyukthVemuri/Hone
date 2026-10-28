#!/bin/zsh
HOME_S="$HOME/hone-s1"; . "$HOME_S/stub.cfg"
read -rs PGPASSWORD
[ "$(printf '%s' "$PGPASSWORD" | shasum -a 256 | cut -d' ' -f1)" = "$PWH" ] || { echo "bad password"; exit 1; }
echo "wd started" >> "$HOME_S/stub.log"
[ "${WD_MODE:-ok}" != silent ] || { sleep 3; exit 1; }
print -r -- "12:00:00 WATCHDOG armed (self-test ok). Ignoring already-active postgres-role backends: [none]."
print -r -- "12:00:01 watching for the push session to start (nothing new is active yet)"
sleep 120
