# Allocating a migration number across concurrent lanes

**This file is process and traps. It deliberately holds NO reservation table.**

## The live register is not in this repository

In-flight claims live in an append-only shared file on the build host:

```
~/hone-migration-coordination.md        # /home/sam/hone-migration-coordination.md
```

Lanes have coordinated through it since 2026-10-11 — `docs/production/migration-ledger.md`
references it by path — and it is where a number is actually **allocated**.

**A copy of its table does not belong here**, and this file does not keep one. Two
registers would drift within a day, and the repository's own convention is one
map per fact, not a second competing one. What belongs in the repository is the
part that outlives any single sprint: the authorities, the procedure, and the
traps that have each already cost a lane real time.

---

## Which question has which authority

| Question | Authority | How to get it |
|---|---|---|
| repo max · next free · totals · duplicates | **DERIVED** from `supabase/migrations/*.sql` | `npm run migration:state -- --json` |
| hosted max · when applied | **DECLARED** in `docs/production/migration-state.json` | read it **on a current-production base** — see the trap below |
| the narrative apply record | `docs/production/migration-ledger.md` | never rewritten |
| **who claims an unmerged number** | **`~/hone-migration-coordination.md`** | append your claim there |

A claim is not derivable, because it lives on a head that is not in the tree.
That is the same reason hosted state is declared rather than derived, and it is
the only thing the shared register adds.

---

## Allocating

1. **Census all four sources** — hosted (naming the base you read it on), the
   repository (derived), **every open PR's own head**, and **every worktree
   including uncommitted files**. #824 requires the worktree dimension
   explicitly, and an uncommitted migration in another lane's worktree is a real
   claim that no `git` query against `origin` will show you.
2. Take the first free number above every claim.
3. **Append the claim to `~/hone-migration-coordination.md`** in the same change
   that adds the migration file, with the number, the branch, the PR, the file
   name and its sha256.
4. Read the contiguity law below before assuming your number can go green.

### Verify a number from heads, never from prose

```bash
gh pr list --state open --limit 120 --json number,headRefName --jq '.[]|"\(.number) \(.headRefName)"' |
while read -r n br; do
  git fetch -q origin "pull/$n/head"
  echo "#$n $(git diff --name-only $(git merge-base FETCH_HEAD origin/claude/build-hone-saas-hOex7) FETCH_HEAD \
          -- supabase/migrations/ | sed 's|.*/||' | tr '\n' ' ')"
done
```

Run it over **every** open PR, not the ones that look relevant. Expect
stack-mates to repeat a number — a PR whose branch also contains a lower lane's
file is stacked on it, which is **one** claim, not two.

**Do not read a number off anyone's summary, including your own earlier
comment.** That exact failure happened in this sprint: a lane posted a correct
census, then four minutes later claimed a number from its own prose that had
silently dropped a row, and repeated the bad claim twice before a peer caught
it. A number you typed is not evidence.

### TRAP: hosted state is per-worktree

`docs/production/migration-state.json` is a **file in a branch**. Read it in a
worktree sitting on an old base and it answers for that base, with no error and
no warning. Measured 2026-10-12: `/srv/hone/worktrees/db-acl01-payment-helpers`
(HEAD `a5f3aa27`) reports `hosted_migration_max: 0202`, while the same file on
production `6c5eac80` reports **`0210`** — eight numbers of drift.

**State the base. A census without a base is not a census.**

---

## The contiguity law decides your schedule, not just your number

`tests/docs/canonical-production-facts.test.ts:568-578` requires the pending
suffix to be **contiguous** from `hosted + 1` to repo max, admitting only
permanently-skipped slots (`scripts/migration-state.mjs:43` — `0158` only). Its
failure message is *"the pending suffix has a HOLE in it"*.

So a high number is a **queue position**, not a free-standing choice: a `0219`
cannot go green on a branch lacking `0211`–`0218`. Neither
`migration-state.mjs` nor `npm run verify:prepush` catches a gap — only that one
guard does, so a lane can look clean locally and still be structurally
unmergeable.

**Never weaken that guard to make a number convenient.** Prove a high number on
an **isolated integration branch** that carries the numbers beneath it from
their own heads, leaving every reviewed branch untouched. That gives a coherent
chain locally without waiting for the merges and without relaxing anything.

Apply order is **lexical** (`supabase db push`), so a number's position is also
its apply position.

## Merge-time conflicts are predictable — forecast them before you merge

Integrating several lanes' numbers at once concentrates conflicts in a few
shared files rather than in the migrations. Measured on this sprint's
`0211`–`0218`: the migration SQL files never conflicted and were **byte-identical
across every carrier**, while `docs/production/migration-ledger.md` conflicted
for four of five lanes because each appends its own pending block — resolve by
**union**, dropping no lane's entry. The current-max migration's own test also
conflicts whenever two lanes both perform the CLAUDE.md §2 `isRepoMax` handoff;
inspect before resolving, because that one is typically **comment-only** with no
assertion differing.

Shared files nearly every lane touches, which auto-merge but are worth watching:
`lib/export/resource-registry.ts`, `tests/security/service-role-allowlist.ts`,
`lib/supabase/middleware.ts`.
