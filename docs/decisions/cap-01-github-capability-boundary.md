# CAP-01 — ENG-LOOP V2 declared GitHub capability graph (architectural lint, not a sandbox)

| Field | Value |
|---|---|
| **Decision** | Within ENG-LOOP V2 source, raw GitHub and network access is **declared and architecturally confined**: one transport layer performs it, one orchestrator holds its readers, and every other V2 module handles values only. Build-failing **static** guards detect unsupported dependency and capability paths that are statically visible — **accidental drift**. They are **not** a hostile-code containment boundary (§1, §10). |
| **Date** | 2026-10-06 |
| **Status** | **PROPOSED** in this pull request; **ACCEPTED** when merged. |
| **Decided by** | Sam (operator): the positive capability model accepted after PR-SNAPSHOT-01's stop law (PR #803), and — after this record's own stop law — its narrowing to the V1 invariant: Goals A and B required now, Goal C not (§1). |
| **Scope** | Every runtime module under `scripts/eng/v2/`, the V2 entry shim, and every other runtime module's static imports into them. |
| **Not in scope** | Runtime implementation; edits to #800, #802 or #803; `ci.yml`; 05A; 05B; ARCH-02. |
| **Authored at** | production `4eccefd2fff7efa1abc1a9048531e8046865027d`. |
| **Amended** | CAP-01-READER-STATE-01, 2026-10-06 (§15): `readCandidateRuns` also returns each candidate run's mutable execution state. |

> **What this record is — and is not.** It provides **Goal B, accidental architecture-drift protection**, through static
> architectural lint. It does **not** provide **Goal C, hostile in-process capability containment**, and Goal B does not
> prove Goal C (§1).
> - **Bypass:** trusted code executing in the same process may be capable of bypassing static module rules using
>   non-static loaders, runtime-provided APIs, reflection or other same-process capabilities.
> - **No credential exclusivity:** Hone is a **public repository**, so anonymous GitHub REST reads can remain available
>   even without a credential. Credential isolation alone therefore does not establish exclusive read authority.
>
> This residual is accepted for today's advisory authority level only (§10). §11 says when a stronger isolation
> architecture must be decided.

> **Normative and self-contained.** This record relies on nothing outside production. A change to these semantics is
> made here first, never through a review-repair round.

---

## 1. Goals, the V1 invariant and the principle

| Goal | Meaning | Status |
|---|---|---|
| **A — collection correctness** | Evidence is collected correctly: one PR identity key per pass (`K0`, collect, `K1`, `K0 == K1`), the bounded full re-read for mutable non-key evidence, immutable run-side CI attestation, `UNKNOWN` failing closed | **Required now.** Owned by PR-SNAPSHOT-01, ARCH-01 and CI-ATTEST-01, not by this record. |
| **B — accidental architecture-drift protection** | ENG-LOOP V2 source does not drift into undeclared GitHub or network access | **Required now.** This record. |
| **C — hostile in-process capability containment** | Code in the same process cannot obtain GitHub or network access outside the declared graph | **Not required** at the current advisory authority level. This record does **not** provide it, and Goal B does not prove Goal C. |

**The V1 invariant — sufficient now.** Within ENG-LOOP V2 source:
- only the transport layer performs declared GitHub and network I/O;
- only `collect` owns and holds the readers;
- binders operate on values only;
- 05B operates on normalized Evidence only;
- the CLI receives and renders values and does not own raw GitHub capability.

**The principle.** *Within ENG-LOOP V2 source, raw GitHub/network access is declared and architecturally confined.
Static guards detect unsupported dependency/capability paths and accidental drift. They are not a hostile-code
containment boundary.*

**Collection correctness never depends on the guards being a sandbox.** Goal A's laws are unchanged, and the records
that own them still require:
- the key read before and after every pass, with `K0 == K1`;
- the bounded full re-read;
- immutable run-side attestation;
- `UNKNOWN` failing closed;
- human merge authority.

Those laws assume the trusted V2 code follows this architecture — for example, that only `readPrKey` reads a pull
request's identity. The static guards (§8) catch accidental departures along statically resolvable paths. A departure by
non-static means goes undetected; that is part of the residual accepted in §10.

**Positive, not enumerative.** The guards (§8) check declared structure. They do not enumerate forbidden GraphQL
fields, REST endpoints, identifier names, loaders, or alternate ways to reconstruct a pull request's identity. That
negative enumeration over an open domain was retired.

## 2. Packages

Paths are relative to `scripts/eng/v2/` unless stated.

| Package | Path | Role |
|---|---|---|
| **contract** | `contract/**` | Normalized, immutable, capability-free data types and their validating constructors |
| **transport** | `adapter/internal/github/**` | The only package **permitted** to perform raw GitHub I/O (§4) |
| ↳ primitive | `adapter/internal/github/primitive.mjs` | The only module permitted to import `node:child_process`; it issues `gh api` requests |
| ↳ reader modules | `adapter/internal/github/readers/*.mjs` | One module per reader of §4; each implements its reader over the primitive |
| ↳ transport entry | `adapter/internal/github/index.mjs` | Assembles the reader modules; exports `createReaders()` and nothing else |
| **collect** | `adapter/internal/collect.mjs` | The only module permitted to hold the readers; runs collection passes (§6) |
| **binders** | `adapter/internal/bind/**` | Pure functions from normalized records to evidence |
| **05A entry** | `adapter/index.mjs` | Exports `collect` and re-exports contract types |
| **05B** | `decision/**` | The pure decision engine |
| **05C render** | `cli.mjs` | Exports `run(args, sink)`; formats an outcome for a sink it is given |
| **entry shim** | `scripts/eng/shepherd-v2.mjs` (outside `v2/`) | Maps `argv`, standard output and the exit code to `run()` |

## 3. The exact allowed dependency graph

A **runtime module** is any repository source file that is not a test or a test fixture. Every import or re-export of a
runtime module must be one of these edges; **nothing else is allowed by this architecture.** G1 checks the statically
resolvable part of that rule (§8). Module acquisition that is not statically resolvable is outside G1's claim and is
part of the accepted residual (§10).

The transport is one directed chain, with **no** generic transport-to-transport edge. Capability flows left to right,
and within the chain each module imports only its left neighbour:

```
primitive.mjs  →  readers/*.mjs  →  index.mjs  →  collect.mjs
```

A helper shared by reader modules would be a new edge, so adding one is an amendment to this record first.

| From | May import |
|---|---|
| `contract/**` | `contract/**` |
| `adapter/internal/github/primitive.mjs` | `node:child_process`, `node:buffer`, `contract/**` |
| `adapter/internal/github/readers/*.mjs` | `adapter/internal/github/primitive.mjs`, `node:zlib`, `node:crypto`, `node:buffer`, `contract/**` |
| `adapter/internal/github/index.mjs` | `adapter/internal/github/readers/*.mjs`, `contract/**` |
| `adapter/internal/collect.mjs` | `adapter/internal/github/index.mjs`, `adapter/internal/bind/**`, `contract/**` |
| `adapter/internal/bind/**` | `adapter/internal/bind/**`, `contract/**` |
| `adapter/index.mjs` | `adapter/internal/collect.mjs`, `contract/**` |
| `decision/**` | `decision/**`, `contract/**` |
| `cli.mjs` | `adapter/index.mjs`, `decision/index.mjs`, `contract/**` |
| `scripts/eng/shepherd-v2.mjs` | `scripts/eng/v2/cli.mjs` |
| any other runtime module in the repository | no `scripts/eng/v2/**` module |

These edges are excluded **by not being listed**:
- any `node:` built-in other than those above, and any npm package, anywhere in `v2/`;
- `primitive.mjs` from anything but a reader module;
- `index.mjs`, and so the reader factory, from anything but `collect.mjs` — no transport module imports it;
- a reader module from anything but `index.mjs`, so a reader module imports neither another reader module nor
  `index.mjs`;
- `collect.mjs` from anything but `adapter/index.mjs`;
- `decision/**` → `adapter/**`;
- any `v2/` → `scripts/eng/*.mjs`. CP-005a's `github-facts.mjs` uses both `execFileSync("gh")` and `fetch`, so it is a
  ready-made bypass.

`node:zlib`, `node:crypto` and `node:buffer` give the transport decompression, hashing and byte handling. None of them
reaches the network.

**Edges are necessary, not sufficient.** The readers are also a value, and a value could travel across allowed edges
— as a re-export, a returned function, an argument or a captured closure. §6 states the intended confinement, and G3
and G4 check it statically.

## 4. The transport package — who owns raw GitHub

- **One primitive.** `primitive.mjs` is the only module **permitted** to reach GitHub: it runs `gh api`, which uses
  the credential of the `gh` session it inherits (§10, §11). Its request function may be imported only by the reader
  modules (§3).
- **One entry, one export.** `index.mjs` assembles the reader modules and exports `createReaders()`, which returns a
  frozen object of narrow readers. No general request function is exported from the package.
- **Reader rules (frozen):**
  - each reader has one fixed GraphQL document or one fixed REST route template;
  - its parameters are typed scalars only — a PR number, a 40-hex commit SHA, a numeric run or artifact id, a repository
    file path. No reader accepts query text, a route, a branch name or a ref name;
  - it returns a normalized record typed in `contract/**`. Raw responses — for example a workflow run's
    `pull_requests` — must never leave the transport package;
  - exactly one reader, `readPrKey`, reads a pull request's current **identity and lifecycle** — its state, draft flag,
    head, base and their repositories — all from **one request**. No other reader's output may carry any of them. A
    workflow run's own head SHA and execution state (below) are run data, not a pull request's identity or lifecycle.
- **The V1 reader set.** Adding, removing or changing a reader is an amendment to this record first.

| Reader | Parameters | Returns | Consumer |
|---|---|---|---|
| `readPrKey` | PR number | the PR identity and lifecycle value, including the draft flag, from one request | PR-SNAPSHOT-01; ARCH-01 draft hold |
| `readReviewEvidence` | PR number | reviews, issue comments, review threads | ARCH-01 review authority |
| `readCommitRollup` | commit SHA | that commit's external status contexts | ARCH-01 external checks |
| `readCandidateRuns` | head SHA | the designated workflow's `pull_request` runs at that SHA, each with its candidate metadata **and** its mutable execution state (below) | ARCH-01 CI; CI-ATTEST-01 |
| `readRunAttestation` | run id | that run's attestation record and artifact metadata | CI-ATTEST-01 |
| `readCompare` | base SHA, head SHA | behind and ahead counts, and the merge-base SHA | ARCH-01 drift; CI-ATTEST-01 trust anchor |
| `readFileBlob` | file path, commit SHA | the git blob SHA of that file at that commit | CI-ATTEST-01 trust anchor |

**The candidate-run record** (CAP-01-READER-STATE-01, §15). `readCandidateRuns` returns two kinds of field for every
run in its listing:

| Kind | Fields | Nature |
|---|---|---|
| Candidate metadata | the run id, workflow id, `run_number`, event and exact head SHA, and the other run metadata the CI binding record compares: the run's repository, head branch and head repository | identity and selection fields; they do not change as the run progresses or is re-run |
| Execution state | `status` (a string), `conclusion` (a string, or `null` before the run completes) and `run_attempt` (a positive integer), exactly as GitHub reports them | **mutable**: they change as the run progresses and when it is re-run |

- **Not identity, not ordering.** Execution state is not part of `PrSnapshotKey` (PR-SNAPSHOT-01), not part of a CI
  attestation's identity, and not a run ordering: `run_number` alone orders runs, and `run_attempt` only bounds an
  attestation within its own run.
- **One complete response per pass.** Each collection pass obtains candidate metadata and execution state from one
  complete GitHub API response (the listing law below).
- **Covered by the bounded re-read, not a new one.** Across passes, execution state is mutable evidence under ARCH-01's
  bounded full re-read, which PR-SNAPSHOT-01 §8 already lists as covering CI status. If the first collection sees the
  run that governs CI `in_progress` and the second sees it `completed`, the normalized evidence changed, and the
  collection never combines the two states. There is no CI-specific re-read.
- **Types only.** The reader checks the types above, and anything else is malformed. It interprets no value: which run
  governs CI, and what its state means, are not CAP-01's (§15).
- **Still never raw.** A run's `pull_requests`, `display_title` and every other raw field stay inside the transport
  package.
- **G3.** The frozen output schema of `readCandidateRuns` now includes `status`, `conclusion` and `run_attempt`
  alongside its candidate metadata, and G3's golden pins them; any change is fixture N9. This remains architectural
  lint, not a runtime proof (§8).

**The single-response listing law (V1).** `readCandidateRuns` makes exactly **one** workflow-runs request per
collection pass, filtered to the authoritative workflow, the exact head SHA and `event=pull_request`, with
`per_page=100`, the maximum page size. It never requests a second page, loops over pages or reconciles cursors. The
response must prove that the whole filtered candidate set is in it:
- `total_count` is a non-negative integer, and `workflow_runs` is an array of run records with no gaps;
- `total_count` equals the array's length, and is at most 100;
- every record has the candidate-run schema above;
- no two records share a run id or a `run_number`.

If the response shows that more candidates exist than it holds — a `total_count` above 100, a count that differs from
the array's length, or an explicit next-page link — the whole evidence snapshot is
`UNKNOWN(ci_candidate_listing_too_large)`. Any other failure of the list above is `UNKNOWN(malformed)`. The reader never
inspects only the first page. ARCH-01's closed reason set gains `ci_candidate_listing_too_large` from this amendment.

A head needing more than 100 `pull_request` runs is exceptional: across all 2,829 of this repository's `ci.yml` runs, no
head SHA has more than two (Appendix). Failing closed there is cheaper and safer than cross-page deduplication,
shifting-page reconstruction, page timestamps, missing-run inference or snapshot reconciliation, none of which V1 has.

**Order.** The response's order means nothing. The CI binding record (CI-ATTEST-01) orders the validated candidates by
`run_number` alone and applies its current-run frontier. No timestamp, run-id or cross-run `run_attempt` ordering is
used.

Required listing fixtures, for the transport's implementation tests:

| # | Response | Required result |
|---|---|---|
| L1 | no runs, `total_count` 0 | a valid, complete, empty listing |
| L2 | N ≤ 100 runs, `total_count` N | a valid, complete listing |
| L3 | 100 runs, `total_count` 101 | `UNKNOWN(ci_candidate_listing_too_large)` |
| L4 | a `total_count` different from the number of runs returned | `UNKNOWN(ci_candidate_listing_too_large)` |
| L5 | two records with the same run id | `UNKNOWN(malformed)` |
| L6 | two records with the same `run_number` | `UNKNOWN(malformed)` |
| L7 | any reordering of a valid response of at most 100 runs | the same normalized listing, and the same frontier result after `run_number` ordering |
| L8 | an explicit next-page link | `UNKNOWN(ci_candidate_listing_too_large)` |
| L9 | a non-integer or negative `total_count`, a missing or non-array `workflow_runs`, or a record outside the schema | `UNKNOWN(malformed)` |

## 5. What crosses outward

The **contract** package holds every value that crosses a package boundary — the PR identity value, the reader records,
the evidence, the outcome union and the closed reason set — as **plain immutable data with validating constructors**. By
design it holds no capability, and it may import nothing outside itself (§3). The field definitions belong to the
records that own those values; this record fixes only their nature.

## 6. How 05A consumes the capability

- **`collect.mjs` is the only module permitted to hold the readers.** It calls readers with values (a PR number, SHAs,
  ids) and receives records. It passes those records, with the PR identity value, to pure binders, and builds evidence
  or `UNKNOWN` through `contract/**` constructors.
- **The readers must never leave `collect`'s body.** `createReaders()` is called once, as the initializer of one `const`
  in the body of the exported `collect` function. That binding is used only as the object of a dotted call to a reader
  name of §4 (`readers.readCompare(…)`). It is never exported, re-exported, returned, passed as an argument, assigned
  or destructured into another binding or property, spread, or captured by a nested function. The imported
  `createReaders` binding is used only in that one call. The only value a reader call may return is a record. G4 checks
  this statically (§8).
- **No capability parameter.** `collect` takes no readers, client or transport argument, so its interface offers no
  injection point for a self-built reader. Tests replace the transport package by module mocking.
- **Binders hold no capability.** They may import only `contract/**` and `bind/**` (§3), and they receive values.

## 7. How 05B stays capability-free

`decision/**` may import only `decision/**` and `contract/**`, and `contract/**` may import nothing outside itself.
So 05B's **statically resolvable** dependency closure contains no network-capable module, which G1 checks. G2 flags
any free reference in it to a global outside its allowlist of ECMAScript built-ins. Neither prevents same-process code
from acquiring capability by non-static means (§10).

## 8. Static enforcement — build-failing architectural lint

Static enforcement exists to catch **accidental** architectural drift (Goal B). It is **not** a security sandbox and
not process security, and it establishes nothing about Goal C. Each guard reads source text and its statically
resolvable structure. Anything they do not read is part of the accepted residual (§10).

Each guard runs in CI's unit lane and fails the build. Each also carries the fixtures of §9, so a guard that checks
nothing fails its own negative fixtures.

- **G1 — static module-edge lint (allowlist).** Compiler-backed module resolution resolves every **statically
  resolvable** module reference: each `import` or `export … from` declaration, and each dynamic `import()` whose
  specifier is a string literal. It does so in every `v2/` runtime module and the entry shim, and for every such
  reference in the repository's other runtime modules that resolves into `v2/`. Every resolved edge must appear in §3.
  Edges are matched by **resolved module identity**, so a path alias or a re-export is an edge like any other.
  Precedent: `tests/app/finance/financials-truth.test.ts`.

  **G1 does not claim coverage** for `require()`, `createRequire()`, computed loaders — including a dynamic `import()`
  whose specifier is not a string literal — runtime reflection, capability created by a worker or a forked process, or
  any other non-static module acquisition. Those are part of the accepted residual (§10), **not** denylist entries
  (fixture R2). The precedent scanner records the same limit: CommonJS produces no dependency site in it.
- **G2 — static free-identifier lint (allowlist).** Scope analysis of every `v2/` module requires each reference that
  resolves to no binding to be on a frozen allowlist of ECMAScript built-ins:
  - `Object`, `Array`, `Map`, `Set`, `WeakMap`, `WeakSet`, `JSON`, `Math`, `Number`, `String`, `Boolean`, `Symbol`,
    `BigInt`, `Promise`, `Error`, `TypeError`, `RangeError`, `SyntaxError`, `RegExp`, `Date`, `Uint8Array`,
    `ArrayBuffer`, `DataView`;
  - anything else fails without needing to be named — `fetch`, `process`, `require`, `module`, `globalThis`, `eval`,
    `Function`, `Reflect`, `Buffer`, `console` and timers among them;
  - a member access named `constructor`, dotted or with a string-literal key, also fails.

  G2 checks names as written. It does not detect capability reached from an allowed built-in through reflection or a
  runtime-computed property path (fixture R1), or by any other non-static means (§10).

  The guard runs as a test, not as an ESLint flat-config block, because flat config **replaces** a rule's options for
  overlapping file sets. This repository has already lost guards that way (`eslint.config.mjs`, UI-05 and FIN-01A).
- **G3 — frozen surfaces (golden lint).** Checked-in golden files hold:
  - the export surface of every module with an importer outside its own package — `github/index.mjs`, `collect.mjs`,
    `adapter/index.mjs`, `decision/index.mjs`, `cli.mjs` and the contract entry — so a new export, such as a
    re-exported `createReaders` or a function that returns readers, fails;
  - the reader names `createReaders()` returns;
  - each reader's GraphQL document or REST route template, and its parameter types;
  - each reader's output schema;
  - the entry shim's content.

  Any difference fails until this record and the goldens are amended in the same change. G3 compares what the source
  declares; it does not observe what a module does at run time. In particular, it freezes neither the HTTP method nor
  the primitive's `gh api` invocation, so it does not prove that a reader stays read-only at run time (§10).
- **G4 — static capability-use lint in `collect.mjs` (allowlist of uses).** Scope analysis of `collect.mjs` allows
  exactly the uses of §6 for the imported `createReaders` binding and the binding it initializes:
  - one call of `createReaders()`, as a `const` initializer in the body of the exported `collect` function;
  - dotted calls `readers.<reader name of §4>(…)` in that same function body.

  Every other reference fails: an export or re-export, a return, an argument, an assignment, a destructuring, a
  property value, a spread, or a capture by any nested function. Like G2, G4 lists what is allowed, never what is
  forbidden, and it reads references as written. A static import of the reader factory by any other module is already
  a G1 failure, because §3 gives that edge to `collect.mjs` alone.

**What G1, G3 and G4 establish together — statically.** `collect.mjs` is the sole intended consumer of the reader
factory and the surface it returns:
- §3 gives the only edge into `index.mjs` to `collect.mjs`, and no transport module imports `index.mjs` (G1);
- the reader modules are imported by `index.mjs` alone, and the primitive by the reader modules alone (G1);
- `index.mjs` exports `createReaders` and nothing else (G3);
- inside `collect`, the readers binding has only the uses of §6 (G4).

That holds for the statically resolvable graph and for references as written. It is not a claim about non-static
acquisition (§10).

## 9. Fixtures

| # | Fixture | Required result |
|---|---|---|
| P1 | the full graph of §3 | passes |
| P2 | a binder reading properties of the PR identity value it was given | passes — reading a value is not reading GitHub |
| P3 | `primitive.mjs` importing `node:child_process` | passes |
| P4 | `decision/**` importing `contract/**` | passes |
| P5 | the entry shim importing `v2/cli.mjs` | passes |
| P6 | `collect` calling `readers.readCommitRollup(sha)` and `readers.readPrKey(n)` in its own body, inside `Promise.all` | passes |
| P7 | `readCandidateRuns` returning each run's head SHA, `status`, `conclusion` and `run_attempt` | passes — run data, not a pull request's lifecycle (§4) |
| N1 | a binder importing `node:child_process`, `node:https`, `node:http2`, `node:net`, `node:tls`, `node:vm`, `node:module` or `node:worker_threads` | G1 fails |
| N2 | an npm package imported anywhere in `v2/`, or a network built-in in a transport file other than `primitive.mjs` | G1 fails |
| N3 | `collect.mjs` importing `primitive.mjs` directly; a binder importing the transport entry | G1 fails |
| N4 | `decision/**` importing `adapter/index.mjs` or anything under `adapter/` | G1 fails |
| N5 | any `v2/` module importing `scripts/eng/github-facts.mjs` | G1 fails |
| N6 | a dynamic `import("node:https")`, with a string-literal specifier, in any `v2/` module | G1 fails — a statically resolvable edge that is not in §3 |
| N7 | a free reference to `fetch`, `process`, `globalThis`, `require`, `eval`, `Function` or `Reflect` in any `v2/` module | G2 fails, because none is on the allowlist |
| N8 | `[].constructor.constructor` | G2 fails |
| N9 | a new or renamed reader, a changed query or route, or a changed output schema, without a golden and record amendment | G3 fails |
| N10 | a runtime module outside `v2/`, other than the shim, statically importing any `v2/` module | G1 fails |
| N11 | `index.mjs`, or any module outside the transport package, importing or re-exporting `primitive.mjs` | G1 fails |
| N12 | `collect.mjs` re-exporting `createReaders`, or `adapter/index.mjs` re-exporting it again for `cli.mjs` | G4 and G3 fail |
| N13 | `collect` returning the readers, passing them to a binder, or storing them in a property | G4 fails |
| N14 | a nested function in `collect.mjs` capturing the readers binding (`(sha) => readers.readCandidateRuns(sha)` handed onward) | G4 fails |
| N15 | destructuring a reader out of the binding (`const { readPrKey } = readers`) | G4 fails |
| N16 | any reader other than `readPrKey` returning a pull request's draft flag, state, head, base or their repositories | G3 fails (frozen output schema) |
| N17 | a reader module importing `index.mjs` or another reader module, or any transport module importing `createReaders` | G1 fails — §3 gives the edge into `index.mjs` to `collect.mjs` alone |
| R1 | a runtime-computed or reflective property path that reaches the `Function` constructor | **not rejected** — outside G2's static claim |
| R2 | a computed `import()` in a `v2/` module; or a runtime module outside `v2/` reaching a `v2/` module through `require()`, `createRequire()`, a computed `import()`, a worker or a forked process | **not rejected** — outside G1's static claim |

Every P fixture must pass and every N fixture must fail. An R fixture records what is **not** rejected: it is part of
the accepted residual (§10), documented as undetected and never claimed as covered. R1 and R2 are examples, not an
inventory — the residual is whatever the guards do not claim, not a list.

## 10. The accepted residual (recorded exactly)

> Static source guards do not prevent trusted same-process code from obtaining network capability through non-static
> loaders, runtime APIs, reflection or similar mechanisms. Because the repository is public, anonymous GitHub reads may
> also remain possible independent of controller credentials. This is accepted for the present advisory authority
> level.

Trusted code executing in the same process — the **controller**, meaning the process that runs V2 — may be capable of
bypassing static module rules using:
- **non-static loaders** — `require()`, `createRequire()` or a computed `import()` (fixture R2);
- **runtime-provided APIs** — Node `v20.20.2` exposes `fetch` and `process.getBuiltinModule` as globals;
- **reflection** — for example a runtime-computed property path to the `Function` constructor (fixture R1);
- **other same-process capabilities** — for example a worker or a forked process (fixture R2).

**Not a sandbox.** The static guards exist to catch **accidental** architectural drift along statically resolvable
paths. They are **not** a hostile-code sandbox, and nothing in this record may describe them as stronger than that.

**No credential exclusivity.** Hone is a public repository. With no credential at all, REST reads of the pull request,
its workflow runs, a compare, a file at a commit, commit statuses, check runs, reviews, comments and a run's artifact
list all return `200` (Appendix). Credential isolation alone therefore does not establish exclusive read authority.

**Whose credential.** The primitive inherits the `gh` session of whoever runs V2 (§4). At authoring, the operator's
session carries the `repo`, `workflow`, `gist` and `read:org` scopes, write scopes among them (Appendix). Nothing in
this record limits what same-process code could do with a credential it reaches. §11 governs this.

**Read-only is a credential property, not a G3 guarantee.** §4 declares every V1 reader a read, and G3 statically
freezes that declared surface: reader names, GraphQL documents or REST route templates, parameter types, output schemas
and export surfaces. That is architectural lint against accidental drift. It does **not** prove that a reader stays
read-only over HTTP at run time, because G3 freezes neither the HTTP method nor the primitive's `gh api` invocation.
Before its first live collection, 05A uses the separate read-only GitHub credential already decided (§11). A reader
changed into a write would therefore fail at that credential's permission boundary; G3 does not guarantee it.

**Accepted only at the advisory level.** This residual is accepted only while:
- ENG-LOOP is advisory and observation-oriented;
- humans keep production merge authority;
- the problem being solved is accidental drift, not hostile code running inside the trusted controller process.

**What correctness assumes.** Goal A's laws do not assume the guards are a sandbox (§1). They do assume the trusted V2
code follows this architecture. A departure by non-static means would go undetected, and that is part of what is
accepted here.

Evidence for the residual and for the guards' limits (Appendix): Node's globals; `createRequire()` and a computed
`import()` both loading a module; today's lint configuration raising **no** message for six ambient routes in a `v2/`
path; and the repository's FIN-01A lint block, which already calls lint confinement "a coding constraint, not a proof".

## 11. Upgrade trigger

A stronger isolation architecture **MUST** be revisited before any of:
- autonomous production merge;
- authoritative control-plane mutation;
- unrestricted credential-bearing actions;
- running untrusted code with controller credentials;
- ENG-LOOP gaining write authority;
- controller holding write-scoped credentials;
- any decision whose correctness requires exclusive raw-read authority.

At that point credential isolation, process isolation and network isolation are compared as a **separate, explicit
architecture decision**. Today's residual is **never silently inherited**: a proposal for any of the above that does
not first settle isolation is incomplete by this record.

**At authoring.** V2 does not run yet. Its primitive will inherit the `gh` session of whoever runs it (§4). The
operator's session at authoring carries write scopes (§10), and a controller running under it would hold write-scoped
credentials — a condition listed above.

**Operator decision, 2026-10-06.** 05A will not run under that session. Before its first live GitHub collection it
uses a separate read-only GitHub credential suited to the frozen reader set of §4. The 05A work derives and documents
that credential's minimum permissions from the exact GitHub operations it uses; none are guessed here. The
write-scoped session stays for human and operator work. The threat model above is unchanged.

## 12. Re-entry order

Strictly in this order. Each re-entry **removes** enforcement this record supersedes; none stacks a second mechanism on
top.

1. **CAP-01** (this record) merges.
2. **#803 (PR-SNAPSHOT-01) by removal.** Remove its field- and query-denylist guard model — the guard of its §9 and
   its fixture 15 — and depend on this record for architectural lint. Preserve the `PrSnapshotKey` correctness law.
   Its open P2 `4195119994` resolves by construction: no field list remains to be incomplete.
3. **#802 (CI-ATTEST-01) by removal.** Remove its independent re-read of the pull request and consume `PrSnapshotKey`.
   Preserve the immutable run-side attestation.
4. **#800 (ARCH-01) by removal.** Replace its module-boundary table and its 05A/05B guard-test text with a pointer to
   this record, and consume PR-SNAPSHOT-01 and CI-ATTEST-01. Preserve the evidence boundary and the pure decision core.
5. The minimal `ci.yml` attestation implementation.
6. 05A.
7. 05B.

ARCH-02 remains later.

## 13. Review budget

One legitimate semantic repair round is allowed. A second fresh, legitimate semantic P0–P2 in the **same** family →
**stop**: no further patch, and a return to architecture discussion.

Families: the dependency graph; the transport and its readers; the enforcement guards; the residual and the isolation
trigger.

Pure prose, formatting or non-normative feedback does not consume the budget.

**Round 1** (Codex review of `3e242b78cc`), one finding in each of two families, repaired at `4c4c4d979a`:
- **enforcement guards** — P1 `4196347828`. Module edges alone let the readers escape as a value across allowed edges:
  `collect` re-exports them, the adapter entry re-exports them again, and the CLI calls them. Repaired: §6 confines the
  readers to `collect`'s body; G4 allowlists their only uses; G3 freezes every cross-package export surface; fixtures
  N12–N15 and P6 cover it.
- **transport and its readers** — P2 `4196347838`. `readReviewEvidence` returned the draft flag, a second reader of PR
  lifecycle. Repaired: the draft flag moved into `readPrKey`'s single request; fixture N16 covers it.

**Round 2** (Codex review of `4c4c4d979a`): two more **enforcement guards** findings. The stop law fired, and no
repair round followed:
- P1 `4196433637`. A runtime module outside `v2/` can load `primitive.mjs` through `require()` or `createRequire()`;
  G1 has no edge to check, and G2 does not scan that caller.
- P2 `4196433639`. §3's broad transport-to-transport edge let another transport module import `createReaders`; G1
  passed it, and G4 inspects only `collect.mjs`.

**Post-stop narrowing — an operator decision, not a repair round.** The operator accepted the V1 invariant of §1 —
Goals A and B now, not Goal C — and directed this record narrowed, with no guard added:
- G1 is static module-edge lint only. It no longer claims to exclude non-static loaders. CommonJS loading is **not**
  blocked; it is part of the accepted residual (§10, fixture R2). The earlier blanket ban on dynamic `import()` in
  `v2/` goes with that claim: a string-literal `import()` is an edge G1 checks (fixture N6), and a computed one is
  residual (fixture R2).
- The broad transport-to-transport edge is removed. The graph itself now makes `collect.mjs` the only module that may
  import the reader factory: primitive → reader modules → `index.mjs` → `collect.mjs` (§3, fixture N17). No new guard
  and no capability-flow parser was added.

**Post-merge clarification — wording only, by operator decision.** Codex's review of `e5395dc044`, the one that
marking the PR ready triggered (review `5430905644`, P1), found that G3 freezes neither the HTTP method nor the
`gh api` invocation. §10's "fixed reads (§4, G3)" therefore claimed more than G3 checks. The claim was narrowed in §8
(G3), §10 and §11. No guard, AST rule or method denylist was added, and the security claim was not expanded.

If a fresh review finds that this record still overclaims its enforcement, **stop**: no further static escape detector
is added.

## 14. Non-goals

This record adds no runtime code, guard implementation, `ci.yml` change, 05A, 05B or ARCH-02. It adds no denylist of
GraphQL fields, REST endpoints, identifier names or loaders, and it makes no claim of hostile-code containment. It adds
no process, network or credential isolation at the current authority level; §11 says when that is decided.

## 15. Amendment CAP-01-READER-STATE-01 — candidate-run execution state

| | |
|---|---|
| **Decision** | `readCandidateRuns` returns each candidate run's mutable execution state — `status`, `conclusion` and `run_attempt` — together with its candidate metadata, from one complete response to a single request; a listing that cannot fit one response fails closed (§4). |
| **Date** | 2026-10-06 |
| **Decided by** | Sam (operator), after Codex's ready-triggered review of PR #802 found the gap (P1 `4200685968`). |
| **Why** | `readCandidateRuns` was frozen to immutable run metadata only, and no reader returned a workflow run's current state. The CI binding record (CI-ATTEST-01) needs the state of the one run that governs CI, and ARCH-01's run rule needed the same, so neither could be implemented under this record. |
| **Not added** | No new reader, GitHub client, transport capability or network authority, and no edge in §3. No timestamp, recency field, run-id ordering, second run ordering or cross-run `run_attempt` logic. No CI-specific re-read. |

**Why one reader, not a second `readRunState`.** The response `readCandidateRuns` already receives carries every
run's state, so each pass obtains candidate metadata and execution state from one complete GitHub API response. A
second reader would add a second, competing read of the same mutable fact, and a second CI reader, without any
capability the first lacks. No concrete reason requires one.

**Why `run_attempt` as well.** It is a run's third mutable field. The CI binding record bounds an attestation's recorded
attempt by the run's current `run_attempt`, within that one run; without it, that frozen check has no reader. It never
orders runs.

**Ownership — no overlap.**

| Owner | Owns |
|---|---|
| CAP-01 | which GitHub readers exist, their normalized output shapes, and the static capability graph |
| CI-ATTEST-01 | selecting the run that governs CI (its frontier), immutable attestation validation, and which selected run's state governs |
| ARCH-01 | the bounded full re-read and evidence consistency; normalized CI decision semantics |
| 05B | decisions over normalized facts only |

**Review budget.** This amendment gets one exact-head review round. A legitimate semantic problem with the reader's
ownership or mutability model may be repaired once. A second P0–P2 in the same family → **stop**, with no patch loop.

**Spent.** Codex's review of `89a24199d6` raised P2 `4201214343`: a paginated listing is several requests, not one
read, so a run can be dropped or duplicated between pages. By operator decision, the one repair is the single-response
listing law (§4), which removes paging instead of reconciling it. A further P0–P2 in the candidate-listing or
reader-state family → **stop**.

---

## Appendix — evidence (2026-10-06, read only)

| Probe | Result |
|---|---|
| `node --version`; `typeof fetch`; `typeof process.getBuiltinModule` | `v20.20.2`; `function`; `function` |
| Node `v20.20.2`: `createRequire(…)` of an `.mjs` module, and `import()` with a runtime-computed specifier | both load the module (scratch probe outside the repository) |
| ESLint on stdin as `scripts/eng/v2/adapter/internal/bind/probe.mjs`, holding `fetch(…)`, `globalThis.fetch(…)`, `process.getBuiltinModule("node:child_process")`, `import("node:https")`, `[].constructor.constructor` and a computed-key `Function` chain | **0** messages under today's configuration; no file was written |
| `tests/app/finance/financials-truth.test.ts` | its compiler-backed scanner documents that CommonJS `require` produces no dependency site |
| `scripts/eng/github-facts.mjs` (CP-005a) | uses `execFileSync("gh", …)` from `node:child_process` **and** the global `fetch` |
| `eslint.config.mjs`, FIN-01A block | "a CODING CONSTRAINT on the code FIN owns, not a proof"; lists `import("node:module")` and `globalThis.process.getBuiltinModule(...)` as forms its rules do not reject |
| Anonymous REST against this repository, no credential | `200` for the pull request, its workflow runs by head SHA, a compare, a file's contents at a commit, the combined status, check runs, reviews, issue comments, review comments and a run's artifact list; `401` for the artifact zip; `403` for GraphQL; an anonymous limit of 60 requests per hour |
| `gh auth status` on the authoring host | token scopes `gist`, `read:org`, `repo`, `workflow` |
| REST `workflow-run` schema (OpenAPI), for §15 | `status` and `conclusion` are required, nullable strings; `run_attempt` is an optional integer; `run_number` is a required integer. The workflow-runs list returns them for every run, in one response. |
| PR #802, ready-triggered review `5434850896`, for §15 | P1 `4200685968`: no reader exposed the governing run's current `status` or `conclusion` |
| All 2,829 `ci.yml` runs (workflow `289443461`), for §4's listing law | no head SHA has more than two `pull_request` runs |
