# Migration number coordination — in-flight claims

**What this file is.** A register of migration numbers **claimed on unmerged
heads**, so eight concurrent lanes do not collide. Owned by the DB/WAIT lane as
migration-coordination owner for the #824 sprint.

**What this file is NOT.** It is **not** a source of truth for repository or
hosted migration state, and nothing here may be read as either.

| Question | Authority | How to get it |
|---|---|---|
| repo max · next free · totals · duplicates | **DERIVED** from `supabase/migrations/*.sql` | `npm run migration:state -- --json` |
| hosted max · when applied | **DECLARED** in `docs/production/migration-state.json` | read that file **on a current-production base** (see the trap below) |
| the narrative apply record | `docs/production/migration-ledger.md` | never rewritten |
| **who claims an unmerged number** | **this file** | verify each row against its PR head before trusting it |

A claim is not derivable, because it lives on a head that is not in the tree —
which is the same reason hosted state is declared rather than derived. That is
the only thing this file adds.

---

## Verify before you trust a row

Every row below is **historical the moment it is written**. Re-derive:

```bash
# what each open PR actually adds, read from its own head
gh pr list --state open --limit 120 --json number,headRefName --jq '.[]|"\(.number) \(.headRefName)"' |
while read -r n br; do
  git fetch -q origin "pull/$n/head"
  echo "#$n $(git diff --name-only $(git merge-base FETCH_HEAD origin/claude/build-hone-saas-hOex7) FETCH_HEAD \
          -- supabase/migrations/ | sed 's|.*/||' | tr '\n' ' ')"
done
```

**Do not read a number off anyone's prose, including this file's, including your
own earlier comment.** That exact mistake was made in this sprint: a lane
posted the correct census, then four minutes later claimed a number from its
own summary that had silently dropped a row, and repeated the bad claim twice
before a peer caught it.

### THE TRAP: hosted state is per-worktree

`docs/production/migration-state.json` is a **file in a branch**. Read it in a
worktree sitting on an old base and it answers for that base. Measured
2026-10-12: `/srv/hone/worktrees/db-acl01-payment-helpers` (HEAD `a5f3aa27`)
reports `hosted_migration_max: 0202`, while the same file on current production
`6c5eac80` reports **`0210`**. Eight numbers of drift, no error, no warning.

**Always state the base you read it on.** A census without a base is not a
census.

---

## Census — 2026-10-12, base `6c5eac80` (production)

| Source | Value |
|---|---|
| Hosted (declared, on `6c5eac80`) | **0210** |
| Repository (derived, on `6c5eac80`) | max **0210**, pending `[]`, next free `0211` |
| Permanently skipped | `0158` only (`scripts/migration-state.mjs:43`) |
| Worktrees scanned for claims incl. uncommitted | **276** |

### Claims on unmerged heads, each read from its own PR head

| № | PR | Branch | File |
|---|---|---|---|
| `0211` | #827 | `fix/g3-client-sms-field-guard` | `0211_client_sms_permission_guard.sql` |
| `0212` | #832 | `feat/delivery-events-01-resend` | `0212_email_delivery_events.sql` |
| `0213` | #831 | `feat/lead-alert-01-operator-email` | `0213_platform_lead_alerts.sql` |
| `0214` | #833 | `feat/pay-ccy-02-studio-jurisdiction` | `0214_studio_payment_jurisdiction.sql` |
| `0215` | #843 | `feat/delivery-visibility-01` | `0215_delivery_incidents.sql` |
| `0216` | #838 | `feat/receptionist-foundation-824` | `0216_receptionist_membership_foundation.sql` |
| `0217` | #844 | `feat/sms-sender-reg-01` | `0217_studio_sms_sender_registrations.sql` |
| `0218` | #850 | `feat/receptionist-invitation-824` | `0218_receptionist_invitations.sql` |
| **`0219`** | **#840 follow-on (G1)** | `feat/g1-public-practitioner-selection` | **ALLOCATED 2026-10-12** — public practitioner selection |

**Stacked carriers are not second claims.** A PR whose branch also contains a
lower-numbered lane's file is stacked on it: #832 and #831 and #843 all carry
`0211`; #836/#839/#847 carry #833's `0214`; #845 carries #838's `0216`; #850
carries `0216`. One claim each, held by the row above.

**Two worktree observations, neither a claim.** `sms-01-r2` holds an
**untracked** copy of `0210_sms_waitlist_join_acknowledgement.sql` — already
applied and already on the chain, so it is a stale local copy, not a new
number. `sentry-after-01-recovered` tracks `0211`/`0212` because it is stacked.

**Below the hosted head, not in contention:** #674 (`0194`), #716 (`0199`).

---

## Allocating a number

1. Re-derive the census from **all four** sources — hosted (naming the base),
   repository, every open PR's own head, and every worktree **including
   uncommitted files**. #824 requires the worktree dimension explicitly.
2. Take the first free number above every claim.
3. Add the row here **in the same change** that adds the migration file.
4. **Read the contiguity law before assuming your number can go green.**

### The contiguity law decides your schedule, not just your number

`tests/docs/canonical-production-facts.test.ts:568-578` requires the pending
suffix to be **contiguous** from `hosted + 1` to repo max, admitting only
permanently-skipped slots. Its failure message is *"the pending suffix has a
HOLE in it"*.

So a high number is a **queue position**, not a free-standing choice: `0219`
cannot go green on a branch that lacks `0211`–`0218`. It goes green stacked on
them, or after they land. Neither `migration-state.mjs` nor
`npm run verify:prepush` catches a gap — only that guard does, so a lane can
look clean locally and still be structurally unmergeable.

**Do not weaken that guard to make a number convenient.** Build a coherent
chain instead; an integration branch carrying `0211`–`0218` is the sanctioned
way to prove a `0219` migration locally without waiting for eight merges.

### Apply order is lexical

`supabase db push` orders by filename, so a higher number applies later. A
claim's position in this table is therefore also its apply position.
