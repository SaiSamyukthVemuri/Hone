# Hone local patches to vendored skills

The skills under `.agents/skills/` are vendored from a third party. This file is
the record of every place Hone's copy **deliberately differs** from what upstream
shipped, and why.

Read it as two layers.

## Layer 1 — upstream base (unmodified)

| | |
|---|---|
| Upstream source | [`emilkowalski/skills`](https://github.com/emilkowalski/skills) (GitHub) |
| Captured revision | `d23d7f88a2e21c9e4b1418c7abe420f5c1052ba7` (`main`, committed 2026-08-21T09:32:32Z) |
| Vendoring commit | `da430f793f9e3a28c3bc6c0c3315287c92018f26` |

At commit `da430f79`, **all ten** vendored markdown files were byte-identical to
that upstream revision, verified by sha256 comparison against the fetched
sources:

| File | sha256 at `da430f79` |
|---|---|
| `emil-design-eng/SKILL.md` | `e71de849347050c2c573c1cf24d742d5a13459557ecffa6e562f08006f46b5b7` |
| `find-animation-opportunities/SKILL.md` | `91c1243164057fbf824088d12faea937878a757a7ac653e8288b775e8b27b882` |
| `improve-animations/SKILL.md` | `68f17bbc4671593d2f43dba26a679243e2153ba5f26965fb7d59df52842534ff` |
| `improve-animations/AUDIT.md` | `551c8473e20e5f4774680bc24d45e1c68e50992582720905c6b077756b7b5a55` |
| `improve-animations/PLAN-TEMPLATE.md` | `0a08ac8e23fd2082d7ffb86aeed7b789de77328c3cf874b16f1a755f2ef0a6ad` |
| `pick-ui-library/SKILL.md` | `4b889bd6c08358499ac4a7202b8af71ffbd3485d2468f7b09d0613bbe7b24bf4` |
| `prototype/SKILL.md` | `2ad8401c4deaddb54947fb65247f790e7b3d8784e35312bcbedbfb1d59cd89ce` |
| `prototype/PICKER.md` | `31a55eec94715cc79942e91e172e539e3031dcd5e2e5ee7c1446cf2caee960a6` |
| `review-animations/SKILL.md` | `61cf8ac0c4c8e1f63385298c546b16c65ca9aec34abddcd04e821c16712d671d` |
| `review-animations/STANDARDS.md` | `e7d3605034acda54ca13e43aec9e64d65b53de20f75b11b8d694e373012fbe07` |

That commit is preserved unmodified as historical provenance. **The upstream
originals remain fully recoverable from it** — no history was rewritten and the
vendoring commit was not amended:

```bash
git show da430f79:.agents/skills/prototype/PICKER.md
git show da430f79:.agents/skills/emil-design-eng/SKILL.md
git diff da430f79 HEAD -- .agents/skills   # exactly the deviations listed below
```

## Layer 2 — Hone patch layer

**The current tree is therefore NOT byte-identical to upstream.** Exactly two
files carry local changes, applied in reviewed commits on top of the vendoring
commit:

- `.agents/skills/prototype/PICKER.md`
- `.agents/skills/emil-design-eng/SKILL.md`

The other eight vendored files remain byte-identical to Layer 1.

| Patch | Commit | Scope |
|---|---|---|
| 1 | `1a6ba35e` | the three original Codex P2s — deviations 1, 2, 3 below |
| 2 | child of `1a6ba35e` on this branch, subject *"validate the whole `?v` parameter"* | deviation 4 below — a regression introduced by patch 1 |

A commit cannot contain its own hash, so patch 2 is pinned above by parentage and
subject; its literal SHA is recorded in the PR body and resolvable with
`git rev-list 1a6ba35e..HEAD`.

### Why patch rather than take upstream as-is

These skills are instructional: agents copy the snippets in them into real
product code. A defect in an example propagates into whatever it is copied into,
so a wrong example is a latent defect generator, not a cosmetic typo. All were
found by Codex review on this PR (reviews `5013504323`, `5018583953`,
`5019308492`), rated P2, and each is a genuine deviation from a stated contract —
deviations 1-3 from upstream's own contracts, deviation 4 from the contract
patch 1 had just tightened.

### The deviations

#### 1. Picker restores an out-of-range variant into a blank stage

- **File**: `prototype/PICKER.md` — reference wiring, initial restore
- **Codex finding**: `3848270569` (P2)
- **Upstream**: `setActive((parseInt(...get('v'), 10) || 1) - 1)` passes an
  unvalidated index to `setActive`, whose own guard returns early when it is out
  of range — so `?v=5` against a three-variant picker mounts nothing at all.
- **Hone**: parse, then validate against `1..variants.length`; anything missing,
  malformed, `< 1`, or `> N` falls back to **variant 1**. Deliberately a fallback,
  not a clamp to the nearest endpoint.
- **Contract agreement**: the behavior-contract bullet now states the variant-1
  fallback and the never-blank guarantee explicitly, matching the code.

#### 2. Picker acts on Shift-modified shortcuts

- **File**: `prototype/PICKER.md` — `keydown` handler
- **Codex finding**: `3852702449` (P2)
- **Upstream**: the modifier guard tests `metaKey`, `ctrlKey`, `altKey` but not
  `shiftKey`, so `Shift+R` and `Shift+ArrowRight` still replay and switch.
- **Hone**: `shiftKey` added to the guard.
- **Contract agreement**: the contract already said to ignore key events "when a
  modifier is held" — upstream's code simply did not implement it. Prose was
  correct; the code is now brought up to it.

#### 3. Spring example never retargets

- **File**: `emil-design-eng/SKILL.md` — "Spring-based mouse interactions"
- **Codex finding**: `3852702437` (P2)
- **Upstream**: `useSpring(mouseX * 0.1, {...})` passes a plain number. Motion
  reads a raw number only as the spring's *initial* value, so if `mouseX` is
  React state the spring is seeded once and never tracks the pointer — the
  example demonstrates the opposite of what the surrounding prose claims.
- **Hone**: the example now drives a `useMotionValue` source updated on
  `pointermove`, derives the target with `useTransform`, and passes that
  `MotionValue` into `useSpring`.
- **Contract agreement**: the prose now states the `MotionValue`-not-number rule
  and names the failure mode, so example and prose agree.

#### 4. Picker accepted partially-numeric `?v` values (regression in patch 1)

- **File**: `prototype/PICKER.md` — reference wiring, initial restore
- **Codex finding**: `3853324003` (P2)
- **Introduced by**: patch 1 (`1a6ba35e`), not by upstream. Deviation 1 added the
  range check but left `parseInt` as the parser in front of it.
- **Why `parseInt` was insufficient**: it reads a *leading numeric prefix* and
  silently discards the rest, so `parseInt('2abc', 10)` and `parseInt('2.5', 10)`
  both return `2`. `Number.isInteger(2)` then passes, the range check passes, and
  a malformed parameter restored **variant 2** instead of falling back to variant
  1. The range validation was right; the parsing ahead of it was not. Confirmed
  failing inputs: `?v=2abc`, `?v=2.5`, `?v=3xyz`, `?v=%202`.
- **Hone**: validate the *whole* raw string before any conversion —
  `raw !== null && /^\d+$/.test(raw) ? Number(raw) : NaN` — then
  `Number.isSafeInteger` and the `1..variants.length` range check. Anything else
  falls back to variant 1.
- **Deliberate decision on leading zeros**: `/^\d+$/` accepts `02`, and that is
  intended — `?v=02` is an unambiguous decimal `2` and restores variant 2. Stated
  in the code comment and the behaviour contract, and pinned by its own case
  assertion, so it is a decision rather than an accident.
- **Rejected**: whitespace (`%202`, `2%20`), decimals (`2.5`), prefixes (`abc2`),
  suffixes (`2abc`, `3xyz`), exponent notation (`1e2`, `1e0`), hex (`0x2`),
  `Infinity`, `NaN`, negatives (`-2`), empty, missing, `0`, out-of-range (`4`, `5`
  at N=3), and values beyond `Number.MAX_SAFE_INTEGER` (20 digits, `2^53+1`).
- **Contract agreement**: the contract bullet now names the accepted shape — a
  complete decimal-integer string, `02` accepted, `2abc`/`2.5`/`1e2`/`%202`/`-2`
  rejected — so prose and code agree.

## Note on `skills-lock.json`

`skills-lock.json` was **left untouched** by the patch layer, deliberately.

It records installer provenance — `source`, `sourceType`, `skillPath`, and an
opaque `computedHash` per skill. That `computedHash` is not a sha256 of the file
it names and is not reproducible from the vendored bytes under any ordinary
normalization; nothing in this repository reads the file. It describes **Layer 1**,
the installed upstream base — not the patched payload.

Mutating an undocumented third-party digest scheme to describe local edits would
invent a meaning the format does not have. This file is the disclosure instead:
`emil-design-eng/SKILL.md` is named in the lockfile and now carries a local
patch, and `prototype/PICKER.md` is not referenced by the lockfile at all.

## Maintaining this

On any future upstream re-pull, re-apply these deviations or consciously
retire them, and update this file in the same commit. If a deviation is accepted
upstream, drop it here and note the upstream revision that absorbed it.
