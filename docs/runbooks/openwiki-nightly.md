# OpenWiki nightly runner (WIKI-AUTO-01)

**Status.** Repository side only. The runner is not installed on any host, and publishing is off unless
`HONE_WIKI_PUBLISH=on`. The runner never merges and never executes code from the repository it documents
(see the trust boundary below). Merge authority stays with a human (`docs/roadmap/CANONICAL_ROADMAP.md` §16:
"Phase 1 continues with a permanent human merge/release gate").

```
node scripts/openwiki/nightly.mjs [--no-publish]
```

## Contract

| Outcome | Exit | Meaning |
|---|---|---|
| `SKIP` | 0 | Disabled, kill switch present, another pass holds the lock, or an unmerged `openwiki/nightly-*` branch is already in flight. |
| `NOOP` | 0 | The wiki already describes the source head: the startup no-op. OpenWiki never runs. |
| `DRY_RUN` | 0 | Every check passed; publishing is off. This includes a successful metadata-only source advance. |
| `PUBLISHED` | 0 | One pull request opened from `openwiki/nightly-<YYYYMMDD>-<source7>`, plus one `@codex review` request. A run that changed only run metadata is published too, titled "(metadata only)". |
| `FAILED` | 1 | Nothing published; the subject checkout is reset. Retried on the next pass. This includes "production advanced during the run". |
| `PRECONDITION` | 2 | A human must change something: environment, credentials, history, markers, committed run state, a run lock that holds no process id, an empty denylist or an unreadable tenant register. |

Each pass writes a JSON report to `$HONE_WIKI_STATE_DIR/runs/` and `$HONE_WIKI_STATE_DIR/last-run.json`.

### Reporting boundary (`scripts/openwiki/report.mjs`)

Every report, the CLI line, and the publish commit message, pull request title, body and review request go
through one sink.
- **Coded reasons.** A pass ends with a `reasonCode` from a closed catalog, plus `safeDetails`: counts, flags,
  constants from closed sets, and identifiers in the runner's own formats (full commit SHAs, branch names of
  the form `openwiki/nightly-<YYYYMMDD>-<source7>`, pull request numbers). The human-readable `reason` is
  rendered from those values. When several checks fail together, the first is the `reasonCode` and the rest are
  in `additionalReasons`.
- **No free text.** No untrusted text reaches a sink: no pathname, generator output, remote ref name, API error,
  git error or value parsed from the repository. An error with no catalog code is reported as
  `UNEXPECTED_ERROR` with the step it happened in, and at most a system error code and an exit status. To see
  the underlying error, rerun that step by hand in a throwaway checkout.
- **Closed schema.** Every field of the report is checked against a closed schema when it is written. A value
  that fails its kind is dropped and counted in `withheld`, never passed through. `withheld` is 0 unless the
  runner itself has a bug.
- **Paths.** A report holds a pathname only if this pass's path gate cleared it (One pass, step 6), or if it is
  one of the runner's own constant paths.
- **Privacy findings** are recorded by cleared file, line and category, never by matched text.

**OpenWiki's stdout/stderr is intentionally never persisted or printed.** It is untrusted repository and model
output that can carry names, tenant slugs, contact details or credential-shaped strings. The runner drains it
in memory and records only the exit code, the timeout flag, its byte count and its SHA-256. It does not forward
the output to its own stdout, the CLI result or the journal. To see OpenWiki's output, run it by hand in a
throwaway checkout.

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
   - every name in the environment table set, no forbidden name present (a name forbidden by its prefix is
     reported by that prefix only);
   - App token permissions exactly as below;
   - subject checkout cloned or fetched, then reset and cleaned at the production tip;
   - well-formed managed-block markers;
   - no committed workflow scaffold;
   - nothing committed at `openwiki/.run.json`: transient run state must never be committed, so a file there,
     valid JSON or not (or a directory), is `PRECONDITION`. Existence is read from the git tree, never by
     parsing the file.
   - A run lock that holds no process id is not treated as absent: it is `PRECONDITION`, and the lock stays.
     Remove `$HONE_WIKI_STATE_DIR/run.lock` by hand once no runner pass is active.
2. **Startup no-op** when the wiki is live. A committed `.last-update.json` that is missing, malformed or not an
   object is `PRECONDITION`, and the report says which of the three it is.
3. **Single flight:** `SKIP` while any `openwiki/nightly-*` branch on the remote is not contained in production.
   To let the runner resume, merge that PR or delete the branch. Only branch names in the runner's own format
   are named in the report. Any other `openwiki/nightly-*` name is remote state the runner does not own, so it
   is counted as unrecognized and its name is withheld.
4. **Run prerequisites:**
   - the pinned `openwiki@0.6.1` install;
   - node ≥ 22.22.0;
   - owner-only key and denylist files;
   - a denylist with at least one term;
   - a readable tenant register (§0 of `docs/production/current-state.md` at the production tip) with at least
     one studio slug;
   - free disk above `HONE_WIKI_MIN_FREE_GB`.

   An empty denylist or an unreadable register would silently turn a privacy scan into a no-op, so each is
   `PRECONDITION`.
5. **Pin the run.** `HEAD` moves to the source head (OpenWiki records it as `gitHead`), and the working tree
   stays the production tip (the newest wiki is the baseline). The runner then executes
   `openwiki code --update --print` with an allowlisted environment and its own `HOME`. It never runs `init`.
6. **Path gate, then scope.**
   - **Path gate first.** Before any changed path is recorded, reported or interpolated anywhere, the runner
     takes every path the run changed. That means generated files, OpenWiki's known side effects and unexpected
     writes, whether added, modified, deleted or type-changed. It normalizes each path and scans it as written
     and humanized (separators read as spaces), so `people/jane-doe.md` matches "Jane Doe". A path is cleared
     only if it has no privacy hit and fits the reportable path grammar (every path in the repository today
     does).
   - If any path fails the gate, the pass is `FAILED` with `PATH_PRIVACY_REJECTED`. Only a count and the
     categories are kept. No pathname from that pass reaches `discarded`, `checks`, the reason, the CLI line or
     a pull request.
   - **Then scope.** The runner discards and records writes outside the generated scope (see A3 below). It
     fails on an unexpected write or leftover `openwiki/.run.json`.
   - **Metadata-only runs.** A run that changed only `.last-update.json` and `.page-manifest.json` still
     processed a new source head. Repository state is the cursor, so the run is validated and published like
     any other; after the merge, the next pass is a startup no-op.
7. **Checks.**
   - `openwiki/.last-update.json` is present, parses, and holds the strict schema `openwiki@0.6.1` writes it with:
     `{updatedAt, command, gitHead, model, status, language}` and no other key, so no extra key can carry text.
     The runner holds the fields to:
     - `updatedAt`: an ISO instant;
     - `command`: `update`; `status`: `complete`;
     - `gitHead`: exactly the source head;
     - `model`: non-blank text;
     - `language`: a canonical locale OpenWiki resolves.
   - **The page manifest is a state invariant, checked on every run, metadata-only runs included.**
     `openwiki/.page-manifest.json` must exist, parse, and hold the strict schema `openwiki@0.6.1` enforces
     itself:
     - `{schemaVersion: 1, pages}`, with no other key;
     - every key a canonical factual `/openwiki/*.md` page;
     - every entry carrying a `sha256:` `pageVersion`, with only OpenWiki's optional fields, each in the format
       OpenWiki actually writes: `gitHead` a full commit SHA, `sourceFingerprint` a `sha256:` digest,
       `completedBy` an OpenWiki producer id (`openwiki/<version>` or a host id), `completedRunId` a UUID.
   - No OpenWiki broken-link stamps and no conflict markers.
   - Provenance for every page the run touched: a Claim sidecar with at least one Claim, and the page's sha256
     as `pageVersion` in both the sidecar and the manifest, with no leftovers of a deleted page.
   - The privacy/secret scan finds nothing in anything the run publishes. It covers credential and PII shapes,
     terms from `HONE_WIKI_DENYLIST_FILE`, and studio slugs from the tenant register.
     - Changed pages, and changed generated files of any other type, are scanned whole.
     - In changed Claim sidecars, every key and string is scanned, except the `pageVersion` and evidence
       `version` fields: those are OpenWiki digests (a sha256 plus base64url line counts and hashes).
     - In run metadata, every value a strict grammar does not pin down is scanned: `model`, `language`, each
       manifest page key and each `completedBy`. Digests, SHAs, UUIDs, timestamps and enums are format-checked
       instead.
     - Path-like values (sidecar strings, run metadata) are scanned as written and humanized, so `jane-doe`
       matches "Jane Doe".
     - A hit fails the run with its category, file and a line count, never the matched value.
8. **Publish (replace, not overlay).**
   - HEAD returns to the production tip, and the generated scope is replaced wholesale, deletions included.
   - The commit follows CLAUDE.md's delivery sequence steps 1-6 and 8 as written (git hooks disabled). Step 7,
     `npm run verify:prepush`, is **not** executed (see the trust boundary). Instead the runner checks the
     commit as data:
     - clean worktree, and HEAD/index/worktree identity;
     - `git diff --check`;
     - the commit is a single child of the tip and its diff is generated-only;
     - `openwiki/` equals the run's output exactly;
     - the commit is authored and committed by the runner identity.
   - With a fresh token, the runner reads the production branch's exact remote SHA. If it is no longer the tip
     the run was pinned to, nothing is published (`FAILED`, retried from the new tip on the next pass).
   - It then opens one pull request and posts `@codex review` for the exact head. The pass is `PUBLISHED` only
     when all three hold: the pull request exists, its head is exactly the verified commit, and that review
     request was posted.
   - The commit message, pull request title and body, and the review request are rendered by the reporting
     boundary from validated values only. A value that is not in its safe format stops the publish before
     anything is committed.
   - If anything fails after the pull request is created, the runner closes the pull request **and** deletes
     its branch, attempting both even if one fails. The branch is deleted only while it still points at the
     verified head (`--force-with-lease`). If someone pushed a newer commit to it, it is left in place as
     `delete-failed` rather than deleted. It records each step's state (`closed`/`close-failed`,
     `deleted`/`delete-failed`) with the PR number, branch and head, and ends `FAILED`. If cleanup is
     incomplete, the next pass reports `SKIP` on the leftover branch until a human closes or deletes it; it
     never treats that state as success.

### Trust boundary

The runner holds the GitHub App key and the model key. Any process it starts runs as the same unix user, and
such a process can read the runner's `/proc/$PPID/environ` and the key files named there. Cleaning a child's
environment does not change that.

- **The runner never executes code from the subject repository**: no package or repository scripts, no
  `npm run verify:prepush`, no test suite. It reads the subject only as data, through git and the filesystem.
  Its own code runs from a pinned runner checkout, never from the subject clone. Its only other child is the
  pinned OpenWiki CLI from the tools install. OpenWiki confines its agent's shell to `pwd` and
  `git rev-parse HEAD`, and its writes to `openwiki/`.
- **Trusted pre-publish checks on the host:** liveness, `.last-update.json` gitHead equality, the path gate
  over every changed path, generated-only scope, the page-manifest schema, replace-not-overlay, single child of
  the tip, runner authorship, worktree/HEAD identity, `git diff --check`, conflict markers, provenance,
  broken-link stamps, and the privacy/secret denylist on generated content.
  These checks deliberately do not reimplement repository business or test logic (for example
  `scripts/migration-state.mjs`). A generated-only commit cannot change a migration.
- **Repository-controlled verification runs in PR CI:** the test suites, `verify:prepush` semantics, migration
  state, and the rest of the CI lanes. They run on GitHub, where the wiki-runner credentials are absent.
- **The runner never merges.** It has no merge code path. A generated PR advances only when a human merges it
  after its CI and exact-head review gates, under the roadmap's human merge/release gate.
- **Not enforced by GitHub today.** The production branch has no branch protection or required checks, and the
  App token's `contents: write` would technically permit the merge API. So "never merges" is a property of
  the runner's code plus the human gate, not a GitHub restriction. Protect the production branch (required
  checks and review) before enabling publishing if that guarantee must be structural.

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

The two limits share one parser, applied before any conversion to bytes or milliseconds:
- unset, or blank and whitespace-only, means the default;
- anything else must be a plain positive decimal such as `25` or `1.5`;
- `0`, negatives, `NaN`, `Infinity`, exponent notation and any other text are `PRECONDITION`, and so is a
  timeout too long for a Node timer (over about 35,791 minutes);
- the report names the variable, never its value.

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
3. **Mandatory:** run a dry run first (`HONE_WIKI_PUBLISH` unset) and read `last-run.json`. Publishing is
   enabled only after a dry run on this host has passed.
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
