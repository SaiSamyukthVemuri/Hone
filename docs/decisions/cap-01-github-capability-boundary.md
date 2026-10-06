# CAP-01 — ENG-LOOP V2 GitHub capability boundary

| Field | Value |
|---|---|
| **Decision** | Raw GitHub and network capability is **positive and scarce**. One transport package owns it; one orchestrator consumes it through narrow, frozen readers. Every other ENG-LOOP V2 module receives only normalized values. The allowed dependency graph is **declared**, and everything else is forbidden, by build-failing allowlist guards. |
| **Date** | 2026-10-06 |
| **Status** | **PROPOSED** in this pull request; **ACCEPTED** when merged. |
| **Decided by** | Sam (operator): the extended positive capability model and its single recorded residual, accepted for the current advisory ENG-LOOP authority level after PR-SNAPSHOT-01's stop law (PR #803). |
| **Scope** | Every runtime module under `scripts/eng/v2/`, the V2 entry shim, and every runtime module that could import them. |
| **Not in scope** | Runtime implementation; edits to #800, #802 or #803; `ci.yml`; 05A; 05B; ARCH-02. |
| **Authored at** | production `4eccefd2fff7efa1abc1a9048531e8046865027d`. |

> **What this boundary is — and is not (accepted residual, §10).** The mechanical module boundary is **strong protection
> against accidental architectural leakage**. It is **not a hostile-code sandbox**. In-process code that is already
> trusted and executable may ultimately possess ways to create an independent network capability outside the intended
> module graph unless the runtime itself is process- or network-isolated. That residual is accepted **only** for
> today's advisory ENG-LOOP authority level. §11 says when it stops being acceptable.

> **Normative and self-contained.** This record relies on nothing outside production. A change to these semantics is
> made here first, never through a review-repair round.

---

## 1. The principle

- **Capability is granted, not available.** Code does not get GitHub or network access because it can import a
  generic client; it gets it only by being a named node in the graph of §3.
- **Capability is also a value.** A capability-bearing value — the transport entry's exports, the readers object and
  its methods — is confined as strictly as the imports that produce it (§6, G4). An allowed edge never carries it
  further.
- **Outside the transport, only values.** Outside the transport package (§4), ENG-LOOP code receives only normalized
  values and narrow interfaces.
- **Positive enforcement.** The guards (§8) prove that every dependency is a declared edge. They do **not** enumerate
  forbidden GraphQL fields, REST endpoints, identifier names, or alternate ways to reconstruct a pull request's
  identity. That approach was retired: it is negative enumeration over an open domain.

## 2. Packages

Paths are relative to `scripts/eng/v2/` unless stated.

| Package | Path | Role |
|---|---|---|
| **contract** | `contract/**` | Normalized, immutable, capability-free data types and their validating constructors |
| **transport** | `adapter/internal/github/**` | The only package with raw GitHub capability (§4) |
| ↳ primitive | `adapter/internal/github/primitive.mjs` | The only module that imports `node:child_process`; it issues `gh api` requests |
| ↳ transport entry | `adapter/internal/github/index.mjs` | Exports `createReaders()` and nothing else |
| **collect** | `adapter/internal/collect.mjs` | The only consumer of the readers; runs collection passes (§6) |
| **binders** | `adapter/internal/bind/**` | Pure functions from normalized records to evidence |
| **05A entry** | `adapter/index.mjs` | Exports `collect` and re-exports contract types |
| **05B** | `decision/**` | The pure decision engine |
| **05C render** | `cli.mjs` | Exports `run(args, sink)`; formats an outcome for a sink it is given |
| **entry shim** | `scripts/eng/shepherd-v2.mjs` (outside `v2/`) | Maps `argv`, standard output and the exit code to `run()` |

## 3. The exact allowed dependency graph

A **runtime module** is any repository source file that is not a test or a test fixture. Every static import or
re-export of a runtime module must be one of these edges. **Nothing else is allowed.**

| From | May import |
|---|---|
| `contract/**` | `contract/**` |
| `adapter/internal/github/primitive.mjs` | `node:child_process`, `node:buffer`, `contract/**` |
| other `adapter/internal/github/**` | `adapter/internal/github/**`, `node:zlib`, `node:crypto`, `node:buffer`, `contract/**` |
| `adapter/internal/collect.mjs` | `adapter/internal/github/index.mjs`, `adapter/internal/bind/**`, `contract/**` |
| `adapter/internal/bind/**` | `adapter/internal/bind/**`, `contract/**` |
| `adapter/index.mjs` | `adapter/internal/collect.mjs`, `contract/**` |
| `decision/**` | `decision/**`, `contract/**` |
| `cli.mjs` | `adapter/index.mjs`, `decision/index.mjs`, `contract/**` |
| `scripts/eng/shepherd-v2.mjs` | `scripts/eng/v2/cli.mjs` |
| any other runtime module in the repository | no `scripts/eng/v2/**` module |

These edges are excluded **by not being listed**:
- any `node:` built-in other than those above, and any npm package, anywhere in `v2/`;
- `primitive.mjs` from outside the transport package;
- the transport from anything but `collect.mjs`, which reaches `index.mjs` only;
- `collect.mjs` from anything but `adapter/index.mjs`;
- `decision/**` → `adapter/**`;
- any `v2/` → `scripts/eng/*.mjs`. CP-005a's `github-facts.mjs` uses both `execFileSync("gh")` and `fetch`, so it is a
  ready-made bypass.

`node:zlib`, `node:crypto` and `node:buffer` give the transport decompression, hashing and byte handling. None of them
reaches the network.

**Edges are necessary, not sufficient.** A capability-bearing value could still travel across allowed edges — as a
re-export, a returned function, an argument or a captured closure. §6 confines it, and G4 and G3 enforce that.

## 4. The transport package — who owns raw GitHub

- **One primitive.** `primitive.mjs` is the only module that can reach GitHub: it runs `gh api` with the operator's `gh`
  credential. It exports a request function to the rest of the transport package only (§3).
- **One entry, one export.** `index.mjs` exports `createReaders()`, which returns a frozen object of narrow readers. No
  general request function leaves the package.
- **Reader rules (frozen):**
  - each reader has one fixed GraphQL document or one fixed REST route template;
  - its parameters are typed scalars only — a PR number, a 40-hex commit SHA, a numeric run or artifact id, a repository
    file path. No reader accepts query text, a route, a branch name or a ref name;
  - it returns a normalized record typed in `contract/**`. Raw responses — for example a workflow run's
    `pull_requests` — never leave the transport package;
  - exactly one reader, `readPrKey`, reads a pull request's current **identity and lifecycle** — its state, draft flag,
    head, base and their repositories — all from **one request**. No other reader's output carries any of them.
- **The V1 reader set.** Adding, removing or changing a reader is an amendment to this record first.

| Reader | Parameters | Returns | Consumer |
|---|---|---|---|
| `readPrKey` | PR number | the PR identity and lifecycle value, including the draft flag, from one request | PR-SNAPSHOT-01; ARCH-01 draft hold |
| `readReviewEvidence` | PR number | reviews, issue comments, review threads | ARCH-01 review authority |
| `readCommitRollup` | commit SHA | that commit's external status contexts | ARCH-01 external checks |
| `readCandidateRuns` | head SHA | the designated workflow's `pull_request` runs at that SHA, with immutable run metadata only | ARCH-01 CI; CI-ATTEST-01 |
| `readRunAttestation` | run id | that run's attestation record and artifact metadata | CI-ATTEST-01 |
| `readCompare` | base SHA, head SHA | behind and ahead counts, and the merge-base SHA | ARCH-01 drift; CI-ATTEST-01 trust anchor |
| `readFileBlob` | file path, commit SHA | the git blob SHA of that file at that commit | CI-ATTEST-01 trust anchor |

## 5. What crosses outward

The **contract** package holds every value that crosses a package boundary — the PR identity value, the reader records,
the evidence, the outcome union and the closed reason set — as **plain immutable data with validating constructors**. It
imports nothing outside itself and holds no capability. The field definitions belong to the records that own those
values; this record fixes only their nature.

## 6. How 05A consumes the capability

- **`collect.mjs` is the only module holding readers.** It calls readers with values (a PR number, SHAs, ids) and
  receives records. It passes those records, with the PR identity value, to pure binders, and builds evidence or
  `UNKNOWN` through `contract/**` constructors.
- **The readers never leave `collect`'s body.** `createReaders()` is called once, as the initializer of one `const`
  in the body of the exported `collect` function. That binding is used only as the object of a dotted call to a reader
  name of §4 (`readers.readCompare(…)`). It is never exported, re-exported, returned, passed as an argument, assigned
  or destructured into another binding or property, spread, or captured by a nested function. The imported
  `createReaders` binding is used only in that one call. The only value leaving a reader call is a record.
- **No capability parameter.** `collect` takes no readers, client or transport argument. A caller cannot inject a
  self-built reader backed by its own network access. Tests replace the transport package by module mocking.
- **Binders hold nothing.** They import only `contract/**` and `bind/**`, and they receive values.

## 7. How 05B stays capability-free

`decision/**` may import only `decision/**` and `contract/**`, and `contract/**` imports nothing outside itself. So 05B's
whole dependency closure contains no network-capable module (proved by G1). G2 also denies it every ambient capability.

## 8. Mechanical enforcement — build-failing allowlist guards

Each guard runs in CI's unit lane and fails the build. Each also carries the fixtures of §9, so it cannot pass
vacuously.

- **G1 — module graph (allowlist).** Compiler-backed module resolution resolves every static `import` and
  `export … from` in each `v2/` runtime module and the entry shim. It also resolves every import in the repository's
  other runtime modules that lands in `v2/`. Every resolved edge must appear in §3, and any dynamic `import()` in `v2/`
  fails. Edges are matched by **resolved module identity**, so a path alias or a re-export is an edge like any other.
  Precedent: `tests/app/finance/financials-truth.test.ts`.
- **G2 — free identifiers (allowlist).** Scope analysis of every `v2/` module requires each reference that resolves to
  no binding to be on a frozen allowlist of ECMAScript built-ins:
  - `Object`, `Array`, `Map`, `Set`, `WeakMap`, `WeakSet`, `JSON`, `Math`, `Number`, `String`, `Boolean`, `Symbol`,
    `BigInt`, `Promise`, `Error`, `TypeError`, `RangeError`, `SyntaxError`, `RegExp`, `Date`, `Uint8Array`,
    `ArrayBuffer`, `DataView`;
  - anything else fails without needing to be named — `fetch`, `process`, `require`, `module`, `globalThis`, `eval`,
    `Function`, `Reflect`, `Buffer`, `console` and timers among them;
  - a member access named `constructor`, dotted or with a literal key, also fails.

  The guard runs as a test, not as an ESLint flat-config block, because flat config **replaces** a rule's options for
  overlapping file sets. This repository has already lost guards that way (`eslint.config.mjs`, UI-05 and FIN-01A).
- **G3 — frozen surface.** Checked-in golden files hold:
  - the export surface of every module with an importer outside its own package — `github/index.mjs`, `collect.mjs`,
    `adapter/index.mjs`, `decision/index.mjs`, `cli.mjs` and the contract entry — so a new export, such as a
    re-exported `createReaders` or a function that returns readers, fails;
  - the reader names `createReaders()` returns;
  - each reader's GraphQL document or REST route template, and its parameter types;
  - each reader's output schema;
  - the entry shim's content.

  Any difference fails until this record and the goldens are amended in the same change.
- **G4 — capability flow (allowlist of uses).** Scope analysis of `collect.mjs` allows exactly the uses of §6 for the
  imported `createReaders` binding and the binding it initializes:
  - one call of `createReaders()`, as a `const` initializer in the body of the exported `collect` function;
  - dotted calls `readers.<reader name of §4>(…)` in that same function body.

  Every other reference fails: an export or re-export, a return, an argument, an assignment, a destructuring, a
  property value, a spread, or a capture by any nested function. A reference from any other module is already a G1
  failure. Like G2, G4 lists what is allowed, never what is forbidden.

## 9. Fixtures

| # | Fixture | Required result |
|---|---|---|
| P1 | the full graph of §3 | passes |
| P2 | a binder reading properties of the PR identity value it was given | passes — reading a value is not reading GitHub |
| P3 | `primitive.mjs` importing `node:child_process` | passes |
| P4 | `decision/**` importing `contract/**` | passes |
| P5 | the entry shim importing `v2/cli.mjs` | passes |
| P6 | `collect` calling `readers.readCommitRollup(sha)` and `readers.readPrKey(n)` in its own body, inside `Promise.all` | passes |
| N1 | a binder importing `node:child_process`, `node:https`, `node:http2`, `node:net`, `node:tls`, `node:vm`, `node:module` or `node:worker_threads` | G1 fails |
| N2 | an npm package imported anywhere in `v2/`, or a network built-in in a transport file other than `primitive.mjs` | G1 fails |
| N3 | `collect.mjs` importing `primitive.mjs` directly; a binder importing the transport entry | G1 fails |
| N4 | `decision/**` importing `adapter/index.mjs` or anything under `adapter/` | G1 fails |
| N5 | any `v2/` module importing `scripts/eng/github-facts.mjs` | G1 fails |
| N6 | a dynamic `import(…)` anywhere in `v2/` | G1 fails |
| N7 | a free reference to `fetch`, `process`, `globalThis`, `require`, `eval`, `Function` or `Reflect` in any `v2/` module | G2 fails, because none is on the allowlist |
| N8 | `[].constructor.constructor` | G2 fails |
| N9 | a new or renamed reader, a changed query or route, or a changed output schema, without a golden and record amendment | G3 fails |
| N10 | a runtime module outside `v2/`, other than the shim, importing any `v2/` module | G1 fails |
| N11 | a non-transport module re-exporting `primitive.mjs` | G1 fails |
| N12 | `collect.mjs` re-exporting `createReaders`, or `adapter/index.mjs` re-exporting it again for `cli.mjs` | G4 and G3 fail |
| N13 | `collect` returning the readers, passing them to a binder, or storing them in a property | G4 fails |
| N14 | a nested function in `collect.mjs` capturing the readers binding (`(sha) => readers.readCandidateRuns(sha)` handed onward) | G4 fails |
| N15 | destructuring a reader out of the binding (`const { readPrKey } = readers`) | G4 fails |
| N16 | any reader other than `readPrKey` returning the draft flag, state, head, base or their repositories | G3 fails (frozen output schema) |
| R1 | a runtime-computed or reflective property path that reaches the `Function` constructor | **not rejected** — the accepted residual (§10). It is recorded as undetected, never claimed as covered. |

## 10. The accepted residual (recorded exactly)

> In-process code that is already trusted/executable may ultimately possess ways to create an independent network
> capability outside the intended module graph unless the runtime itself is process/network isolated.
>
> Therefore the mechanical module boundary is **strong protection against accidental architectural leakage** — **NOT** a
> hostile-code sandbox. Do not describe it as stronger than it is.

Example of such a way, not rejected by any guard: a runtime-computed or reflective property path that reaches the
`Function` constructor (fixture R1).

This residual is accepted **only** for the current advisory ENG-LOOP authority level:
- ENG-LOOP is advisory and observation-oriented;
- humans keep production merge authority;
- the problem being solved is accidental capability leakage and architectural drift, not hostile code running inside
  the trusted controller process.

Evidence for the residual and for the guards, read on 2026-10-06:
- Node `v20.20.2` exposes `fetch` and `process.getBuiltinModule` as globals.
- Today's lint configuration raised **no** message for any of six ambient routes in a `v2/` path (Appendix).
- The repository's FIN-01A lint block already records the same class of limit and calls lint confinement "a coding
  constraint, not a proof".

## 11. Isolation re-entry trigger

Process or network isolation becomes a **mandatory architecture conversation before** ENG-LOOP is granted materially
stronger autonomous authority, and especially before any ability to perform high-impact actions without a human release
gate. That includes considering:
- autonomous production merge;
- authoritative control-plane mutation;
- unrestricted credential-bearing actions;
- executing untrusted code with controller credentials.

Today's residual is **never silently inherited** into those authority levels. A proposal for any of them that does not
first settle isolation is incomplete by this record.

## 12. Re-entry order

Each re-entry **removes** enforcement this record supersedes. None stacks a second mechanism on top.

1. **CAP-01** (this record) merges.
2. **#803 (PR-SNAPSHOT-01) by removal.** Delete its field-level guard bullet (§9) and fixture 15, and point to this
   record. Its open P2 `4195119994` resolves by construction: no field list remains to be incomplete.
3. **#802 (CI-ATTEST-01) by removal.** Remove its own reads of the pull request; it reaches attestations only through
   `readRunAttestation` and compares with the PR identity value.
4. **#800 (ARCH-01) by removal.** Replace its module-boundary table and its 05A/05B guard-test text with a pointer to
   this record. Its head-keyed REST rule becomes this record's typed reader parameters.
5. The minimal `ci.yml` attestation step.
6. 05A.
7. 05B.

## 13. Review budget

One legitimate semantic repair round is allowed. A second fresh, legitimate semantic P0–P2 in the **same** family →
**stop**: no further patch, and a return to architecture discussion.

Families: the dependency graph; the transport and its readers; the enforcement guards; the residual and the isolation
trigger.

Pure prose, formatting or non-normative feedback does not consume the budget.

**Spent in round 1** (Codex review of `3e242b78cc`), one finding in each of two families:
- **enforcement guards** — P1 `4196347828`. Module edges alone let the readers escape as a value across allowed edges:
  `collect` re-exports them, the adapter entry re-exports them again, and the CLI calls them. Repaired: §6 confines the
  readers to `collect`'s body; G4 allowlists their only uses; G3 freezes every cross-package export surface; fixtures
  N12–N15 and P6 cover it.
- **transport and its readers** — P2 `4196347838`. `readReviewEvidence` returned the draft flag, a second reader of PR
  lifecycle. Repaired: the draft flag moved into `readPrKey`'s single request; fixture N16 covers it.

A further semantic finding in either family stops this record's patch loop.

## 14. Non-goals

This record adds no runtime code, guard implementation, `ci.yml` change, 05A, 05B or ARCH-02. It adds no denylist of
GraphQL fields, REST endpoints or identifier names, and no process isolation for the current authority level.

---

## Appendix — evidence (2026-10-06, read only)

| Probe | Result |
|---|---|
| `node --version`; `typeof fetch`; `typeof process.getBuiltinModule` | `v20.20.2`; `function`; `function` |
| ESLint on stdin as `scripts/eng/v2/adapter/internal/bind/probe.mjs`, holding `fetch(…)`, `globalThis.fetch(…)`, `process.getBuiltinModule("node:child_process")`, `import("node:https")`, `[].constructor.constructor` and a computed-key `Function` chain | **0** messages under today's configuration; no file was written |
| `scripts/eng/github-facts.mjs` (CP-005a) | uses `execFileSync("gh", …)` from `node:child_process` **and** the global `fetch` |
| `eslint.config.mjs`, FIN-01A block | "a CODING CONSTRAINT on the code FIN owns, not a proof"; lists `import("node:module")` and `globalThis.process.getBuiltinModule(...)` as forms its rules do not reject |
