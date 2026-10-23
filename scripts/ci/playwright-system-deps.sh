#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Install Playwright's Chromium system packages without letting a slow apt
# mirror consume a job's time budget.
#
# On 2026-10-23 every ceiling cancellation (6 of 6) was this install crawling
# at ~45 kB/s from the runner's default Ubuntu mirror for up to 11.3 minutes
# while the tests themselves passed (machines/SETUP-TIME-MEASURE-END.json).
# The package index arrived at MB/s; only the .deb downloads stalled. So:
#
#   1. RESTORE: .debs saved by an earlier job (actions/cache/restore, keyed on
#      runner image + Playwright version) are copied into apt's archive dir,
#      so an unchanged package set downloads nothing.
#   2. BOUND: the install runs under `timeout $FIRST` (180 s). On a TIMEOUT
#      only, the apt mirror is switched to archive.ubuntu.com and the install
#      is retried once under `timeout $RETRY` (300 s). Any other failure is
#      returned as-is: a missing package is not a slow mirror.
#   3. SAVE: apt's downloaded .debs are copied back for actions/cache/save.
#
# Every path is overridable so tests/ci/playwright-system-deps.test.ts can run
# this script for real against fakes, never against the host's /etc/apt.
# ---------------------------------------------------------------------------
set -euo pipefail

CACHE_DIR="${PW_DEB_CACHE_DIR:-$HOME/apt-debs}"
ARCHIVES="${APT_ARCHIVES_DIR:-/var/cache/apt/archives}"
MIRROR_FILES="${APT_MIRROR_FILES:-/etc/apt/apt-mirrors.txt /etc/apt/sources.list /etc/apt/sources.list.d/ubuntu.sources}"
FIRST="${PW_DEPS_FIRST_TIMEOUT:-180}"
RETRY="${PW_DEPS_RETRY_TIMEOUT:-300}"

mkdir -p "$CACHE_DIR"

restored=0
if compgen -G "$CACHE_DIR/*.deb" > /dev/null; then
  sudo cp "$CACHE_DIR"/*.deb "$ARCHIVES"/
  restored=$(compgen -G "$CACHE_DIR/*.deb" | wc -l)
fi
echo "playwright-system-deps: restored ${restored} cached .deb file(s)"

status=0
timeout --kill-after=15 "$FIRST" npx playwright install-deps chromium || status=$?
if [ "$status" -eq 124 ] || [ "$status" -eq 137 ]; then
  echo "::warning::Playwright system packages did not install within ${FIRST}s (a slow apt mirror); retrying once on archive.ubuntu.com"
  for f in $MIRROR_FILES; do
    if [ -f "$f" ]; then sudo sed -i 's|azure\.archive\.ubuntu\.com|archive.ubuntu.com|g' "$f"; fi
  done
  timeout --kill-after=15 "$RETRY" npx playwright install-deps chromium
elif [ "$status" -ne 0 ]; then
  exit "$status"
fi

saved=0
if compgen -G "$ARCHIVES/*.deb" > /dev/null; then
  cp "$ARCHIVES"/*.deb "$CACHE_DIR"/
  saved=$(compgen -G "$CACHE_DIR/*.deb" | wc -l)
fi
echo "playwright-system-deps: ${saved} .deb file(s) available for the cache save"
