# STAGE-0248-ONLINE: the narrow delta (REHEARSAL, NEVER MERGE)

Sam's online rollout text (sha 40aad6a5): no PITR/row-4 prerequisite, no cron pause, no staff hold, no fixed window. Kept: the sealed SQL (1f6f9ad0), the correct target,
migration-history checks, application compatibility, bounded execution, post-apply verification. Nothing here is run against the hosted project; CI runs the REAL script text
against a stub `supabase-go`, a stub read-back script and a FIFO terminal, with canary secrets and a fake HOME.

| New script | Delta against | What changed |
|---|---|---|
| `s1-apply-0248-online.sh` | `s1-apply-0248.sh` a31e048b | window prompts, S0a gate, row-4 restore point, 75/120-minute timers, watchdog prompts REMOVED; four pinned reads, a summary, the automatic read-back and one receipt ADDED |
| `s1-reconcile-0248-online.sh` | `s1-reconcile-0248.sh` 91bbee68 | the NONE route also accepts a g02 history read from the newest `online.*` directory (same 1200 s rule, same sidecar binding); ALL unchanged |
| `g02-read-0248-online.sh` | (new, tiny) | one standalone read of the pinned g02 query into a new `online.*` directory, usable while a marker exists |

Unchanged and pinned (not edited): `run-window-read-macos.sh` 471ecb9d, its MANIFEST df3e4e9a, the four gate queries (g02 19e4e057, g12 e4080f1d, s1-open b110fd60, w03 82ff0460),
`window-s1read-0248.sh` 6c96ff3b, `supabase-go` dce26b75, the bundle and list (c9ebfcec, c71fb767), the sealed 0248 (1f6f9ad0).

## Three points the assignment text did not match (decided, not hidden)

1. **statement_timeout is not in `s1-open-transactions-0248.sql`.** Only `w03-table-sizes-0248.sql` returns it. The apply runs w03 as a fourth pinned read (same manifest, same runner), applies
   the existing S0-W3 rule unchanged (ten tables, none over 512 MiB, one consistent setting) and adds the bound: STOP if it is 0, over 2 min, or unreadable. No SQL was edited.
2. **That value is a proxy.** The sealed 0248 sets only `lock_timeout` 5 s, no `statement_timeout`, and `db query --linked` goes through the Management API, so it may not be the value the push
   session gets. With no settings write, "bounded execution" is therefore the role default plus the 512 MiB size bound, not a proven cap. Named as a remaining exception.
3. **The read-back script asks for the credentials itself** (`window-s1read-0248.sh` reads the token and password from the terminal). Run automatically and unchanged, the operator types them a second time.

## Reconcile NONE

The assignment allows the g02 result "from an online.* pre-push read OR a fresh standalone read taken >= 1200 s after the marker". A pre-push read is always OLDER than the marker, so accepting it
without the time rule would clear an UNKNOWN marker on evidence from before the push, and a push that did apply could then be run a second time. The 1200 s rule therefore holds for every
source; `online.*` is a place the evidence may come from, not an exemption. CI proves a pre-push read does not clear a marker.
