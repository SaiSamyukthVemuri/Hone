#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Install Playwright's system packages for ONE browser (chromium by default;
# `webkit` for the non-required HON-62 WebKit job) without letting a slow apt
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
#   2. BOUND: the install runs under `timeout $FIRST` (90 s) INSIDE the
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
#      archive.ubuntu.com; then retries once under `timeout $RETRY` (150 s).
#      Any other failure is returned as-is: a missing package is not a slow
#      mirror.
#   3. SAVE: apt's downloaded .debs are copied back for actions/cache/save.
#
# TWO CAUSES THE CACHE ALONE DID NOT FIX (2026-11-18, runs 44343337165, 44374723706, 44358611145, 44359058464, and the WebKit
# job on #1584 and #1587; 0 tests run in each):
#   a. APT UPGRADED PACKAGES THE IMAGE ALREADY HAS. `npx playwright install-deps` is `apt-get install` of a package list, and
#      `apt-get install` upgrades an already-installed package when the mirror has a newer one. The runner image carries the
#      mesa libraries; the mirror's noble-updates moved ahead (25.2.8-0ubuntu0.24.04.5), so "4 upgraded" (libgbm1,
#      libgl1-mesa-dri, libglx-mesa0, mesa-libgallium) came on top of the cached packages: restored 9 .debs, still "Need to get
#      11.0 MB", the 10.8 MB mesa-libgallium .deb crawling at 60-70 kB/s, cut at 90 s and again at 150 s. The cache key is
#      saved once (the save step is skipped on a hit), so it can never learn the newer .deb. Playwright needs those libraries
#      PRESENT, not newest, so the install now runs with APT::Get::Upgrade "false" (the config item of apt-get's --no-upgrade):
#      packages named on the command line are never upgraded when already installed. A genuinely NEW package that needs a
#      newer version of an installed one still pulls it in as a dependency. Everything else is the cached .debs.
#   b. THE RETRY'S MIRROR SWITCH WAS A NO-OP. It rewrote only azure.archive.ubuntu.com; these runners use a regional mirror
#      (us-east-2.ec2.archive.ubuntu.com), so the "retry on archive.ubuntu.com" hit the same slow host. Any <region>.archive
#      or <region>.ec2.archive host is now rewritten to archive.ubuntu.com.
#
# THE BOUNDS. 2026-10-23's apt step was bimodal: every healthy install
# (154 of 206 jobs, including the ~26 MB download) took <= 26 s and every
# stall took >= 150 s, nothing in between. 90 s is 3x the healthy maximum;
# 150 s for the retry is 5x. Worst case = (FIRST + KILL_AFTER) + SETTLE +
# (REPAIR + KILL_AFTER) + (RETRY + KILL_AFTER) = 100 + 10 + 55 + 160 = 325 s,
# which every workflow step running this script must EXCEED (timeout-minutes 6
# = 360 s; derived and enforced by tests/ci/ci-config.test.ts). A step cut by
# GitHub signals only the unprivileged shell, abandoning privileged cleanup.
#
# Every path is overridable so tests/ci/playwright-system-deps.test.ts can run
# this script for real against fakes, never against the host's /etc/apt.
# ---------------------------------------------------------------------------
set -euo pipefail

# The browser whose packages to install. Allow-listed: anything else is a
# typo in a workflow and fails before apt is touched.
BROWSER="${1:-chromium}"
case "$BROWSER" in
  chromium | webkit) ;;
  *)
    echo "::error::playwright-system-deps: unknown browser '$BROWSER' (chromium | webkit)"
    exit 2
    ;;
esac

CACHE_DIR="${PW_DEB_CACHE_DIR:-$HOME/apt-debs}"
ARCHIVES="${APT_ARCHIVES_DIR:-/var/cache/apt/archives}"
APT_CONF_DIR="${APT_CONF_DIR:-/etc/apt/apt.conf.d}"
MIRROR_FILES="${APT_MIRROR_FILES:-/etc/apt/apt-mirrors.txt /etc/apt/sources.list /etc/apt/sources.list.d/ubuntu.sources}"
FIRST="${PW_DEPS_FIRST_TIMEOUT:-90}"
RETRY="${PW_DEPS_RETRY_TIMEOUT:-150}"
KILL_AFTER="${PW_DEPS_KILL_AFTER:-10}"
SETTLE="${PW_DEPS_SETTLE_SECONDS:-10}"
REPAIR="${PW_DEPS_REPAIR_TIMEOUT:-45}"
LOCKS="${APT_LOCK_FILES:-/var/lib/dpkg/lock-frontend /var/lib/dpkg/lock /var/lib/apt/lists/lock /var/cache/apt/archives/lock}"

# The install, with its time limit inside sudo. PATH is passed explicitly
# because sudo's secure_path would hide the setup-node npx.
install_deps() {
  sudo env "PATH=$PATH" timeout --kill-after="$KILL_AFTER" "$1" npx playwright install-deps "$BROWSER"
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

# Never upgrade a package the image already has (cause a. above). Written before anything runs apt.
echo 'APT::Get::Upgrade "false";' | sudo tee "$APT_CONF_DIR/99playwright-no-upgrade" > /dev/null

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
  sudo timeout --kill-after="$KILL_AFTER" "$REPAIR" dpkg --configure -a
  for f in $MIRROR_FILES; do
    if [ -f "$f" ]; then sudo sed -i -E 's#([a-z0-9-]+\.)+archive\.ubuntu\.com#archive.ubuntu.com#g' "$f"; fi
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
