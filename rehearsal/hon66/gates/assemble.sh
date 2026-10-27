#!/bin/bash
# HON66: assemble the Linux gate test tree (reproducible; run from rehearsal/hon66/gates). Sources: the reviewed c5 data tree in
# ../../candidate4/window-reads-c4 (SQL, manifest, comparator, lib, G3, fixtures) and the Linux variants + launcher in LG (machines/linux-gates).
set -eu
LG="${LG:-/home/sam/hone-handoffs/2026-10-18/machines/linux-gates}"
H="$(cd "$(dirname "$0")" && pwd)"
C4="$H/../../candidate4/window-reads-c4"
rm -rf "$H/window-reads-c4"; mkdir -p "$H/window-reads-c4"
cp -r "$C4"/. "$H/window-reads-c4/"
cd "$H/window-reads-c4"
rm -f run-window-read-macos.sh run-window-read-macos.test.sh window-s0a.sh window-row4.sh *.c4 BASELINE-W1-MACOS-* DOWNLOAD-C4.txt WINDOW-COMMAND-MACOS-C4.md BASELINE-PROPOSED.json BASELINE-MACOS-PROPOSED.json
cp "$LG/window-s0a-linux.sh" window-s0a.sh; cp "$LG/window-row4-linux.sh" window-row4.sh
cp "$LG/BASELINE-W1-LINUX-CANDIDATE-5.json" .
cp /home/sam/hone-handoffs/2026-10-18/machines/window-reads-c4/run-window-read.sh .
cp "$LG/hone-push-guard.sh" "$LG/hone-push-linux.sh" "$H/"; cp "$LG/hone-gate-launch.sh" "$LG/pitr-backups-linux.sh" "$LG/window-s1read-linux.sh" "$LG/window-gap-read-linux.sh" "$LG/BASELINE-W1-LINUX-CANDIDATE-3.json" "$LG/make-linux.py" "$LG/LINUX-DIFFS.txt" "$H/"
chmod 755 "$H/hone-push-guard.sh" "$H/hone-push-linux.sh" "$H/hone-gate-launch.sh" window-s0a.sh window-row4.sh run-window-read.sh
# the S1 read-back tree: comparator c3 data in window-reads/, the six S1 gate files + manifest + Linux runner in window-reads-s1/
rm -rf "$H/window-reads" "$H/window-reads-s1"; mkdir -p "$H/window-reads" "$H/window-reads-s1"
cp "$H/../../window-script/window-reads/compare-preflight.mjs" "$H/../../window-script/window-reads/compare-preflight-lib.mjs" "$H/window-reads/"
cp "$LG/BASELINE-W1-LINUX-CANDIDATE-3.json" "$H/../../window-script/window-reads/census-0213-0246.sql" "$H/window-reads/"
cp "$H/../../s1-read/window-reads-s1"/*.sql "$H/../../s1-read/window-reads-s1/MANIFEST.sha256" "$H/window-reads-s1/"
cp "$LG/window-s1read-linux.sh" "$H/window-reads-s1/window-s1read.sh"; chmod 755 "$H/window-reads-s1/window-s1read.sh"
cp /home/sam/hone-handoffs/2026-10-18/machines/window-reads-c4/run-window-read.sh "$H/window-reads-s1/"
cp "$H/../../s1-read/gen-s1-results.mjs" "$H/"
# the gap-read package: pinned SQL + MANIFEST.v2 + the original Linux runner + the Linux wrapper
rm -rf "$H/gap-pkg"; mkdir -p "$H/gap-pkg"
cp "$H/../../gap-read/pkg/obs-1035-gap-pending-payments-v2.sql" "$H/../../gap-read/pkg/MANIFEST.v2.sha256" "$H/gap-pkg/"
cp /home/sam/hone-handoffs/2026-10-18/machines/window-reads-c4/run-window-read.sh "$H/gap-pkg/"
cp "$LG/window-gap-read-linux.sh" "$H/gap-pkg/window-gap-read.sh"; chmod 755 "$H/gap-pkg/window-gap-read.sh"
cp "$H/../../gap-read/driver.py" "$H/gap-driver.py" 2>/dev/null || true
# gen-capture binds its synthetic capture to the CURRENT Linux pitr-backups script
PS=$(sha256sum "$H/pitr-backups-linux.sh" | cut -d' ' -f1); sed -i -E "s/script_sha256: \"[0-9a-f]{64}\"/script_sha256: \"$PS\"/" "$H/gen-capture.mjs"
# the install stage: the layout the gates expect under ~/hone-s1, plus a manifest of every file
rm -rf "$H/stage"; S="$H/stage"; mkdir -p "$S/window-reads-c4" "$S/window-reads" "$S/window-reads-s1" "$S/gap-read-2" "$S/bin"
cp -r "$H/window-reads-c4"/. "$S/window-reads-c4/"; cp "$H/window-reads"/* "$S/window-reads/"; cp "$H/window-reads-s1"/* "$S/window-reads-s1/"
cp "$H/gap-pkg/obs-1035-gap-pending-payments-v2.sql" "$H/gap-pkg/run-window-read.sh" "$H/gap-pkg/window-gap-read.sh" "$S/gap-read-2/"; cp "$H/gap-pkg/MANIFEST.v2.sha256" "$S/gap-read-2/MANIFEST.sha256"
cp "$H/pitr-backups-linux.sh" "$S/bin/pitr-backups.sh"; cp "$H/hone-gate-launch.sh" "$H/hone-push-guard.sh" "$H/hone-push-linux.sh" "$S/bin/"
( cd "$S" && find . -type f ! -name LINUX-MANIFEST.sha256 | sed 's#^\./##' | LC_ALL=C sort | xargs sha256sum > LINUX-MANIFEST.sha256 )
echo assembled
