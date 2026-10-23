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
#   2. BOUND: the install runs under `timeout $FIRST` (180 s) INSIDE the
#      privileged boundary: `sudo ... timeout ... npx playwright install-deps`.
#      As root, Playwright runs apt-get itself (no nested sudo), so the whole
#      apt/dpkg tree is in the root-owned timeout's process group and is
#      killed with it. An unprivileged timeout could kill npx but not the
#      root apt-get, which kept the dpkg/apt locks while the retry started
#      (Codex P1 r4362059036, #1059).
#      On a TIMEOUT only, before retrying it: waits for every apt-get/dpkg
#      process and apt lock holder to be gone, and fails loudly if one
#      survives the settle window; runs `dpkg --configure -a` in case dpkg
#      was interrupted mid-install; switches the mirror to
#      archive.ubuntu.com; then retries once under `timeout $RETRY` (300 s).
#      Any other failure is returned as-is: a missing package is not a slow
#      mirror.
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
KILL_AFTER="${PW_DEPS_KILL_AFTER:-10}"
SETTLE="${PW_DEPS_SETTLE_SECONDS:-15}"
LOCKS="${APT_LOCK_FILES:-/var/lib/dpkg/lock-frontend /var/lib/dpkg/lock /var/lib/apt/lists/lock /var/cache/apt/archives/lock}"

# The install, with its time limit inside sudo. PATH is passed explicitly
# because sudo's secure_path would hide the setup-node npx.
install_deps() {
  sudo env "PATH=$PATH" timeout --kill-after="$KILL_AFTER" "$1" npx playwright install-deps chromium
}

# Prints what still holds apt: a live apt-get/dpkg/apt-method process, or a
# process with an apt lock file open. Prints nothing when apt is quiet.
apt_busy() {
  pgrep -a -x apt-get || true
  pgrep -a -x dpkg || true
  pgrep -a -f '/usr/lib/apt/methods/' || true
  for lock in $LOCKS; do
    if [ -e "$lock" ] && sudo fuser "$lock" > /dev/null 2>&1; then echo "lock held: $lock"; fi
  done
}

mkdir -p "$CACHE_DIR"

restored=0
if compgen -G "$CACHE_DIR/*.deb" > /dev/null; then
  sudo cp "$CACHE_DIR"/*.deb "$ARCHIVES"/
  restored=$(compgen -G "$CACHE_DIR/*.deb" | wc -l)
fi
echo "playwright-system-deps: restored ${restored} cached .deb file(s)"

status=0
install_deps "$FIRST" || status=$?
if [ "$status" -eq 124 ] || [ "$status" -eq 137 ]; then
  echo "::warning::Playwright system packages did not install within ${FIRST}s (a slow apt mirror); retrying once on archive.ubuntu.com"
  # The timed-out tree must really be gone before anything touches apt again.
  waited=0
  busy="$(apt_busy)"
  while [ -n "$busy" ] && [ "$waited" -lt "$SETTLE" ]; do
    sleep 1
    waited=$((waited + 1))
    busy="$(apt_busy)"
  done
  if [ -n "$busy" ]; then
    echo "::error::apt is still busy ${SETTLE}s after the timed-out install was killed; not retrying into a held lock:"
    echo "$busy"
    exit 1
  fi
  # A kill mid-install can leave dpkg half-configured; finish it first.
  sudo timeout --kill-after="$KILL_AFTER" 120 dpkg --configure -a
  for f in $MIRROR_FILES; do
    if [ -f "$f" ]; then sudo sed -i 's|azure\.archive\.ubuntu\.com|archive.ubuntu.com|g' "$f"; fi
  done
  install_deps "$RETRY"
elif [ "$status" -ne 0 ]; then
  exit "$status"
fi

saved=0
if compgen -G "$ARCHIVES/*.deb" > /dev/null; then
  cp "$ARCHIVES"/*.deb "$CACHE_DIR"/
  saved=$(compgen -G "$CACHE_DIR/*.deb" | wc -l)
fi
echo "playwright-system-deps: ${saved} .deb file(s) available for the cache save"
