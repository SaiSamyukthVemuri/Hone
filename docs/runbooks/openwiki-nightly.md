# OpenWiki nightly runner (WIKI-AUTO-01)

**Status.** Repository side only. The runner is not installed on any host, publishing is off unless
`HONE_WIKI_PUBLISH=on`, and the runner never merges. Merge authority stays with a human
(`docs/roadmap/CANONICAL_ROADMAP.md` §16: "Phase 1 continues with a permanent human merge/release gate").

```
node scripts/openwiki/nightly.mjs [--no-publish]
```

## Contract

| Outcome | Exit | Meaning |
|---|---|---|
| `SKIP` | 0 | Disabled, kill switch present, another pass holds the lock, or an unmerged nightly branch is already in flight. |
| `NOOP` | 0 | The wiki already describes the source head (startup no-op, OpenWiki never runs), or OpenWiki changed only run metadata. |
| `DRY_RUN` | 0 | Every check passed; publishing is off. |
| `PUBLISHED` | 0 | One pull request opened from `openwiki/nightly-<YYYYMMDD>-<source7>`, plus one `@codex review` request. |
| `FAILED` | 1 | Nothing published; the subject checkout is reset. Retried on the next pass. |
| `PRECONDITION` | 2 | A human must change something: environment, credentials, history or markers. |

Each pass writes a JSON report (no secret values, no matched privacy text) to
`$HONE_WIKI_STATE_DIR/runs/` and `$HONE_WIKI_STATE_DIR/last-run.json`.

### Who owns a path (`scripts/openwiki/paths.mjs`)

| Class | Paths | Runner rule |
|---|---|---|
| generated | everything under `openwiki/` except the two below: pages, indexes, Claim sidecars, `.last-update.json`, `.page-manifest.json` | the only scope ever published |
| authored | `openwiki/INSTRUCTIONS.md` | preserved; a write to it fails the run |
| transient | `openwiki/.run.json` | never published; present after a run = the run did not complete |
| ignored | outside `openwiki/` and matched by `.openwikiignore` (same semantics as openwiki@0.6.1) | not source |
| source | everything else | what the wiki documents |

OpenWiki 0.6.1 also writes outside `openwiki/` by design. It rewrites the managed blocks in `AGENTS.md` and
`CLAUDE.md` on every init and update, and `init` writes `.github/workflows/openwiki-update.yml`. The runner
discards those writes and records them in the report. Any other write outside the generated scope fails the run.

### Source head and liveness (`scripts/openwiki/source-head.mjs`)

The runner documents the **source head**: the newest first-parent commit on the production branch whose own
change touched a source path. Generated-only commits after it, such as a merged nightly PR, do not move it.

The wiki is **live** when `openwiki/.last-update.json` records the source head (or a commit between it and the
tip), with `status: complete`. A live wiki ends the pass as `NOOP` before any model credential is read. A
recorded `gitHead` outside production history, an interrupted status or an abbreviated SHA is `PRECONDITION`.

### One pass

1. **Preflight, fail-closed:**
   - `HONE_WIKI_NIGHTLY=on`, no `DISABLED` file, lock acquired;
   - every name in the environment table set, no forbidden name present;
   - App token permissions exactly as below;
   - subject checkout cloned or fetched, then reset and cleaned at the production tip;
   - well-formed managed-block markers;
   - no committed workflow scaffold or run state.
2. **Startup no-op** when the wiki is live.
3. **Single flight:** `SKIP` while any `openwiki/nightly-*` branch on the remote is not contained in production.
   To let the runner resume, merge that PR or delete the branch.
4. **Run prerequisites:**
   - the pinned `openwiki@0.6.1` install;
   - node ≥ 22.22.0;
   - owner-only key and denylist files;
   - free disk above `HONE_WIKI_MIN_FREE_GB`.
5. **Pin the run.** `HEAD` moves to the source head (OpenWiki records it as `gitHead`), and the working tree
   stays the production tip (the newest wiki is the baseline). The runner then executes
   `openwiki code --update --print` with an allowlisted environment and its own `HOME`. It never runs `init`.
6. **Scope.** Discard and record writes outside the generated scope (see A3 below). Fail on an unexpected write
   or leftover `openwiki/.run.json`.
7. **Checks.**
   - `openwiki/.last-update.json` is `{command: update, status: complete}` and its `gitHead` equals the source
     head;
   - no OpenWiki broken-link stamps;
   - the privacy/secret scan finds nothing: credential and PII shapes, terms from `HONE_WIKI_DENYLIST_FILE`,
     and studio slugs from the tenant register in `docs/production/current-state.md` §0. It runs over changed
     pages and over changed Claim statements and evidence paths.
8. **Publish (replace, not overlay).**
   - HEAD returns to the production tip, and the generated scope is replaced wholesale, deletions included.
   - The commit goes through the CLAUDE.md eight-step delivery sequence, including `npm run verify:prepush`.
     That check is repository code, so it runs with an allowlisted environment (`PATH`, a private `HOME`,
     locale, timezone, isolated git config). It sees no credential, no path to one, and no App identifier.
   - Before pushing, the runner verifies that the commit is a single child of the tip, that its diff is
     generated-only, that `openwiki/` equals the run's output exactly, and that it is authored and committed
     by the runner identity.
   - It then opens one pull request and posts `@codex review` for the exact head.

### A3: the OpenWiki workflow scaffold

`openwiki init` writes `.github/workflows/openwiki-update.yml` when the file is missing. That scaffold requests
`contents: write` and `pull-requests: write` and reads provider secrets, so it would fail
`tests/ci/ci-config.test.ts`. It is enforced in four places:
- `.openwikiignore` lists it, so OpenWiki init/update never treat it as source.
- The runner never runs `init`.
- If the file appears, the runner inspects it, records why it would fail CI-workflow inspection, and discards it.
- The App token has no `workflows` permission, so GitHub itself would refuse to accept a push containing it.

## Environment (names only; values live in the host env file)

| Name | Meaning |
|---|---|
| `HONE_WIKI_NIGHTLY` | `on` to run; anything else is `SKIP` |
| `HONE_WIKI_REPOSITORY` | `owner/name` |
| `HONE_WIKI_BASE_BRANCH` | the production branch |
| `HONE_WIKI_SUBJECT_DIR` | runner-owned clone, reset every pass; never an operator worktree |
| `HONE_WIKI_STATE_DIR` | lock, reports, kill switch (`DISABLED`), private `HOME` for OpenWiki |
| `HONE_WIKI_APP_ID` | GitHub App id |
| `HONE_WIKI_APP_INSTALLATION_ID` | installation on this repository only |
| `HONE_WIKI_APP_PRIVATE_KEY_FILE` | path to the App private key (owner-only file) |
| `HONE_WIKI_GIT_AUTHOR_NAME` | runner identity for the publish commit |
| `HONE_WIKI_GIT_AUTHOR_EMAIL` | runner identity for the publish commit |
| `HONE_WIKI_OPENWIKI_DIR` | pinned `openwiki@0.6.1` package directory, separate from any operator install |
| `HONE_WIKI_ANTHROPIC_API_KEY_FILE` | path to the model key (owner-only file); passed only to the OpenWiki child |
| `HONE_WIKI_DENYLIST_FILE` | path to the privacy denylist, one term per line (owner-only file, never committed) |
| `OPENWIKI_PROVIDER` | must be `anthropic` |
| `OPENWIKI_MODEL_ID` | the pinned model id |
| `OPENWIKI_TELEMETRY_DISABLED` | must be `1` |
| `DO_NOT_TRACK` | must be `1` |

Optional: `HONE_WIKI_PUBLISH` (`on` to publish; default off), `HONE_WIKI_MIN_FREE_GB` (default 10),
`HONE_WIKI_RUN_TIMEOUT_MIN` (default 90).

Must be absent (preflight fails otherwise):
- `GITHUB_TOKEN` and `GH_TOKEN`;
- a raw `ANTHROPIC_API_KEY` (the key arrives as a file);
- other provider keys;
- LangSmith/LangChain tracing variables;
- anything starting `SUPABASE_`, `STRIPE_`, `TWILIO_`, `VERCEL_` or `SENTRY_`.

## GitHub App

The installation token is requested and verified as exactly: `metadata: read`, `contents: write`,
`pull_requests: write`, `checks: read`, `statuses: read`, for this one repository. In particular the token
never has `workflows` or `administration`.
- **Minting:** a token is minted at the start of a pass for the reads. Tokens expire one hour after minting and
  a run may take longer, so a fresh one is minted immediately before publishing.
- **Handling:** tokens are held in memory and given to git only through `GIT_ASKPASS` reading an environment
  variable, with every credential helper disabled.
- **Private key:** the App private key is read on every mint and refused (`PRECONDITION`) unless only its owner
  can read it.

## Host setup: blocked on credentials, not done

These steps need a GitHub App, its private key, a dedicated model key and the denylist file. None exists yet.

1. Create a runner-owned state directory, a separate clone location, and a pinned
   `npm install --prefix <tools> openwiki@0.6.1` (its install scripts are required for `better-sqlite3`).
2. Place the three secret files with mode `0600`, and write the host env file with the names above.
3. Run a dry run first (`HONE_WIKI_PUBLISH` unset) and read `last-run.json`.
4. Install the units below, `systemctl --user daemon-reload`, then enable the timer.

User service (`~/.config/systemd/user/hone-wiki-nightly.service`):

```
[Unit]
Description=Hone OpenWiki nightly runner (WIKI-AUTO-01)

[Service]
Type=oneshot
UMask=0077
EnvironmentFile=<host env file>
ExecStart=<pinned node> <runner checkout>/scripts/openwiki/nightly.mjs
TimeoutStartSec=2h
Nice=10
```

User timer (`~/.config/systemd/user/hone-wiki-nightly.timer`):

```
[Timer]
OnCalendar=*-*-* 03:30:00 UTC
Persistent=true

[Install]
WantedBy=timers.target
```

**Stop:**
- soft: `touch $HONE_WIKI_STATE_DIR/DISABLED`;
- hard: `systemctl --user disable --now hone-wiki-nightly.timer`;
- revoke: uninstall the App, or rotate its key and the model key.
