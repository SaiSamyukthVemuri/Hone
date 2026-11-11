# HON-73: move all Actions compute to the VPS

Prepared 2026-11-11 UTC (2026-11-10 Toronto). This is a draft cutover,
not a deployed runner. Keep Hone private. No merge, billing change, repository
transfer, production deploy or host cleanup is included.

## Candidate and scope

This change is stacked on PR #1421 at
`f69cc206ecd150a589513f9760401fb984b97dc1`. Merge/rebase that routing repair
first, then refresh this candidate against the accepted head. Its projected
15% usage reduction is historical replay, not a live measured saving and not
enough evidence that this VPS can absorb the entire historical workload.

| Workflow | Job definitions | Candidate execution |
| --- | ---: | --- |
| PR / production CI | 11 | VPS, including changed-path detection and the stable browser aggregator |
| Nightly full matrix | 1, expanded to 9 matrix jobs | VPS, every original lane retained |
| Synthetic restore drill | 1 | VPS only inside an isolated disposable job container |

All 13 definitions select `[self-hosted, linux, x64, hone-ci-ubuntu-24.04]`.
There is no hosted fallback or variable that silently restores billed compute.
An offline runner leaves jobs queued and checks unsatisfied. The guard fails
before checkout on a bare host, the wrong OS or an image without the
root-owned marker. The marker is an operator provisioning contract, NOT
cryptographic attestation or proof of isolation.

Existing job names, dependencies, selection conditions, timeouts, test commands,
matrix entries, SHA-pinned actions, read permissions, checkout credential
settings, package-login/logout fence, caches and artifact retention are retained.
Do not remove or weaken a test to make a new runner green.

## Current evidence and access limit

- Production reviewed at `48186bde883754f3135585aecfd20a1916ee478a`.
- The latest queried nightly run `42844209222` failed all nine jobs before a
  runner was assigned (empty runner names; 3–4 seconds). This does not prove
  application failures. Account billing/access diagnostics still need inspection.
- OPS previously estimated 231,000 job-minutes/month: roughly 5.3 workers
  continuously busy and peak concurrency 29. These are prior OPS estimates,
  not a fresh billing export. One pilot cannot promise this throughput.
- Sam's last VPS output had 108 GiB free on root. Preserve an 80 GiB root
  reserve; the 30 GiB per-job disk budget now belongs to the separate CI Volume
  described below. These are conservative proposals, not measured peaks.
  Do not prune or delete to pass admission.
- This preparation environment has no route to `100.123.145.56`; SSH returns
  `Network is unreachable`. No runner has been registered or launched here.
- Sam's Mac-side checks confirm 108 GiB free on root, 28 GiB available RAM and
  all eight HON-8 QA containers still running. LXD 5.21.9 LTS was installed
  explicitly and its client/server versions responded. Initial inventories at
  03:44 UTC had no pools, instances or managed networks; the later pool-creation
  receipt below supersedes only the empty-pool inventory. The preflight
  checks the installed snap and invokes only the actual local client, avoiding
  Ubuntu's potentially mutating `/usr/sbin/lxc` installer wrapper.

### Dedicated CI storage

Sam created and attached `hone-ci-runners`, Volume `107429924`, in Helsinki
using manual filesystem management. The console reports 180 GB; Linux reports
193273528320 bytes (180 GiB), serial `107429924`, at the stable path
`/dev/disk/by-id/scsi-0HC_Volume_107429924` (currently `/dev/sdb`).
Before setup, his read-only check showed a whole disk, no filesystem or mountpoint,
and no signatures reported by `wipefs --no-act`.

Sam's 11 November terminal receipt now confirms `Storage pool hone-ci created`
after the pinned script verified the exact Volume and byte size. Read-back:
driver `lvm`, status `Created`, `lvm.use_thinpool=true`, VG `hone-ci`, thin pool
`LXDThinPool`, original source the exact by-id path above, ext4 volumes and
`volume.size=30GiB`, with `used_by: []`. LXD reports 179.82 GiB total and
18.74 GiB used. This is a pool-creation receipt, not a measured CI job peak or
a successful admission snapshot. Actual thin data/metadata and full logical
commitments still need the read-only LVM check before any job.

Pool choice: LVM thin provisioning with ext4 runner disks, default size 30 GiB.
This is a deliberate bounded-block layout compatible with Docker overlay2.
Btrfs qgroups are not a strict isolation limit for nested subvolumes and are
not the chosen enforcement mechanism. Snapshot/image size limits and total
thin-pool consumption still require live pilot proof and admission accounting.

`scripts/ci/create-vps-pool.py` defaults to read-only checks. Its explicit
`--create` mode initializes ONLY this exact newly verified blank Volume as
the `hone-ci` LXD pool, after repeating serial/byte-size, no-partition,
filesystem, mount, signature and existing-pool checks. A failed read stops it.
It has no force-wipe, force-reuse, removal, network or Docker action. Guard tests
run only against synthetic facts; Sam has now supplied the successful creation
receipt above. Do not rerun `--create` against this initialized pool. On any
later error/timeout, inspect the device and pool; never automatically wipe/retry.

Put the runner roots, nested Docker data, images and scratch in this pool.
Preserve the root reserve and inspect pool free/data/metadata consumption
separately. The preflight no longer uses the obsolete root-only 110 GiB sum.
Hetzner server backups do not cover attached Volumes, so
keep CI data reproducible/disposable and retain required evidence elsewhere.

`scripts/ci/check-vps-storage.py` is a read-only snapshot check, not a worker
launcher. Run the reviewed checkout via `sudo bash scripts/ci/vps-host-preflight.sh`
so LXD/LVM reads have permission; the script never escalates itself or grants
CI host access. It refuses a missing Volume or pool, a different serial/size,
a VG spanning root/another disk, a directory pool, changed ext4/30 GiB settings,
and inactive/unhealthy/unknown thin-pool state. It does not require a filesystem
mount on the whole disk: LVM/ext4 mounts belong to individual runner LVs.

Proposed single-pilot storage ceilings:

- Root free: at least 80 GiB, checked separately from the CI pool.
- Thin data free: at least 40 GiB (30 GiB new job plus 10 GiB pool reserve),
  with a conservative allowance for rounded LVM Data%.
- Existing thin LVs' full logical sizes, including images/snapshots, plus the
  new 30 GiB job and 10 GiB reserve must fit physically. Low current Data%
  alone does not prove room for already promised future writes.
- Thin metadata: strictly below 50%; invalid/missing reads refuse admission.
  This is a conservative proposed stop threshold, not a measured peak bound.

The future host supervisor must hold an exclusive admission lock, exclude
other pool writers and rerun the snapshot before each launch. A standalone
passing snapshot does not reserve space or prove memory, network or isolation.
Record actual data/metadata peaks and qualify exhaustion/cancellation recovery
before permitting unattended work. Pool creation is confirmed; network/image
setup, runner registration and live job execution are not yet evidenced.

## Exact provisioning scope for the pilot

Do this only from the VPS-connected OPS environment after reviewing the actual
disk, LXD storage and network state. No host-wide install script is supplied
because those facts are not available in this environment.

1. Run the reviewed `sudo bash scripts/ci/vps-host-preflight.sh` on the VPS.
   It reads capacity, existing Docker workloads and the separate LXD/LVM pool.
   An unavailable installed snap or failed storage policy exits 2; other failed
   commands also stop the script. It does not install, register, restart, prune
   or delete anything. Missing tools/access require inspection, never fallback.
2. Preserve the existing HON-8 QA containers, host Docker engine, production
   assets, backups, worktrees and rollback images. Export the current branch
   controls before any later required-check change. Do not grant CI access to
   Sam's home, repository worktrees, Docker/LXD sockets or provider credentials.
3. Provision ONE unprivileged LXD job container from a reviewed Ubuntu 24.04
   image. Require `security.privileged=false`, `security.idmap.isolated=true`
   and only the nesting features actually needed for the container's own
   Docker. Do not use an unconfined AppArmor profile, host devices, raw LXC
   overrides, host networking or a bind mount of a host Docker socket.
4. Apply a 6-vCPU / 12-GiB memory limit and a proven 30-GiB root-disk quota
   as initial proposed ceilings. Verify the storage driver ENFORCES the quota:
   a directory-pool setting without an effective quota is not sufficient.
   Account for the golden image and cache separately. Measure actual peak
   usage; do not raise ceilings on the shared host without a new capacity check.
5. Give it a dedicated managed network. Verify from the runner that host,
   Tailscale, metadata, private LAN, QA services and production DB endpoints
   are unreachable over IPv4 AND IPv6. Allow the required GitHub, package,
   registry and artifact endpoints. Do not change the host's existing access
   firewall blindly or expose the container's ports publicly.
6. Install Git, curl, jq, unzip, GNU coreutils/timeout, procps/psmisc, sudo,
   iproute2, iptables/ip6tables, util-linux/setpriv and Python in the IMAGE.
   Provide Node 24.22.1 with npm/npx, a writable runner tool cache and an
   independent Docker daemon. The existing pinned setup actions still run.
   Browser installation uses the existing bounded script and needs passwordless
   sudo INSIDE the disposable container only. Verify the restore drill's
   IPv4/IPv6 owner-match rules work inside its namespace.
7. Download the current official x64 Actions runner release from
   `actions/runner`, verify its published SHA-256, and record the version and
   digest in the image receipt. Use a non-root runner account. Register only
   with the private Hone repo, using a short-lived registration token
   obtained outside the job. Never put a PAT, admin token or registration
   token in a PR, a repository file, a job environment or chat.
8. In each NEW job container, create `/etc/hone-ci-ephemeral` containing
   `hone-ci-v1` with owner root and mode 0444, only after external isolation
   checks pass. Register with `config.sh --ephemeral --unattended --url
   https://github.com/SaiSamyukthVemuri/Hone --labels hone-ci-ubuntu-24.04`
   plus the token entered locally; then run `run.sh`. Keep default Linux/x64
   labels. Do not advertise this label on an ordinary host runner.
9. The host supervisor must destroy/recreate the job container after EACH job,
   including failures and cancellation. Ephemeral GitHub registration alone
   does not wipe a disk. Retain diagnostics outside the guest before removal.
   Keep privileged registration credentials outside the guest after config.
   Do not run an unattended loop until teardown has passed its negative cases.

## Acceptance before cutover

| Proof | Required result |
| --- | --- |
| Isolation | No host mounts/sockets, no host or QA/production private-network access, distinct nested Docker engine; external configuration receipt |
| Capacity | Free-space reserve preserved, actual CPU/RAM/disk peak and job duration recorded |
| Scheduling | One active job maximum during pilot; a second waits; no parallel jobs share a container |
| Compatibility | Synthetic DB, Chromium, WebKit and restore-drill firewall probes pass on the intended image |
| Failure | Deliberate test failure remains a failed check; offline runner stays queued, never green or hosted |
| Cancellation | Processes and that job's own nested stack stop; diagnostics retained; a fresh disk is used next |
| Recovery | Kill the supervisor mid-job, recover without adopting old state or removing unrelated resources |
| PR coverage | Exact candidate head completes its required selected checks in the private repo |
| Full coverage | Full nightly matrix AND synthetic restore drill succeed before all-workflow cutover is called complete |
| GitHub controls | Current no-rewrite rule verified; actual required-check settings inspected separately; do not invent enforcement |

Use the existing stable `browser e2e (local stack)` check for the established
review gate. A merged routing PR or a registered idle runner is not acceptance.
Qualify any new GitHub-enforced required check in the sandbox and bring its
production setting change back as a separate scoped decision.

## Overnight operation and rollback

Only after the above pilot passes, replenish one fresh container per job,
under a single host-side lock. Recheck private visibility, host reserve and
memory admission before EVERY launch; an API/read failure must refuse new
work. Collect start/end UTC, workflow/job/commit, outcome, queue wait, peak
resource use and remaining disk. Limit the first window to eight hours, stop
admitting at its deadline, then let the active job finish within its existing
workflow timeout. Stop and report on teardown failure or unknown host state.

Never delete host caches, Docker objects, worktrees or files to make room.
Destroy only the uniquely identified disposable CI container managed by the
supervisor, after verifying ownership and preserving its logs.

Immediate stop: stop admitting new runner containers; disable their runner
service after the active job is settled. Leave required checks unsatisfied.
Preserve the known-good production deployment. A reviewed revert of this
workflow commit restores the prior hosted routing if Sam authorizes resuming
hosted compute; there is deliberately no automatic hosted fallback.

## Verification performed in preparation

- All 201 existing CI configuration tests pass, including the credential,
  supply-chain, matrix, optional-lane and stable-check guards.
- Nine routing tests cover every discovered workflow and negative controls for
  hosted fallback, generic host labels, bypassed boundary checks and public or
  unknown visibility. Three cases execute the actual first-step shell across
  all 13 job definitions and prove it stops before later work.
- Fourteen focused existing classifier cases pass (including docs-only,
  migrations and the waitlist selection repair from PR #1421).
- Parsed-YAML comparison against the pinned source verifies all 13 definitions:
  only runner selection and the initial boundary check change execution.
- Host preflight passes Bash syntax validation; it has NOT run on the VPS.
- A disposable-fixture test executes the preflight with an unavailable snap
  and a trap installer wrapper, proving the wrapper is never invoked.
- Pool setup guard tests accept the exact new-disk facts and reject another
  serial/size, root or mounted storage, partitions, signatures, unknown reads
  and a pre-existing CI pool. They do not run a host initialization command.
- Storage-snapshot tests exercise the actual policy and fixture collector:
  separate root reserve, exact Volume/VG identity, thin data/metadata ceilings,
  missing devices/reads and logical overcommit despite low current Data%.
  None of these fixtures is live VPS capacity or isolation evidence.
- Current focused preparation run: 252 tests pass (201 existing CI contracts,
  9 routing, 1 preflight, 12 pool-setup and 29 storage-snapshot tests). Removing
  the logical-commitment refusal deliberately makes its regression test fail;
  the exact original script was restored afterward. Python compilation,
  Bash syntax and the changed tests' TypeScript check pass. Independent review
  and live VPS qualification remain outstanding.
- Committed-tree verification and the canonical schema-snapshot check pass
  after materializing the 264 unchanged migration sources at the pinned head.
- Full repository build, DB/browser tests, live runner isolation/capacity and
  billing savings are not verified in this preparation environment.

## Primary references

- [GitHub: self-hosted runner routing and ephemeral runners](https://docs.github.com/en/actions/reference/runners/self-hosted-runners)
- [GitHub: secure use of self-hosted runners](https://docs.github.com/en/actions/reference/security/secure-use)
- [Canonical: LXD hardening and resource limits](https://canonical.com/lxd/docs/latest/howto/security_harden/)
- [Canonical: LXD 5.21 LVM storage and thin overcommit](https://canonical.com/lxd/docs/v5.21/reference/storage_lvm/)
- [LVM2: reporting field definitions](https://github.com/lvmteam/lvm2/blob/main/lib/report/columns.h)
