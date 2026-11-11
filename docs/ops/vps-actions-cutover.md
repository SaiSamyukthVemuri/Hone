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
- Sam's last VPS output had 108 GiB free. This candidate proposes an 80 GiB
  reserve plus a 30 GiB per-job budget: at least 110 GiB before one pilot,
  BEFORE any extra image-cache allowance. These are conservative proposed
  limits, not measured peaks. Do not prune or delete to pass admission.
- This preparation environment has no route to `100.123.145.56`; SSH returns
  `Network is unreachable`. No runner has been registered or launched here.
- Sam's fresh Mac-side check confirms SSH access, 108 GiB free on the root
  filesystem and 28 GiB available RAM. The only disk is the root disk.
  `/usr/sbin/lxc` is an installation launcher: the attempted LXD queries
  report that snap installation could not be triggered. Neither an installed
  LXD daemon nor a storage pool is confirmed. The preflight now checks the
  installed snap and calls only `/snap/bin/lxc --force-local`, avoiding that
  potentially mutating launcher.

### Optional CI storage

Sam is willing to add storage if needed, but has not authorized a purchase.
A dedicated 100 GB CI Volume is a provisional option to price after measuring
the image and job footprint. It is a separate filesystem, not extra free space
on the root filesystem. Put the CI storage pool, nested Docker data and scratch
on it deliberately; refuse admission if the expected mount is missing. Adapt
admission to preserve the host reserve and check the Volume separately, rather
than carrying the root-only 110 GiB threshold over unchanged.

Confirm the exact checkout price and size before purchase. Hetzner server
backups do not cover attached Volumes: keep CI data reproducible/disposable,
and retain required evidence elsewhere. Extra disk does not qualify CPU,
isolation, network access or the runner lifecycle.

## Exact provisioning scope for the pilot

Do this only from the VPS-connected OPS environment after reviewing the actual
disk, LXD storage and network state. No host-wide install script is supplied
because those facts are not available in this environment.

1. Run `bash scripts/ci/vps-host-preflight.sh` on the VPS. It reads capacity,
   running Docker workloads and LXD availability, and exits 2 if disk admission
   fails. It does not install, register, restart, prune or delete anything.
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
- Committed-tree verification and the canonical schema-snapshot check pass
  after materializing the 264 unchanged migration sources at the pinned head.
- Full repository build, DB/browser tests, live runner isolation/capacity and
  billing savings are not verified in this preparation environment.

## Primary references

- [GitHub: self-hosted runner routing and ephemeral runners](https://docs.github.com/en/actions/reference/runners/self-hosted-runners)
- [GitHub: secure use of self-hosted runners](https://docs.github.com/en/actions/reference/security/secure-use)
- [Canonical: LXD hardening and resource limits](https://canonical.com/lxd/docs/latest/howto/security_harden/)
