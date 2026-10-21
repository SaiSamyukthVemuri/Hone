# Hone — Current Production State

**Canonical snapshot of what Hone is today.** This document is deliberately concise. It is
not a PR diary — per-capability evidence lives in
[capability-register.md](./capability-register.md), migration facts in
[migration-ledger.md](./migration-ledger.md), residual gaps in
[known-limitations.md](./known-limitations.md), and dated chronology in
[../14_AI_HANDOFF.md](../14_AI_HANDOFF.md).

> **No capability is described as "live" merely because a table, migration, component,
> route or flag exists.** Read the status words precisely — *designed*, *implemented*,
> *merged*, *DB applied*, *deployed*, *enabled*, *production exercised*, *human accepted*,
> *dormant*, *held*, *deferred*, *retired* are distinct, and a capability normally holds several
> at once. **Retired is terminal** — not a later phase, not a gate someone can grant.

> **This document records a dated source/runtime baseline, not live telemetry.**
> Documentation-only commits may move the branch HEAD above a runtime-bearing SHA without changing
> product behavior; runtime-bearing merges move the baseline. Every production count/health/provider
> observation keeps its own measurement date and is not refreshed merely because source advanced.

---

## Reconciliation header

| Field | Value |
|---|---|
| **Reconciliation date** | **2026-10-21T08:11Z source sync** after #992 record, #990 bulk reschedule discovery, #993 queued-SMS refresh and #991 active-practitioner hours. Production-data measurements retain their original dates. |
| **Production branch** | `claude/build-hone-saas-hOex7` |
| **Current Git branch HEAD at this sync** | **`59ff87cd81ba7a6da78df44c7cca432b081a5ab7` — merge of #991**, following #993 `c216f015`, #990 `15086921` and docs-only #992 `fd53b97a`. This is a dated source sync. |
| **Last runtime-bearing application HEAD at this sync** | **`59ff87cd81ba7a6da78df44c7cca432b081a5ab7` (#991).** Week/month hours compare active practitioners’ effective schedules; inactive historical rows cannot create Hours vary. #993 refreshes current queued SMS recipient/consent/STOP/switch and appointment identity/status before the existing gate; this is not atomic post-refresh revocation or generation. #990 uses bounded bulk next-reschedule discovery without changing submission/authorization. Earlier repairs remain. No SQL, hosted apply, provider/model activation, grants or customer-data correction. Human acceptance is UNRUN. |
| **Current Vercel Production deployment evidence** | **#991 deployed as `dpl_2AosQMUbaE4tHaZmfZugin8UM1v5`, READY; current `hone.care` alias independently resolved to that deployment.** Exact-SHA inspection and expected/actual merged-tree equality verified it. Safe GET home/login200 and unauthenticated clients/dashboard307login passed. Exact source `5add5950` review and CI [39560681464](https://github.com/SaiSamyukthVemuri/Hone/actions/runs/39560681464) passed21,536unit and245browser/9skipped; DB/payment/mobile/Google/canonical-docs skipped. Automatic39565859627 remains in progress at this sync, not claimed passed. Prior automatic A3/A5 failures remain recorded below. No live booking/send or human acceptance. |
| **Migration state** | **This document deliberately states no migration number.** Hosted max is declared once, machine-readably, in [`migration-state.json`](./migration-state.json). Repository max, total applied and the next free number are **derived** — run `npm run migration:state`. The current reconciled position, with checksums and apply evidence, is [migration-ledger.md](./migration-ledger.md) under *Current state*. A number copied into this table is a number that goes stale on the next apply; that is how the `0160`/`0163`/`0165` divergence happened. |
| **Database vs. application skew** | **This document asserts no parity, pending or remote-only claim of its own.** It previously declared the two states equal and the pending set empty, and went stale the moment a reviewed migration was authored above hosted — the same second-copy failure this table already avoids for migration NUMBERS. Derive the relationship with `npm run migration:state`; hosted state is declared once in [`migration-state.json`](./migration-state.json); the reconciled position with apply evidence is [migration-ledger.md](./migration-ledger.md) under *Current state*. **A repository maximum ABOVE hosted is the normal state of an authorized migration-first apply** — reviewed migration authored, production not yet advanced — and is not by itself skew. What would be skew is a **remote-only** migration (hosted above repo), which the derivation reports and the canonical guard forbids. |
| **Production Supabase project** | The single production project. Always re-read the linked ref from `supabase/.temp/project-ref` (gitignored) and verify with `supabase migration list --linked` before trusting any number here. **No credentials are recorded in documentation.** (The project ref itself appears in at least one older repo document, so treat it as an operational identifier rather than a secret — but do not add new copies of it.) |
| **Health** | **Read-only route smoke after #991 READY:** home/login200; unauthenticated clients/dashboard307login. No production database faults, authenticated clinical/photo/operator behavior, production logs, tenant/provider/table counts or ops alerts were re-measured. Human acceptance is UNRUN. |
| **Tenant posture** | **Six studios in three classes — one real-customer, one controlled test, one synthetic, three empty.** Real-customer activity is **Willow Electrolysis only**. See **§0**, which is the canonical tenant register; do not restate its counts elsewhere. ⚠️ **Every tenant count in §0 was measured 2026-08-23 and was NOT re-measured on 2026-08-26** — see *What this reconciliation did and did not measure* below. |
| **Next operational gate** | HON-18 tonight-only bounded audit stabilization: release each independently qualified repair, preserving specific schema/provider/model/consent/customer-data holds. New-studio feature expansion is deferred. Scoped synthetic admin acceptance is now executed: six document/RSC cases passed on isolated loan5106, including same-session authority revocation. This is not production/human acceptance or a guarantee covering all revocation timing. Two DoneCharting keyboard cases passed on loan1de4. Chloe acceptance remains UNRUN; use existing authorized identities and synthetic fixtures only. No real-client portrait consent or production photo binding is inferred. |



### Re-derived at this reconciliation

- **#991:** exact `5add5950` review/CI39560681464 passed21,536unit/245browser9skip; DB/payment/mobile/Google/docs skipped. Normal `59ff87cd` READY `dpl_2AosQMUbaE4tHaZmfZugin8UM1v5`, current alias/tree verified, safe GET200/200/307/307. Automatic39565859627 remains in progress at this sync. Display only; no settings/customer mutation or human acceptance.
- **#993:** exact `449d9612` review/CI39561243850 passed21,529unit/94browser; DB/payment/mobile/Google/docs skipped. Normal `c216f015` READY `dpl_HpeExFhfTimou5jxjqpsXDsZHrLX`, alias at verification/tree matched, safe GET200/200/307/307. Automatic39563611013 failed only A3/A5 stale dd6 pins:21,527unit passed/2failed; three targeted browsers/aggregate passed, other suites skipped. Original failure retained. Refresh is not a generation/atomic revocation fence.
- **#990:** exact `575ec809` review/CI39557482836 passed21,522unit/56browser; DB/payment/mobile/Google/docs skipped. Normal `15086921` READY `dpl_E2PWDZUjTaifiUik78ATADspATwp`, alias at verification/tree matched, safe GET200/200/307/307 plus invalid reschedule capability200. Automatic39559733510 failed only A3/A5 stale dd6 pins:21,520unit passed/2failed; three targeted browsers/aggregate passed, other suites skipped. No valid capability submitted or appointment moved.
- **#992:** docs-only exact `00faf5a0` review/CI39558439382 and122 focused/prepush checks passed. Normal `fd53b97a` READY `dpl_EN1M5FhHTQCq657V8qLrVLidyQ1w`; exact inspection establishes that dated artifact, not the current alias. Automatic39559334570 passed changed-path/canonical-record/aggregate; unit/DB/browser/payment/mobile/Google skipped. No runtime or SQL change.

- **#989:** exact `625048ee` review/CI39554673956 passed21,502unit/73browser, DB/payment/mobile/Google/docs skipped. Normal `dd6be03d` READY `dpl_7JMSy2i5pRT9uJ3JNpCzLfYao35A`, actual `hone.care` alias, merged tree `820aebfc` matched, safe GET200/200/307/307. Automatic39556678694 failed only A3/A5 stale7e pins:21,510passed/2failed; three targeted browser shards/aggregate passed, other suites skipped. No live booking/email/SMS drill or Chloe acceptance.
- **#988:** exact `43731a18` review/CI39554672375 passed21,506unit/73browser; DB/payment/mobile/Google/docs skipped. Normal `7b75d43b` READY `dpl_DSVcsznkorh2PJqbtbhAG2uNb3V2`, production aliases, merged tree `2be37b5e` matched and safe GET200/200/307/307. Automatic39556224179 CANCELLED: changed-path passed, unit/three targeted browser jobs cancelled before settled results, aggregate failed cancellation; other suites skipped. Captured-row traversal is not a transactional snapshot.
- **#987:** docs-only exact `3b47a7f1` review/CI39555122816 passed;122 canonical checks/pre-push passed before the one-line table-format correction. Normal `555487f3` READY `dpl_BCWrscbto8UWke6j8u88HhyyPPJC` exact deployment; custom alias was not asserted from that snapshot. Automatic39555909650 passed changed-path/canonical-record/aggregate, other suites skipped. No runtime/SQL change. Old review finding/thread retained, source corrected.
- **Later-settled #985 automatic evidence:**39553235101 failed only A3/A5 stale d379 pins:21,494unit passed/2failed; four browser shards/aggregate passed; DB/payment/mobile/Google/docs skipped. This supersedes the earlier in-progress observation without relabeling failure.
- **Scoped acceptance supersedes earlier UNRUN:** synthetic loan5106 admin6PASS and loan1de4 DoneCharting keyboard2PASS desktop/phone simulation, no retries/skips/failures. Both normal END receipts preserve236 migration fingerprints, five backups, three volumes and shared135tables/214rows/head0223. Production runtime/source equivalence is scoped; physical phone, firmware and Chloe UAT remain UNRUN. No clinical/provider/customer action was activated.


- **#985:** exact `b6198271` review/CI39551237825 passed21,456unit/603browser13skip, DB/payment/mobile/Google/docs skipped. Normal `7e801043` READY `dpl_92zTfobxi8kuQkRMWBwahf9hDiV6`, validated merged tree `5dc54e43` and safe GET200/200/307/307. Automatic39553235101 IN PROGRESS at source sync. Fake tests cover committed cancellation plus email/alert/console failure; no live cancellation/email drill or human acceptance.
- **#982:** exact `2a77364e` review/CI39549149496 passed21,449unit/602browser11skip/one flaky/payment56; DB/mobile/Google/docs skipped. Normal `38f5d449` READY `dpl_8cCrCu79nuWsEoq5oPNgghh4jYqG`, merged tree `04841dba` matched, safe GET200/200/307/307. Automatic39551566698 failed only A3/A5 stale d379 pins:21,470unit passed/2failed; four browser shards/payment/aggregate passed, DB/mobile/Google/docs skipped. Original failure retained; no live financial operation.
- **#979:** exact `c931c484` review/CI39545279967 passed21,408unit/602browser13skip/one flaky/payment58; DB/mobile/Google/docs skipped. Normal `7dc0088f` READY `dpl_EivDYhHwnyKVUzR7jS4BZBjzHLq8`, merged tree `8a3c3673` matched and safe GET200/200/307/307. Automatic39550317376 CANCELLED after actual unit A3/A5 stale d379 failures (21,430passed/2failed); shards1/2 and payment passed, shards3/4 cancelled, aggregate failed. Separate guarded synthetic proof: real-storage held-refresh photo1PASS, admin6PASS at exact loan5106; not production/physical/Chloe acceptance. At that earlier #979 receipt, DoneCharting mounted keyboard proof was still running. The later loan1de4 END supersedes that UNRUN status with two scoped desktop/phone keyboard passes, recorded above.
- **#986:** docs-only exact `027e64f1` review/CI39548829979 passed122 focused checks; normal `8c17d66c` READY `dpl_4ZPApmexbFBRh6YpJ9tW7eubeyXm`. Automatic39549237700 passed changed-path/canonical-record/aggregate, unit/DB/browser/payment/mobile/Google skipped. No runtime/SQL change; historical failures preserved.


- **#981:** exact source `f5df9e40` review and CI39544767841 passed21,409unit/3,616DB8skip/603browser11skip/payment56/mobile6/Google13; canonical-docs skipped. Normal `d379d747` READY `dpl_6QXo4qjvHoPxY9qXSRuEhn1TUw9a`; merge tree `7808e3c7` matched the validated candidate, safe GET200/200/307/307. Automatic39546691933 failed only A3/A5 stale7c pins (21,407passed/2failed); other selected jobs and aggregate passed, canonical-docs skipped. The original pagination review finding was addressed with an immutable cursor and meaningful concurrent-mutation tests; its thread is retained. Chloe read-only Clients/Search/Archived/Dashboard acceptance is UNRUN.
- **#983:** exact docs source `f87ca5bd`, review and CI39544951310 passed;122 focused/pre-push checks passed. Normal `072183e4` READY `dpl_DaeFVg6hXNxtsuusEKAEzwQ9YPrN`, safe GET passed. Automatic39545567850 passed changed-path/canonical-record/aggregate; unit/DB/browser shards/payment/mobile/Google skipped. Prior failures were preserved and no runtime/SQL changed.

- **#977:** exact source2b9ad90c review/CI39539227391 passed; normal7c724bd4 READYdpl_GVoyohDJz2yWtf9EZ7jeUv368d3y/safeGET200/200/307/307. Automatic39541835155 failed only A3/A5 stale4c pins,21,383passed/2failed;603browser11skip/payment56/aggregate passed; DB/mobile/Google/docs skipped. No live webhook replay or provider activation.
- **#978:** exactd8eeab98 review/CI39536466431 passed21,381unit/234browser4skip; DB/payment/mobile/Google/docs skipped. Normalb4b382ca READYdpl_Ece6CvZXisEpGD35xFeyLD58J4kM/safeGET. Automatic39540924444 CANCELLED; unit step actually failed A3/A5,21,379passed/2failed, browser shards cancelled/aggregate failed. Partial post-RPC containment, not atomic CLN002 closure.
- **#980:** docs-only sourceb31d9c95 exact review/CI39540149982 passed and122focused checks. Normalbfe81297; automatic39540773557 CANCELLED before canonical execution, aggregate failed on cancelled dependencies. No deployment proof claimed for this intermediate docs merge.

- **#975:** exact source884f6432/CI39533588304 and independent review passed;21,333unit/603browser11skip, DB/payment/mobile/Google/docs skipped. Normal4c42e777 READYdpl_FKPdHcX6ixfNut2kqMYPpFMxSmUP and six safe routes verified. Automatic39536257170 failed only A3/A5 at5a (21,373passed/2failed); browser603/11skip and aggregate passed. Bounded loader guards, not full revocation/RSC/UAT closure.
- **#974:** exactf1b9afd6 whole-map draft repair reviewed clean and CI39531753116 passed21,343unit/40browser; DB/payment/mobile/Google/docs skipped. Normal0b110f9f READYdpl_2qrsG8Tu5dqybt4daDeEKTZRtKMP, safe smoke passed. Automatic39535690771 CANCELLED; cancelled shards fail the required aggregate. CLN001/003 concurrency/schema repair remains separate.
- **#972:** exact20e92812 reviewed clean after payment-title coverage repair; CI39531931995 passed21,333unit/3,616DB8skip/603browser11skip/payment56/mobile6/Google13;docs skipped. Normal56b432f2 READYdpl_HKPbBqEt4vJxZShnEZFFeAFYXM42/safe smoke. Automatic39535339606 CANCELLED with required aggregate failure on cancelled shards.
- **#976:** exact2eb51e98 docs review and CI39533809067 passed/122local checks, normal2c2d12b8 READYdpl_DNw8vus7dp3PuDr7HgL8CNzPYcau. Automatic39535092010 overallCANCELLED; changed-path/canonical-record/aggregate passed and application suites skipped.
- **#973:** source `e516dd25` exact review and full source CI `39529156822` passed (21,302unit/3,616DB8skip/602browser11skip/payment56/mobile6/Google13;docs skipped). Exact expected normal-merge tree with current #971 was tested49PASS and matched actual merge `5a9aba77`. READY `dpl_9TqbJThAGjYZaR9tJe3mLdyywvm9`, production aliases, Next.js15.5.28 build log and safe GET200/200/307/307/no-code external-next307same-originlogin verified. Automatic push `39531883026` settled failed only A3/A5 stale-record pins (21,317 unit passed/2failed); other applicable jobs passed and canonical-docs skipped. No SQL or activation; Chloe UAT UNRUN.
- **#971:** source `ab53816f` exact clean review and CI `39527467022` passed21,315unit/601browser11skip; DB/payment/mobile/Google/docs skipped. Normal merge `fc3101a2`, READY `dpl_8CtWAnnZyh1FGT5JLtDMst5FGqJH`, safe GET200/200/307/307; no-code hostile-next callback remains on login. Automatic push `39529636512` failed only A3/A5 stale pins:21,313 passed/2 failed;603browser11skip and aggregate passed, DB/payment/mobile/Google/docs skipped. Failure preserved; no auth provider exchange or customer writes. Chloe UAT UNRUN.
- **#970:** docs-only source `9e04b9d9`, normal merge `cae869ac`, READY `dpl_Gi7czB765naZ89KXUe7DHpaPmwCi`; source CI `39524936560` and automatic production docs `39525407805` passed changed-path/canonical-record/aggregate, other suites skipped by plan. It preserved the failed #969 push.
- **#969:** source `a6b9e937` passed exact review, including the automatic mark-ready review, and CI `39520213382` (21,298 unit; browser603 passed/11 skipped; aggregate passed; DB/payment/mobile/Google/canonical-docs skipped). Owner101 focused/type/lint/committed prepush passed. Normal merge `10982f4a`, exact READY `dpl_4PHqJTBH5DjhUdrX8oHZatVcEZ99`, safe GET200/200/307/307. Automatic push `39523272195` failed only canonical A3/A5 stale pins (21,296 passed / 2 failed); all four browser shards and aggregate passed, DB/payment/mobile/Google/canonical-docs skipped by plan. The failure is preserved. Authenticated banner behavior and Chloe UAT UNRUN.
- **#968:** docs-only source `442d0410`, exact review/source CI `39514570204` clean, normal merge `73a6f577`, READY `dpl_5rsSNSUMhFzuCHUGjk6ydRxuu2mr`; automatic docs CI `39515352455` passed changed-path/canonical-record/aggregate. Unit/DB/browser shards/payment/mobile/Google skipped by docs-only plan. Prior #927 failure preserved.
- **#967:** docs-only source `6dd9ffc8` passed exact review and CI `39509240396`, merged normally as `751f3176`, READY `dpl_7vdpKZLdrrMtLmq4NFGXdnfCF9SZ`. Automatic docs push `39509683194` passed changed-path/canonical-record/local-stack aggregate; app/DB/browser/payment/mobile/Google skipped by plan. The prior #925 A3/A5 failure remains failed; all its browser jobs settled passed.
- **#927:** source `f719bbd6` passed exact review and CI `39509408424` (21,297 unit tests, browser603 passed/11 skipped; aggregate passed; DB/payment/mobile/Google/canonical-docs skipped). Normal merge `0dc7d5e4`, exact READY `dpl_GGz9PC8u7Pw33a5kh28qaXQieS5o`, safe GET200/200/307/307. Existing208 focused checks/type/lint retained unchanged-runtime scope from378; refreshed122 canonical checks and committed prepush passed. Automatic push `39511500257` failed only canonical A3/A5 stale pins (21,295 passed / 2 failed); all four browser shards and aggregate passed, DB/payment/mobile/Google/canonical-docs skipped. This failed result is not relabeled as a pass. Authenticated void-history and Chloe UAT are UNRUN; no record was voided.

- **#966:** docs-only source `1bcddf10` passed exact review and CI `39503733584`, merged normally as `1f6be8c674628cdb901e217cd0d8ded39f012601`, READY `dpl_5SHEk8nAxHwmQhihfUaQ2FNyRz2f`. Automatic docs push `39504411795` passed changed-path/canonical-record/local-stack aggregate; unit/DB/browser/payment/mobile/Google skipped by plan. It preserved #963’s failed automatic push rather than relabeling it.
- **#925:** source `fb8fa817` passed exact review and CI `39505158005` (21,278 unit; browser603 passed/11 skipped; aggregate passed; DB/payment/mobile/Google/canonical-docs skipped). Normal merge `aa905103`, exact READY `dpl_9M5oRiXvtMQxKRcjubt1FznJNLNL`, safe GET200/200/307/307. Owner113 focused tests, full typecheck/lint/committed prepush passed; prior Unicode24pass/1fail negative baseline retained. Automatic push `39507202447` remains in progress at this dated snapshot; its completed unit job failed only stale canonical A3/A5 (21,276 passed / 2 failed, 931 files passed / 1 failed). Browser/aggregate are not yet settled, DB/payment/mobile/Google/canonical-docs skipped by plan. The failed unit job remains failed. Authenticated ordering and Chloe UAT remain UNRUN.

- **#965:** docs-only source `74dd43b7` passed exact review and CI `39499502693`, merged normally as `00c14c90d4bd94e510b0e44c31f9f2b488e32722`, deployed READY as `dpl_8Aj4jqiwbyB3ufixibb7mgNZdd7w`. Automatic docs push `39500703706` passed changed-path/canonical-record/local-stack aggregate; unit/DB/browser shards/payment/mobile/Google skipped by plan. Prior #892 push failure remains recorded below.
- **#963:** source `512caa70` passed exact review and CI `39498227750`: 21,246 unit tests, browser603 passed/11 skipped and aggregate passed; DB/payment/mobile/Google/canonical-docs skipped. Normal merge `4425b8ef`, exact production READY `dpl_6thovCNMTccvUUjYNC4CG5pYYGmx`, safe GET smoke200/200/307/307. Automatic push `39501278868` failed only canonical A3/A5:21,244 passed/2 failed; all four browser shards/aggregate passed; DB/payment/mobile/Google/canonical-docs skipped. This failure remains failed. Scoped synthetic staging fault/log-viewer prerequisites and Chloe acceptance are UNRUN; no production fault injection or customer-data operation.

- **#964:** docs-only correction source `7959d181` passed exact review and CI `39491855174`, merged normally as `462b16b0fa4d2c531ee3c6bfb67fd2d52345cb54`, deployed READY as `dpl_9dGPqXy4XgMtF5Uw51qjMx1px7o1`. Automatic docs push `39493675623` passed changed-path/canonical-record/local-stack aggregate; unit/DB/browser shards/payment/mobile/Google were skipped by plan. It preserved #960 push `39488092317` as failed (21,213 passed / 2 canonical A3/A5 failures), not corrected into a pass.
- **#892:** source `bff48458` passed exact review and CI `39493795812` (21,232 unit; 3,616 DB passed / 8 skipped; 603 browser passed / 11 skipped; four shards and aggregate pass). Payment/mobile/Google/canonical-docs jobs were skipped. Merged normally at `e91ddd43`; exact production deployment `dpl_6cYfBqrxTAnFmbibkfBHZxUFqJSn` READY, safe GET smoke 200/200/307/307. Automatic push `39496755070` settled failed only canonical A3/A5 at the stale `af2f7423` pins:21,230 passed/2 failed (930 files passed/1 failed). DB, four extended browser shards and aggregate passed; payment/mobile/Google/canonical-docs jobs skipped by plan. The failed run remains failed; this source sync corrects the current pins. Authenticated phone/storage/physical camera and Chloe acceptance remain UNRUN; no portrait or Before/After release is claimed.

- **Preserved 2026-10-21T03:34Z deployment receipts (dated, not the current pin):** **#975 is deployed as `dpl_FKPdHcX6ixfNut2kqMYPpFMxSmUP`, READY, aliases `hone.care` and `www.hone.care`.** Exact-SHA production listing and same-URL inspection establish deployment. Safe GET home/login200 and unauthenticated clients/dashboard/admin/admin-ops-alerts307login passed. Source `884f6432` exact review and CI `39533588304` passed21,333unit and603browser/11skip; DB/payment/mobile/Google/docs skipped. Automatic push `39536257170` failed only canonical A3/A5 stale pins at5a:21,373unit passed/2failed; four browser shards149/153/155/146 (603passed/11skipped) and aggregate passed; DB/payment/mobile/Google/docs skipped. This correction preserves that failure. #974 source `f1b9afd6` exact review and CI `39531753116` passed21,343unit+40browser; other suites skipped, merged `0b110f9f`, READY `dpl_2qrsG8Tu5dqybt4daDeEKTZRtKMP`, safeGET200/200/307/307. Its push `39535690771` was CANCELLED; required shards cancelled and aggregate failed on cancellation, not a measured product-test failure. #972 source `20e92812` exact review and CI `39531931995` passed21,333unit/3,616DB8skip/603browser11skip/payment56/mobile6/Google13;docs skipped, merged `56b432f2`, READY `dpl_HKPbBqEt4vJxZShnEZFFeAFYXM42`, safeGET200/200/307/307. Its push `39535339606` was CANCELLED; dependent jobs cancelled and required aggregate failed. #976 docs source `2eb51e98` exact review and CI `39533809067` passed, merge `2c2d12b8` READY `dpl_DNw8vus7dp3PuDr7HgL8CNzPYcau`; automatic `39535092010` overall CANCELLED although changed-path/canonical-record/aggregate passed and application suites skipped. No cancelled run is relabeled passed. #973 remains READY with actual Next15.5.28 build evidence; its push `39531883026` settled failed only A3/A5 (21,317unit passed/2failed; other applicable jobs passed, docs skipped). Direct deployed Sharp-module inspection remains UNVERIFIED after404 File tree not found; immutable lock and installed native proof are distinct. #971 push `39529636512` remains failed only A3/A5,21,313unit passed/2failed and603browser/11skip. Earlier receipts remain below. No hosted/provider/customer action occurred.

- Verified the full merge ancestry back to `b9e0003f` (231 merges) using the first-parent production graph, with **202** after `bf6f09c4`, through `59ff87cd`. The prior #989 snapshot was227/198; #992, #990, #993 and #991 add four merges. The prior #985 snapshot was224/195; #987, #988 and #989 add three merges. The prior #981 snapshot was220/191; #986, #979, #982 and #985 add four merges. The prior #977 snapshot was218/189; #983 and #981 add two merges. The prior #975 snapshot was215/186; #980, #978 and #977 add three merges. The prior #973 snapshot was211/182; #976, #972, #974 and #975 add four merges. The prior #969 snapshot was208/179; #970, #971 and #973 add three merges. The prior `0dc7d5e4` snapshot had 206/177; docs-only #968 added one merge, and #969 added one runtime merge. #960 restores already-applied 0212 source, behavioral tests and original export dispositions; the deployed-path classifier treats the registry as runtime-bearing. No hosted history/schema/data or provider activation changed.
- At `59ff87cd`, source additionally includes #991 active-practitioner hours, #993 queued SMS refresh and #990 bulk discovery, plus #989 assigned-practitioner notification identity and #988 immutable calendar traversal, plus #985 truthful cancellation recovery, #982 pending PaymentIntent/provider binding and #979 photo/focus race repairs, plus #981 directory/metrics truth and #977 retry/privacy and #978 bounded chart-link containment, plus #975 admin loader guards, #974 typed intake validation, #972 verification gates, #973 patched Next.js/Sharp and #971 same-origin auth redirect; existing deployed behavior includes #969’s newest-non-void banner comparison and #927’s retained-void exclusions and #925’s consistent latest-treatment ordering and #963’s archive/unarchive audit and portal-client lookup diagnostic privacy. It includes #947’s fail-closed invitation completion behavior, #946’s truthful missing-currency label, #906’s consistent refunded appointment state/session quote prefill, #921’s server analytics event/value allowlist, #952’s behavior-preserving extraction of the original-range decoder, #953’s internal alert-email log-text suppression, #955’s browser analytics accessor/method hardening, #959’s client lookup diagnostic payload suppression, #957’s portal/manual-fee diagnostic text suppression, #961’s duplicate-email client-action diagnostic redaction, and #962’s non-duplicate client UPDATE diagnostic redaction; #960 also restores the original email-ledger export dispositions and already-applied 0212 source/coverage. #960 source `b4961561` merged as `af2f7423`, deployed READY as `dpl_B4VQ16BLn78ExLsAmFsQvmuKU4x1`. Source CI `39485452283` passed 21,215 unit tests, DB 3,614 passed / 8 skipped and 600 browser tests across four shards plus the aggregate; payment/mobile/Google/canonical-docs jobs were skipped by plan. Read-only smoke returned 200/200/307 for `/`, `/login`, and unauthenticated `/dashboard`. Automatic post-merge `39488092317` settled with only A3/A5 stale-record failures (21,213 passed / 2 failed); DB and all four browser shards plus the aggregate passed, and payment/mobile/Google/canonical-docs were skipped by plan. This is not relabeled as a pass.
- Previous #962 post-merge CI `39475024213` remains failed: 21,196 unit tests passed / 2 canonical A3/A5 failures (928 files passed / 1 failed). All four browser shards and aggregate passed; DB/payment/mobile/Google/canonical-docs skipped by plan. Its original deployment/smoke receipts remain recorded; this source reconciliation does not relabel that failure.
- The earlier #932 production CI [39337826311](https://github.com/SaiSamyukthVemuri/Hone/actions/runs/39337826311) remains **failed**, with 21,051 tests passing and two canonical-production-facts A3/A5 failures. #940 corrected that record; the failure is not relabeled or erased.
- **#903:** exact-head review and pre-merge CI passed. Deployment `dpl_FAqidkKkU2NwjRHAP6XCjbup9nVM` reached READY on production aliases. Its post-merge workflow was cancelled; the local-stack gate reported no runner assignment within 15 minutes. This is not a post-merge pass.
- **#897:** exact-head review and pre-merge CI passed (921 test files / 21,064 tests, four extended browser shards and local-stack browser). Deployment `dpl_2wF8fKo8eizco3emSNhNevp5RoYN` reached READY before #895 superseded it. Its post-merge required browser aggregate failed because all four extended shards were cancelled at hard timeout with zero reported test failures; this is not a pass.
- **#895:** exact-head review and required pre-merge CI passed (unit/typecheck/lint/build/safety, four extended browser shards and local-stack browser). Deployment `dpl_qowJkmtRmDWsDAWGZf4fJaT2etER` is READY at exact source `38d3f25c`. Read-only `/`, `/pricing` and `/privacy` GETs returned 200. This does not verify alert-email content or human acceptance.
- **#942:** exact-head review and pre-merge CI passed (unit/typecheck/lint/build/safety, three targeted browser shards and local-stack browser; DB/payment/mobile/Google/canonical-docs checks were skipped by the diff plan). Deployment `dpl_85ex4xgVzy6jgj7miXweJtSKubBG` was READY at exact source `0726dcff`; read-only `/`, `/pricing` and `/privacy` GETs returned 200. Post-merge CI [39351117285](https://github.com/SaiSamyukthVemuri/Hone/actions/runs/39351117285) was cancelled while browser shards ran; local-stack aggregation failed because shard results were absent. These checks do not prove portal issuance, log payload redaction, email delivery, or human acceptance.
- **#944:** exact-head review and pre-merge CI `39350706434` passed. Deployment `dpl_BN1WCVHdnhY9fs5g1x8qzzbXHYUp` is READY at exact source `c82d97e1`; read-only `/`, `/pricing` and `/privacy` GETs returned 200. Post-merge CI `39351724598` failed only canonical A3/A5 freshness checks for the stale pre-#944 record; those failures remain recorded. These checks do not prove callback-log payload redaction or human acceptance.
- **#945:** The preceding reconciliation records its exact-head review, pre-merge CI, deployment, smoke and the original stale-record CI failure at the time. #941 subsequently corrected that source record at `9a731aac`; its docs-only CI passed and it merged normally. The new #947 runtime merge then made that record stale again, as shown by the current #947 production push result above.
- **#947:** The preceding reconciliation records its exact-head review, pre-merge CI, deployment, smoke and stale-record push result at the time. It remains deployed at `fca724ab`; no migration or hosted-state change. Chloe’s isolated synthetic invitation acceptance remains pending.
- **#948:** Docs-only record refresh source `e2987e39ffdac08b24b7d5f965d56c62dd6a5b81` passed exact-head review and CI `39360204120`, then merged normally as `c264ed540258d5626e211339a5034ab41c186bda`. Production push CI `39360580504` passed its docs-only selected jobs; unit/DB/browser/payment/mobile/Google suites were skipped by plan. It changed no runtime, migration, hosted state or customer data.
- **#946:** Source `3b24ff55cbd92fc1d69fe60c1e2d8c892468f7e2` passed exact-head review and CI `39357088930` (unit/typecheck/lint/build/safety, four extended browser shards, payment browser and local-stack browser passed; DB/mobile/Google/canonical-docs were skipped by plan). It merged normally as `49640bd8cd06b65a5bc81e2493f9d04e5bb7df3d`; Vercel deployment `dpl_nrThv1JA8yGRuq6wvyGMVVuLaRut` is READY on production aliases at the exact source. Read-only `/login` returned 200 and unauthenticated `/admin/payments` returned 307 to `/login`; no authenticated feature-row or payment operation was performed. Post-merge workflow `39361843543` was cancelled after stale canonical A3/A5 failed and required browser shards were cancelled. #949 later refreshed the source record through #946. Chloe’s synthetic staging UAT remains pending; no migration or customer-data change.
- **#949:** Docs-only canonical record refresh source `ded62ef6817e983f5843fdc76da5dfcef6c93add` passed exact-head review and selected docs-only CI `39362577215`; production push CI `39362844385` also passed. It merged normally as `926f1ece18d0367b29fbe55e097f4b1ce876ee14`; Vercel deployment `dpl_DnCcFkgftq3cfxCscTonafNkqP1A` is READY at exact source. Read-only `/login` returned 200 and unauthenticated `/dashboard` returned 307 to `/login`. Non-doc suites were skipped by plan. No runtime, migration, hosted-state or customer-data change.
- **#906:** Source `afb4e1b38aff93e9fbf79e8d18def3ed6de93073` passed exact-head review and pre-merge CI `39363164120` (21,153 tests / 927 files, three targeted browser shards, fake-payment browser and local-stack aggregate; DB/mobile/Google/canonical-docs skipped by plan). It merged normally as `b049b7e1f2ec8c87eff722632ab33664bdfd8921`; Vercel deployment `dpl_EpUVuqDuCQKDaf8RBa2MkPnEmgkV` is READY at exact source. Read-only `/login` returned 200 and unauthenticated `/dashboard` returned 307 to `/login`; synthetic checkout UAT is prepared but not executed. Post-merge CI `39364247876` passed the three browser shards, fake-payment browser and local-stack aggregate; DB/mobile/Google/canonical-docs skipped by plan. Unit tests had 21,151 passes and two failures, both stale canonical A3/A5 facts at the then-current pin `49640bd8`; no feature test failed. No migration, live payment action or customer-data change.

**Not re-measured:** application workflows, database health, tenant counts, alerts, providers or human acceptance. The route smoke above is reachability only. Earlier dated measurements remain unchanged. Portrait and capture-stage grouping are not deployed; their independent release and activation holds remain. Vendor-side deletion remains a separate decision.

### Historical preceding baseline from the #928 reconciliation

<!-- canonical-facts:ignore-start reason=preserves-the-37b0ed82-record-as-dated-history -->
#### Prior reconciliation header

| Field | Value |
|---|---|
| **Reconciliation date** | **2026-10-19 UTC source sync** (CANON-REFRESH-2026-10-19c: documentation-only #935 and CI-only #928 after `78c1d640`). Application runtime remains `78c1d640`; production-data observations keep their original measurement dates. |
| **Production branch** | `claude/build-hone-saas-hOex7` |
| **Current Git branch HEAD at this sync** | **`37b0ed82e7827d2d07c5d65c2b7bcdab78326a2a` — merge of #928.** Its two-file first-parent diff is `.github/workflows/ci.yml` and `tests/ci/post-test-verification-steps.test.ts`, with no shipping application or migration file. This is a dated source sync, not a perpetual pointer. |
| **Last runtime-bearing application HEAD at this sync** | **`78c1d640b80d15080dd4ec68aaba48997e3daacf` (#907).** The own first-parent diff changes six files, four shipping files under `app/` and `lib/`, and no migration. The session page now loads and renders its visit’s ungrouped photo gallery. Portrait and capture-stage grouping remain separate, unmerged work. A3’s runtime residue is zero files at this pin. |
| **Current Vercel Production deployment evidence** | `37b0ed82` (#928, merged `2026-10-19T04:24:49Z` from `d32796fc3c59821341ecd91fe873c3b14a98c8bd`) has Vercel GitHub status **success**, updated `2026-10-19T04:26:38Z`, target `Fb6opkLfewSj2JNi9PWziGT6vo5i`. Existing authenticated Vercel CLI independently confirms exact `37b0ed82`, **Ready**, target **production**, aliases **hone.care** and `www.hone.care`. The preceding #935 record-only commit `9965580e` was independently confirmed through the existing Vercel CLI as Ready, production, hone.care alias, and automatic CI39198912242 passed **374 canonical checks**; validate/DB/payment/Google/mobile/browser-shard execution was skipped, not runtime proof. Automatic production CI39199339032 for #928 is still running at this sync; its final outcome is not asserted. #928 changes CI only; no new application behavior or human acceptance is claimed. |
| **Migration state** | **This document deliberately states no migration number.** Hosted max is declared once, machine-readably, in [`migration-state.json`](./migration-state.json). Repository max, total applied and the next free number are **derived** — run `npm run migration:state`. The current reconciled position, with checksums and apply evidence, is [migration-ledger.md](./migration-ledger.md) under *Current state*. A number copied into this table is a number that goes stale on the next apply; that is how the `0160`/`0163`/`0165` divergence happened. |
| **Database vs. application skew** | **This document asserts no parity, pending or remote-only claim of its own.** It previously declared the two states equal and the pending set empty, and went stale the moment a reviewed migration was authored above hosted — the same second-copy failure this table already avoids for migration NUMBERS. Derive the relationship with `npm run migration:state`; hosted state is declared once in [`migration-state.json`](./migration-state.json); the reconciled position with apply evidence is [migration-ledger.md](./migration-ledger.md) under *Current state*. **A repository maximum ABOVE hosted is the normal state of an authorized migration-first apply** — reviewed migration authored, production not yet advanced — and is not by itself skew. What would be skew is a **remote-only** migration (hosted above repo), which the derivation reports and the canonical guard forbids. |
| **Production Supabase project** | The single production project. Always re-read the linked ref from `supabase/.temp/project-ref` (gitignored) and verify with `supabase migration list --linked` before trusting any number here. **No credentials are recorded in documentation.** (The project ref itself appears in at least one older repo document, so treat it as an operational identifier rather than a secret — but do not add new copies of it.) |
| **Health** | **Status-code probe, 2026-10-17T17:05Z** (unauthenticated GET, redirects not followed): `hone.care` **200** · `/login` **200** · `/dashboard`, `/clients`, `/calendar` and `/api/health` **307 → /login**, all non-5xx. This is a reachability reading only. ⚠️ `ops_alerts` was **not** re-read at this sync. Earlier probes are preserved below as dated readings. These are dated observations, not current health. |
| **Tenant posture** | **Six studios in three classes — one real-customer, one controlled test, one synthetic, three empty.** Real-customer activity is **Willow Electrolysis only**. See **§0**, which is the canonical tenant register; do not restate its counts elsewhere. ⚠️ **Every tenant count in §0 was measured 2026-08-23 and was NOT re-measured on 2026-08-26** — see *What this reconciliation did and did not measure* below. |
| **Next operational gate** | The **deep production / security / code audit** (still not performed against this baseline). **Chloe's human acceptance testing** remains outstanding and is **independent** — see §15. |

#### Prior re-derived evidence

- Verified the full merge ancestry back to `b9e0003f` (169 merges), with **140** after `bf6f09c4`. #935 is record-only and #928 is CI/tests-only; the last runtime-bearing application SHA stays `78c1d640`.
- #928 changes no migration, customer data, studio flag or provider activation. No hosted declaration/history was changed; the separately observed hosted-history discrepancy remains an external read-only finding.
- #928 source head had clean exact-head review and green CI39195263987: 20,931 unit/static pass; 3,570 DB pass / eight skipped; 601 browser pass / eleven skipped; payment56, Google13 and mobile6 pass; canonical-only job skipped. These are pre-merge proofs, not production workflow or customer acceptance.

**Not re-measured:** application workflow, health, tenant counts, alerts, providers or human acceptance. #931 and #935 remain resolved. This follow-up updates branch-head freshness after the CI-only merge; it does not change the application runtime pin. Dependent releases remain held pending the new record’s review/checks and Sam’s authority.

<!-- canonical-facts:ignore-end -->

### Historical preceding baseline from the #907 reconciliation

<!-- canonical-facts:ignore-start reason=preserves-the-78c1d640-record-as-dated-history -->
#### Prior reconciliation header

| Field | Value |
|---|---|
| **Reconciliation date** | **2026-10-19 UTC source sync** (CANON-REFRESH-2026-10-19b, two merges after the preceding `34f4800a` record: documentation-only #931 and runtime-bearing #907). Production-data observations retain their own measurement dates. |
| **Production branch** | `claude/build-hone-saas-hOex7` |
| **Current Git branch HEAD at this sync** | **`78c1d640b80d15080dd4ec68aaba48997e3daacf` — Sam’s merge of #907.** This is a dated sync value; re-read GitHub before any production action. |
| **Last runtime-bearing application HEAD at this sync** | **`78c1d640b80d15080dd4ec68aaba48997e3daacf` (#907).** The own first-parent diff changes six files, four shipping files under `app/` and `lib/`, and no migration. The session page now loads and renders its visit’s ungrouped photo gallery. Portrait and capture-stage grouping remain separate, unmerged work. A3’s runtime residue is zero files at this pin. |
| **Current Vercel Production deployment evidence** | `78c1d640` (#907, merged by Sam `2026-10-19T03:19:52Z` from `ec6d4fea3da14b6dada8c88014104898f776629b`) has GitHub Vercel status **success**, updated `2026-10-19T03:21:56Z`. Installed Vercel CLI read-only inspection confirms **`dpl_Fv99Z9BctuYxg9UcdAMV2DhGatAc`**, **Ready**, target **production**, aliases **`hone.care`** and `www.hone.care`. The connector denied scope access; CLI inspection succeeded using its existing credentials. Production CI `39194178406` was still running at this sync; no final pass is asserted. Candidate CI `39194477523` validate failed only canonical A3/A5 against the preceding `34f4800a` record (24,405 passed, two failed). These historical failures remain failures. No live gallery workflow or customer acceptance was measured here. |
| **Migration state** | **This document deliberately states no migration number.** Hosted max is declared once, machine-readably, in [`migration-state.json`](./migration-state.json). Repository max, total applied and the next free number are **derived** — run `npm run migration:state`. The current reconciled position, with checksums and apply evidence, is [migration-ledger.md](./migration-ledger.md) under *Current state*. A number copied into this table is a number that goes stale on the next apply; that is how the `0160`/`0163`/`0165` divergence happened. |
| **Database vs. application skew** | **This document asserts no parity, pending or remote-only claim of its own.** It previously declared the two states equal and the pending set empty, and went stale the moment a reviewed migration was authored above hosted — the same second-copy failure this table already avoids for migration NUMBERS. Derive the relationship with `npm run migration:state`; hosted state is declared once in [`migration-state.json`](./migration-state.json); the reconciled position with apply evidence is [migration-ledger.md](./migration-ledger.md) under *Current state*. **A repository maximum ABOVE hosted is the normal state of an authorized migration-first apply** — reviewed migration authored, production not yet advanced — and is not by itself skew. What would be skew is a **remote-only** migration (hosted above repo), which the derivation reports and the canonical guard forbids. |
| **Production Supabase project** | The single production project. Always re-read the linked ref from `supabase/.temp/project-ref` (gitignored) and verify with `supabase migration list --linked` before trusting any number here. **No credentials are recorded in documentation.** (The project ref itself appears in at least one older repo document, so treat it as an operational identifier rather than a secret — but do not add new copies of it.) |
| **Health** | **Status-code probe, 2026-10-17T17:05Z** (unauthenticated GET, redirects not followed): `hone.care` **200** · `/login` **200** · `/dashboard`, `/clients`, `/calendar` and `/api/health` **307 → /login**, all non-5xx. This is a reachability reading only. ⚠️ `ops_alerts` was **not** re-read at this sync. Earlier probes are preserved below as dated readings. These are dated observations, not current health. |
| **Tenant posture** | **Six studios in three classes — one real-customer, one controlled test, one synthetic, three empty.** Real-customer activity is **Willow Electrolysis only**. See **§0**, which is the canonical tenant register; do not restate its counts elsewhere. ⚠️ **Every tenant count in §0 was measured 2026-08-23 and was NOT re-measured on 2026-08-26** — see *What this reconciliation did and did not measure* below. |
| **Next operational gate** | The **deep production / security / code audit** (still not performed against this baseline). **Chloe's human acceptance testing** remains outstanding and is **independent** — see §15. |

#### Prior re-derived evidence

- Verified production merge #907 and deployment status/target/aliases through GitHub and the existing Vercel CLI. No deployment was performed by OPS.
- Verified the full merge ancestry back to `b9e0003f` (167 merges), with **138** after `bf6f09c4`; #931 is documentation-only and #907 is runtime-bearing.
- #907 changes no migration. No hosted migration declaration/history, provider state, customer data or studio flag was changed. The previously observed hosted-history discrepancy remains an external read-only reconciliation finding.
- Exact source #907 had standalone local storage B3 **1/1 pass, zero failures/skips/retries**; its prior CI had 20,904 unit tests pass, 3,570 DB pass / eight skipped, and 601 browser pass / eleven skipped. These are pre-release proofs, not live acceptance.

**Not re-measured:** live gallery behavior, health, tenant counts, alerts, provider state or human acceptance. #931 at `e102d816` remains resolved; dependent releases await this new record repair’s review, applicable CI and Sam’s authorization.

<!-- canonical-facts:ignore-end -->

### Historical preceding baseline from the #929 reconciliation

<!-- canonical-facts:ignore-start reason=preserves-the-34f4800a-record-as-dated-history -->
#### Prior reconciliation header

| Field | Value |
|---|---|
| **Reconciliation date** | **2026-10-19 UTC source sync** (CANON-REFRESH-2026-10-19, 1 merge after the `f9cd9013` record, runtime-bearing; the earlier record was never merged before production moved and is preserved below as history). Earlier syncs are preserved below as history. Production-data counts elsewhere retain their own older measurement dates. |
| **Production branch** | `claude/build-hone-saas-hOex7` |
| **Current Git branch HEAD at this sync** | **`34f4800a4adda2c7efa4d2f6479a9543c175e840` — merge of #929.** Re-read GitHub before any production action; this is a dated sync value, not a perpetual pointer. |
| **Last runtime-bearing application HEAD at this sync** | **`34f4800a4adda2c7efa4d2f6479a9543c175e840` (#929).** Also the branch HEAD above. The merge’s own first-parent diff has 26 files, including 9 shipping files under `app/` and `lib/`, and no migration. `scripts/classify-changes.mjs`: `application=true`, `database=true`, `security=true`, `browser_core=true`, baseline T3 (DB test and security surfaces); this is runtime-bearing. The re-mint path uses an abortable signed-URL route and recovers image failures around hydration. With this pin A3’s runtime residue is zero files. |
| **Current Vercel Production deployment evidence** | `34f4800a` (#929, merged `2026-10-19T00:47:56Z` from head `7afdb443`) has Vercel commit status **success**, updated `2026-10-19T00:50:07Z`, target [Aoqji68MVSiqp3vTC9eLQme7pcTs](https://vercel.com/samyukthssv-4841s-projects/hone-z2uf/Aoqji68MVSiqp3vTC9eLQme7pcTs). Sam reports deployment completed; this sync read the GitHub status but did **not** independently read Vercel target/aliases or probe the live recovery workflow. Production push CI `39182395633`: changed-path detection, DB integration, all four extended browser shards and browser aggregator **passed**; docs-only, payment, Google and mobile lanes **skipped**, not executed. Validate **failed only** canonical-production-facts A3/A5 against the stale `6acea261` record. This docs refresh repairs that record; it does not retroactively turn the failed run green. |
| **Migration state** | **This document deliberately states no migration number.** Hosted max is declared once, machine-readably, in [`migration-state.json`](./migration-state.json). Repository max, total applied and the next free number are **derived** — run `npm run migration:state`. The current reconciled position, with checksums and apply evidence, is [migration-ledger.md](./migration-ledger.md) under *Current state*. A number copied into this table is a number that goes stale on the next apply; that is how the `0160`/`0163`/`0165` divergence happened. |
| **Database vs. application skew** | **This document asserts no parity, pending or remote-only claim of its own.** It previously declared the two states equal and the pending set empty, and went stale the moment a reviewed migration was authored above hosted — the same second-copy failure this table already avoids for migration NUMBERS. Derive the relationship with `npm run migration:state`; hosted state is declared once in [`migration-state.json`](./migration-state.json); the reconciled position with apply evidence is [migration-ledger.md](./migration-ledger.md) under *Current state*. **A repository maximum ABOVE hosted is the normal state of an authorized migration-first apply** — reviewed migration authored, production not yet advanced — and is not by itself skew. What would be skew is a **remote-only** migration (hosted above repo), which the derivation reports and the canonical guard forbids. |
| **Production Supabase project** | The single production project. Always re-read the linked ref from `supabase/.temp/project-ref` (gitignored) and verify with `supabase migration list --linked` before trusting any number here. **No credentials are recorded in documentation.** (The project ref itself appears in at least one older repo document, so treat it as an operational identifier rather than a secret — but do not add new copies of it.) |
| **Health** | **Status-code probe, 2026-10-17T17:05Z** (unauthenticated GET, redirects not followed): `hone.care` **200** · `/login` **200** · `/dashboard`, `/clients`, `/calendar` and `/api/health` **307 → /login**, all non-5xx. This is a reachability reading only. ⚠️ `ops_alerts` was **not** re-read at this sync. Earlier probes are preserved below as dated readings. These are dated observations, not current health. |
| **Tenant posture** | **Six studios in three classes — one real-customer, one controlled test, one synthetic, three empty.** Real-customer activity is **Willow Electrolysis only**. See **§0**, which is the canonical tenant register; do not restate its counts elsewhere. ⚠️ **Every tenant count in §0 was measured 2026-08-23 and was NOT re-measured on 2026-08-26** — see *What this reconciliation did and did not measure* below. |
| **Next operational gate** | The **deep production / security / code audit** (still not performed against this baseline). **Chloe's human acceptance testing** remains outstanding and is **independent** — see §15. |

#### Prior re-derived evidence

**Re-derived on 2026-10-19 (CANON-REFRESH-2026-10-19), from `34f4800a`:**

- The production branch head and the full merge ancestry back to `b9e0003f` (165 merges),
  from `git rev-list --first-parent --merges --count b9e0003f..34f4800a`;
  136 merges follow `bf6f09c4`.
- One merge since the prior unmerged record `f9cd9013`: #929 at `34f4800a`,
  classified over its own first-parent diff (26 files, 9 shipping, no migration).
- GitHub merge record, Vercel commit status and production CI `39182395633`, job by job.
- Migration files are unchanged by #929. Hosted state remains declared only in
  `migration-state.json`; no hosted query, apply or provider/customer-data write occurred.

**Not re-measured:** Vercel deployment target/aliases, live photo recovery, health,
tenant counts, `ops_alerts`, provider state, payment counts or customer acceptance.
Those facts keep their original dates and scopes. Other open-PR rows below remain
dated history, not a fresh census. Dependent releases stay held pending this
record repair's exact-head review, applicable CI and Sam's release authorization.

<!-- canonical-facts:ignore-end -->

### Historical preceding baseline from the 2026-10-18 `f9cd9013` reconciliation

<!-- canonical-facts:ignore-start reason=preserves-the-f9cd9013-unmerged-record-as-dated-history -->
#### Prior reconciliation header

| Field | Value |
|---|---|
| **Reconciliation date** | **2026-10-18 UTC source sync** (CANON-REFRESH-2026-10-18b, 1 merge after the `aaf3042b` record, runtime-bearing; the `aaf3042b` record itself was never merged before production moved, so it is preserved below as history). Earlier syncs are preserved below as history. Production-data counts elsewhere retain their own older measurement dates. |
| **Production branch** | `claude/build-hone-saas-hOex7` |
| **Current Git branch HEAD at this sync** | **`f9cd9013b011752a751b84e6b28eb509033155d4` — merge of #894.** Re-read GitHub before any production action; this is a dated sync value, not a perpetual pointer. |
| **Last runtime-bearing application HEAD at this sync** | **`f9cd9013b011752a751b84e6b28eb509033155d4` (#894).** This is also the branch HEAD above. `git log --first-parent aaf3042b..f9cd9013` returns **1** merge, classified by **A3's composed deployed predicate** (unchanged; see the 2026-09-21 record) and by `scripts/classify-changes.mjs`: `f9cd9013` (#894) changes **2** shipping files (`components/client-pinned-notes-card.tsx`, `components/pinned-notes-readonly.tsx`) plus an e2e spec and a new test (classifier: `application=true`, `browser_core=true`, `mobile=true`, T1). It carries no migration. With this pin, A3's residue is **0** files. |
| **Current Vercel Production deployment evidence** | **Source and runtime are the same commit.** `f9cd9013` (#894, merged `2026-10-18T22:54:36Z` from head `1625277f`) is deployed as `dpl_2aYU2BzMnAkKMjS92eTcvxa1z2w7`: state **READY**, target **production**, ready `2026-10-18T22:56:35Z`, aliases include **`hone.care`** and `www.hone.care`, `githubCommitSha` `f9cd9013` (Vercel deployment record read 2026-10-18; commit status **success** at `22:56:36Z`). `aaf3042b` (#918, `dpl_2fomfoKM5oVUixiH2kDJvZ4XiJ4C`) is superseded on `hone.care` by it. Production push CI `39174260834` (`f9cd9013`) failed: changed-path detection, browser shards 1–3 (targeted), the browser aggregator and mobile completion e2e **succeeded**; db integration, payment, Google and the docs-only canonical lane were **SKIPPED** (not executed, so they prove nothing about this push); **validate** (typecheck / lint / build / test / safety gates) **failed only** canonical-production-facts A3 and A5 (2 of 20,838 tests; 913 of 914 files passed), the stale `aaf3042b` record this sync replaces. The previous push run, `39169537877` (`aaf3042b`), is recorded in the preserved `aaf3042b` header rows below. |
| **Migration state** | **This document deliberately states no migration number.** Hosted max is declared once, machine-readably, in [`migration-state.json`](./migration-state.json). Repository max, total applied and the next free number are **derived** — run `npm run migration:state`. The current reconciled position, with checksums and apply evidence, is [migration-ledger.md](./migration-ledger.md) under *Current state*. A number copied into this table is a number that goes stale on the next apply; that is how the `0160`/`0163`/`0165` divergence happened. |
| **Database vs. application skew** | **This document asserts no parity, pending or remote-only claim of its own.** It previously declared the two states equal and the pending set empty, and went stale the moment a reviewed migration was authored above hosted — the same second-copy failure this table already avoids for migration NUMBERS. Derive the relationship with `npm run migration:state`; hosted state is declared once in [`migration-state.json`](./migration-state.json); the reconciled position with apply evidence is [migration-ledger.md](./migration-ledger.md) under *Current state*. **A repository maximum ABOVE hosted is the normal state of an authorized migration-first apply** — reviewed migration authored, production not yet advanced — and is not by itself skew. What would be skew is a **remote-only** migration (hosted above repo), which the derivation reports and the canonical guard forbids. |
| **Production Supabase project** | The single production project. Always re-read the linked ref from `supabase/.temp/project-ref` (gitignored) and verify with `supabase migration list --linked` before trusting any number here. **No credentials are recorded in documentation.** (The project ref itself appears in at least one older repo document, so treat it as an operational identifier rather than a secret — but do not add new copies of it.) |
| **Health** | **Status-code probe, 2026-10-17T17:05Z** (unauthenticated GET, redirects not followed): `hone.care` **200** · `/login` **200** · `/dashboard`, `/clients`, `/calendar` and `/api/health` **307 → /login**, all non-5xx. This is a reachability reading only. ⚠️ `ops_alerts` was **not** re-read at this sync. Earlier probes are preserved below as dated readings. These are dated observations, not current health. |
| **Tenant posture** | **Six studios in three classes — one real-customer, one controlled test, one synthetic, three empty.** Real-customer activity is **Willow Electrolysis only**. See **§0**, which is the canonical tenant register; do not restate its counts elsewhere. ⚠️ **Every tenant count in §0 was measured 2026-08-23 and was NOT re-measured on 2026-08-26** — see *What this reconciliation did and did not measure* below. |
| **Next operational gate** | The **deep production / security / code audit** (still not performed against this baseline). **Chloe's human acceptance testing** remains outstanding and is **independent** — see §15. |

### Re-derived at this reconciliation

**Re-derived on 2026-10-18 (CANON-REFRESH-2026-10-18b), from the repository at `f9cd9013`:**

- the production branch head and the full merge ancestry back to `b9e0003f` (164 merges),
  from `git rev-list --first-parent --merges --count b9e0003f..f9cd9013`;
- the **1 merge** since the previous record `aaf3042b`: `f9cd9013` (#894, 2 shipping files under
  `components/`), classified with `scripts/classify-changes.mjs` over the merge's own
  first-parent diff. It is **runtime-bearing**, so the runtime-bearing HEAD moves from
  `aaf3042b` to `f9cd9013`; it carries no migration;
- repository and hosted migration state: **derived** with `npm run migration:state`
  (unchanged by this merge; it carries no migration) and **declared** in
  [`migration-state.json`](./migration-state.json), which this sync does not change. This
  document states no number;
- the Vercel deployment record for `f9cd9013` (id, READY state, production target, aliases,
  commit SHA), its Vercel commit status, and its production push CI run, job by job.

**Not re-measured at this sync:** the status-code health probe (header row *Health* keeps its
dated 2026-10-17T17:05Z reading), tenant counts (§0), `ops_alerts`, provider state, payment row
counts (§7), the open-PR table (last re-read 2026-10-18 at the `aaf3042b` derivation), whether
the pinned-note editor behaves as described in production, and any capability's production
exercise. Their own measurement dates stand.

<!-- canonical-facts:ignore-end -->

### Historical preceding baseline from the 2026-10-18 `aaf3042b` reconciliation

<!-- canonical-facts:ignore-start reason=preserves-the-aaf3042b-CANON-REFRESH-derivation-and-header-rows-as-dated-evidence -->
**Re-derived on 2026-10-18 (CANON-REFRESH-2026-10-18), from the repository at `aaf3042b`:**

- the production branch head and the full merge ancestry back to `b9e0003f` (163 merges),
  from `git rev-list --first-parent --merges --count b9e0003f..aaf3042b`;
- the **3 merges** since the previous record `6acea261`: `c901be08` (#915, `docs/production`
  only), `32023620` (#919, CI workflow and a test, 0 shipping files) and `aaf3042b` (#918, 4
  shipping files), each classified with `scripts/classify-changes.mjs` over the merge's own
  first-parent diff. Only #918 is **runtime-bearing**, so the runtime-bearing HEAD moves from
  `6acea261` to `aaf3042b`; none carries a migration;
- repository and hosted migration state: **derived** with `npm run migration:state`
  (unchanged by these merges; none carries a migration) and **declared** in
  [`migration-state.json`](./migration-state.json), which this sync does not change. This
  document states no number;
- the Vercel deployment records for `aaf3042b` and `32023620` (id, state, production target,
  aliases), Vercel commit status for all three merges, and the production push CI run for
  each, job by job;
- the open-PR table below, every row re-read from GitHub on 2026-10-18.

**Not re-measured at this sync:** the status-code health probe (header row *Health* keeps its
dated 2026-10-17T17:05Z reading), tenant counts (§0), `ops_alerts`, provider state, payment row
counts (§7), whether PostHog events or `/flags` traffic in production actually lose record ids,
whether `NEXT_PUBLIC_POSTHOG_*` is set in Vercel, and any capability's production exercise.
Their own measurement dates stand.

The `aaf3042b` header rows, preserved verbatim as dated evidence (superseded by the header above):

| Field | Value at the `aaf3042b` sync |
|---|---|
| **Reconciliation date** | **2026-10-18 UTC source sync** (CANON-REFRESH-2026-10-18, 3 merges after the `6acea261` record, **one** runtime-bearing). Earlier syncs are preserved below as history. Production-data counts elsewhere retain their own older measurement dates. |
| **Current Git branch HEAD at this sync** | **`aaf3042b535c4779a922ef4519667c9e62a38909` — merge of #918.** Re-read GitHub before any production action; this is a dated sync value, not a perpetual pointer. |
| **Last runtime-bearing application HEAD at this sync** | **`aaf3042b535c4779a922ef4519667c9e62a38909` (#918).** This is also the branch HEAD above. `git log --first-parent 6acea261..aaf3042b` returns **3** merges, classified by **A3's composed deployed predicate** (unchanged; see the 2026-09-21 record) and by `scripts/classify-changes.mjs`: `c901be08` (#915) is `docs/production` only (classifier: `docs_only=true`, T0); `32023620` (#919) changes **0** shipping files (`.github/workflows/ci.yml` and a new test, `tests/ci/push-changed-files.test.ts`; classifier: `ci_workflows=true`, `full_matrix_required=true`, T2 "CI or build control system changed", which is a CI-coverage signal, not a runtime change); `aaf3042b` (#918) changes **4** shipping files (`instrumentation-client.ts`, `lib/analytics/client-boundary.ts`, `lib/analytics/path-ids.ts` (new), `lib/analytics/vercel-url-redaction.ts`) plus a doc and a test (classifier: `application=true`, T1). **None** carries a migration. With this pin, A3's residue is **0** files. |
| **Current Vercel Production deployment evidence** | **Source and runtime are the same commit.** `aaf3042b` (#918, merged `2026-10-18T21:49:36Z` from head `40ae08ed`) is deployed as `dpl_2fomfoKM5oVUixiH2kDJvZ4XiJ4C`: state **READY**, target **production**, ready `2026-10-18T21:52:04Z`, aliases include **`hone.care`** and `www.hone.care` (Vercel deployment record and commit status **success**, both read 2026-10-18). The two earlier merges were also built and deployed, **success**: `c901be08` (#915, merged `2026-10-17T22:46:48Z`) at `2026-10-17T22:48:53Z` (`GZB2QY9H8zragquuc1rUUSjDYBZ2`), with no runtime change; `32023620` (#919, merged `2026-10-18T21:48:21Z` from head `c9409bfc`) as `dpl_3KHc6myVfZy2HWcDDrLPt6yR7g96`, success `2026-10-18T21:50:18Z`, with no runtime change, superseded on `hone.care` by `aaf3042b`. Production push CI: `39076439741` (`c901be08`) **success**, with validate, db integration, payment, Google, mobile and all four browser shards run and passing (only the docs-only canonical lane was skipped); `39169449159` (`32023620`) **CANCELLED**, superseded by the next merge's run, so nothing was proved on that push; `39169537877` (`aaf3042b`) failed: changed-path detection, browser shards 1–4 (extended) and the browser aggregator **succeeded**; db integration, payment, Google, mobile and the docs-only canonical lane were **SKIPPED** (not executed, so they prove nothing about this push); **validate** (typecheck / lint / build / test / safety gates) **failed only** canonical-production-facts A3 and A5 (2 of 20,823 tests; 912 of 913 files passed), the stale `6acea261` record this sync replaces. That run is the first production push after #919: its changed-path diff was computed against `BEFORE=32023620`, i.e. what the #918 merge shipped, not the combined diff that left `6acea261`'s push with validate skipped (the coverage gap the `6acea261` record names). |
| **Health** | **Status-code probe, 2026-10-17T17:05Z** (unauthenticated GET, redirects not followed): `hone.care` **200** · `/login` **200** · `/dashboard`, `/clients`, `/calendar` and `/api/health` **307 → /login**, all non-5xx. This is a reachability reading only. ⚠️ `ops_alerts` was **not** re-read at this sync. Earlier probes are preserved below as dated readings. These are dated observations, not current health. |
<!-- canonical-facts:ignore-end -->

### Historical preceding baseline from the 2026-10-17 `6acea261` reconciliation

<!-- canonical-facts:ignore-start reason=preserves-the-6acea261-CANON-REFRESH-derivation-and-header-rows-as-dated-evidence -->
**Re-derived on 2026-10-17 (CANON-REFRESH-2026-10-17c), from the repository at `6acea261`:**

- the production branch head and the full merge ancestry back to `b9e0003f` (160 merges),
  from `git rev-list --first-parent --merges --count b9e0003f..6acea261`;
- the **3 merges** since the previous record `62ff27b2`: `c0982d63` (#911, `docs/production`
  only), `4ae19a41` (#913, 4 shipping files) and `6acea261` (#912, 5 shipping files). #913 and
  #912 are **runtime-bearing**, so the runtime-bearing HEAD moves from `62ff27b2` to
  `6acea261`; none carries a migration;
- repository and hosted migration state: **derived** with `npm run migration:state`
  (unchanged by these merges; none carries a migration) and **declared** in
  [`migration-state.json`](./migration-state.json), which this sync does not change. This
  document states no number;
- the Vercel deployment records for `6acea261` and `4ae19a41` (id, READY state, production
  target, aliases), Vercel commit status for all three merges, and the production push CI run
  for each;
- the open-PR table below, every row re-read from GitHub on 2026-10-17.

**Not re-measured at this sync:** the status-code health probe (header row *Health* keeps its
dated 17:05Z reading), tenant counts (§0), `ops_alerts`, provider state, payment row counts
(§7), whether the egress proxies or the photo grid behave as described in production, and any
capability's production exercise. Their own measurement dates stand.

The `6acea261` header rows, preserved verbatim as dated evidence (superseded by the header above):

| Field | Value at the `6acea261` sync |
|---|---|
| **Reconciliation date** | **2026-10-17 UTC source sync** (CANON-REFRESH-2026-10-17c, 3 merges after the `62ff27b2` record, **two** runtime-bearing). Earlier syncs are preserved below as history. Production-data counts elsewhere retain their own older measurement dates. |
| **Current Git branch HEAD at this sync** | **`6acea261a8840b4b7ae026f4f181f31b6dc976e6` — merge of #912.** Re-read GitHub before any production action; this is a dated sync value, not a perpetual pointer. |
| **Last runtime-bearing application HEAD at this sync** | **`6acea261a8840b4b7ae026f4f181f31b6dc976e6` (#912).** This is also the branch HEAD above. `git log --first-parent 62ff27b2..6acea261` returns **3** merges, classified by **A3's composed deployed predicate** (unchanged; see the 2026-09-21 record): `c0982d63` (#911) is `docs/production` only; `4ae19a41` (#913) changes **4** shipping files (`app/(app)/clients/[id]/images/GridPhoto.tsx`, `TreatmentImagesManager.tsx`, `actions.ts`, `lib/images/grid-photo-recovery.ts`) plus docs, an e2e spec, `scripts/browser-groups.mjs` and tests; `6acea261` (#912) changes **5** shipping files (`app/ingest/[...path]/route.ts`, `app/monitoring/route.ts`, `instrumentation-client.ts`, `lib/observability/egress-proxy.ts`, `next.config.ts`) plus a doc, two e2e specs and tests. **None** carries a migration. With this pin, A3's residue is **0** files. |
| **Current Vercel Production deployment evidence** | **Source and runtime are the same commit.** `6acea261` (#912, merged `2026-10-17T19:55:12Z` from head `c146004a`) is deployed as `dpl_LbwCQZX6F1T7cdpo6tgGeayuyqQN`: state **READY**, target **production**, ready `2026-10-17T19:57:42Z`, aliases include **`hone.care`** and `www.hone.care` (Vercel deployment record and commit status **success**, both read 2026-10-17). The two earlier merges were also built and deployed, **success**: `c0982d63` (#911, merged `18:07:11Z`) at `2026-10-17T18:08:59Z` (`4Jz6qWXig6ciQ1Qh3QHvZUYehMQa`), with no runtime change; `4ae19a41` (#913, merged `19:37:16Z` from head `be1c94b9`) as `dpl_Gz7vPNNsPvZWgRR2d3ZbTSh2r3cj`, READY `2026-10-17T19:39:24Z`, superseded on `hone.care` by `6acea261`. Production push CI: `39056703986` (`c0982d63`) success, with validate run; `39063253755` (`4ae19a41`) failed **only** canonical-production-facts A3 and A5, the stale record this sync replaces; `39064516027` (`6acea261`) is a push run with conclusion **success**, but its **validate** (typecheck / lint / build / test) and **canonical production record** jobs were **SKIPPED**, so neither the build nor record freshness was checked on that push. Only changed-path detection and the browser aggregator ran: the push classifier listed one file (`docs/03_SECURITY_AND_PRIVACY.md`) for this merge commit and classified it docs-only. That is a CI coverage gap, reported separately and not fixed here. |
| **Health** | **Status-code probe, 2026-10-17T17:05Z** (unauthenticated GET, redirects not followed): `hone.care` **200** · `/login` **200** · `/dashboard`, `/clients`, `/calendar` and `/api/health` **307 → /login**, all non-5xx. This is a reachability reading only. ⚠️ `ops_alerts` was **not** re-read at this sync. Earlier probes are preserved below as dated readings. These are dated observations, not current health. |
<!-- canonical-facts:ignore-end -->

### Historical preceding baseline from the 2026-10-17 `62ff27b2` reconciliation

<!-- canonical-facts:ignore-start reason=preserves-the-62ff27b2-CANON-REFRESH-derivation-and-header-rows-as-dated-evidence -->
**Re-derived on 2026-10-17 (CANON-REFRESH-2026-10-17b), from the repository at `62ff27b2`:**

- the production branch head and the full merge ancestry back to `b9e0003f` (157 merges),
  from `git rev-list --first-parent --merges --count b9e0003f..62ff27b2`;
- the **3 merges** since the previous record `b08845ce`: `981bf49b` (#909, `docs/production`
  only), `25956e5c` (#842, 2 shipping files) and `62ff27b2` (#891, 1 shipping file). #842 and
  #891 are **runtime-bearing**, so the runtime-bearing HEAD moves from `b08845ce` to
  `62ff27b2`; none carries a migration;
- repository and hosted migration state: **derived** with `npm run migration:state`
  (unchanged by these merges; none carries a migration) and **declared** in
  [`migration-state.json`](./migration-state.json). This document states no number;
- the Vercel deployment record for `62ff27b2` (id, READY state, production target, `hone.care`
  alias), Vercel commit status for all three merges, and a status-code probe of six public or
  protected routes (header row *Health*);
- the open-PR table below, every row re-read from GitHub on 2026-10-17.

**Not re-measured at this sync:** tenant counts (§0), `ops_alerts`, provider state, payment
row counts (§7), whether Sentry or Vercel Analytics events in production are actually redacted,
and any capability's production exercise. Their own measurement dates stand.

The `62ff27b2` header rows, preserved verbatim as dated evidence (superseded by the header above):

| Field | Value at the `62ff27b2` sync |
|---|---|
| **Reconciliation date** | **2026-10-17 UTC source sync** (CANON-REFRESH-2026-10-17b, 3 merges after the `b08845ce` record, **two** runtime-bearing). Earlier syncs are preserved below as history. Production-data counts elsewhere retain their own older measurement dates. |
| **Current Git branch HEAD at this sync** | **`62ff27b286ea335605342e57067b0c6a05a1a8e5` — merge of #891.** Re-read GitHub before any production action; this is a dated sync value, not a perpetual pointer. |
| **Last runtime-bearing application HEAD at this sync** | **`62ff27b286ea335605342e57067b0c6a05a1a8e5` (#891).** This is also the branch HEAD above. `git log --first-parent b08845ce..62ff27b2` returns **3** merges, classified by **A3's composed deployed predicate** (unchanged; see the 2026-09-21 record): `981bf49b` (#909) is `docs/production` only; `25956e5c` (#842) changes **2** shipping files (`app/_components/SafeAnalytics.tsx`, `lib/analytics/vercel-url-redaction.ts`) plus a doc and a test; `62ff27b2` (#891) changes **1** shipping file (`lib/observability/sentry-scrub.ts`) plus a doc and a test. **None** carries a migration. With this pin, A3's residue is **0** files. |
| **Current Vercel Production deployment evidence** | **Source and runtime are the same commit.** `62ff27b2` (#891, merged `2026-10-17T15:29:18Z` from head `1cf1440f`) is deployed as `dpl_39M9TZukQDF2W2figToXg2uicHJA`: state **READY**, target **production**, ready `2026-10-17T15:31:27Z`, aliases include **`hone.care`** and `www.hone.care` (Vercel deployment record and commit status **success**, both read 2026-10-17). The two earlier merges were also built and deployed, **success**: `981bf49b` (#909, merged `15:28:56Z`) at `2026-10-17T15:30:59Z` (`AcArB7tboaXoJ7fd7uNAXw8nVehG`), with no runtime change; `25956e5c` (#842, merged `15:29:07Z`) at `2026-10-17T15:31:14Z` (`6rUKRWiPS1WtgjohBYNHfK6W5tCM`), superseded on `hone.care` by `62ff27b2`. |
| **Health** | **Status-code probe, 2026-10-17T17:05Z** (unauthenticated GET, redirects not followed): `hone.care` **200** · `/login` **200** · `/dashboard`, `/clients`, `/calendar` and `/api/health` **307 → /login**, all non-5xx. This is a reachability reading only. ⚠️ `ops_alerts` was **not** re-read at this sync. Earlier probes are preserved below as dated readings. These are dated observations, not current health. |
<!-- canonical-facts:ignore-end -->

### Historical preceding baseline from the 2026-10-17 `b08845ce` reconciliation

<!-- canonical-facts:ignore-start reason=preserves-the-b08845ce-CANON-REFRESH-derivation-and-header-rows-as-dated-evidence -->
**Re-derived on 2026-10-17 (CANON-REFRESH-2026-10-17), from the repository at `b08845ce`:**

- the production branch head and the full merge ancestry back to `b9e0003f` (154 merges),
  from `git rev-list --first-parent --merges --count b9e0003f..b08845ce`;
- the **2 merges** since the previous record `0ae33bd3`: `b308187d` (#889, `docs/production`
  only) and `b08845ce` (#898, 3 shipping files under `lib/billing/` plus 2 tests). #898 is
  **runtime-bearing**, so the runtime-bearing HEAD moves from `ce133c18` to `b08845ce`;
  neither carries a migration;
- repository and hosted migration state: **derived** with `npm run migration:state`
  (unchanged by these merges; neither carries a migration) and **declared** in
  [`migration-state.json`](./migration-state.json). This document states no number;
- the Vercel deployment record for `b08845ce` (id, READY state, production target, `hone.care`
  alias), Vercel commit status for both merges, and a status-code probe of six public or
  protected routes (header row *Health*);
- the open-PR table below, every row re-read from GitHub on 2026-10-17.

**Not re-measured at this sync:** tenant counts (§0), `ops_alerts`, provider state, payment
row counts (§7), and any capability's production exercise. Their own measurement dates stand.

The `b08845ce` header rows, preserved verbatim as dated evidence (superseded by the header above):

| Field | Value at the `b08845ce` sync |
|---|---|
| **Reconciliation date** | **2026-10-17 UTC source sync** (CANON-REFRESH-2026-10-17, 2 merges after the `0ae33bd3` record, **one** runtime-bearing). Earlier syncs are preserved below as history. Production-data counts elsewhere retain their own older measurement dates. |
| **Current Git branch HEAD at this sync** | **`b08845ce69c6599dee91984b9e28c8c07c9ad86b` — merge of #898.** Re-read GitHub before any production action; this is a dated sync value, not a perpetual pointer. |
| **Last runtime-bearing application HEAD at this sync** | **`b08845ce69c6599dee91984b9e28c8c07c9ad86b` (#898).** This is also the branch HEAD above. `git log --first-parent ce133c18..b08845ce` returns **9** merges, and by **A3's composed deployed predicate** (unchanged; see the 2026-09-21 record) only the last is runtime-bearing. The 2 merges since the previous record: `b308187d` (#889, `docs/production` only) and `b08845ce` (#898), which changes **3** shipping files (`lib/billing/payment-refund.ts`, `lib/billing/session-payment-charge.ts`, `lib/billing/stripe-error-outcome.ts`) plus 2 tests under `tests/lib/billing/`. **Neither** carries a migration. With this pin, A3's residue is **0** files. |
| **Current Vercel Production deployment evidence** | **Source and runtime are the same commit.** `b08845ce` (#898, merged `2026-10-17T13:55:40Z` from head `a91cc92e`) is deployed as `dpl_Foa9eAuKKat269AuTrLeCKeoB2Mv`: state **READY**, target **production**, ready `2026-10-17T13:57:43Z`, aliases include **`hone.care`** and `www.hone.care` (Vercel deployment record and commit status **success**, both read 2026-10-17). `b308187d` (#889) was also built and deployed, **success** at `2026-10-16T23:09:04Z` (`8BrGckP4yACXeVqshD1KvU8Ajd9X`), with no runtime change. |
| **Health** | **Status-code probe, 2026-10-17T14:12Z** (unauthenticated GET, redirects not followed): `hone.care` **200** · `/login` **200** · `/dashboard`, `/clients`, `/calendar` and `/api/health` **307 → /login**, all non-5xx. This is a reachability reading only. ⚠️ `ops_alerts` was **not** re-read at this sync. Earlier probes are preserved below as dated readings. These are dated observations, not current health. |
<!-- canonical-facts:ignore-end -->

### Historical preceding baseline from the 2026-10-16 `0ae33bd3` reconciliation

<!-- canonical-facts:ignore-start reason=preserves-the-0ae33bd3-CANON-REFRESH-derivation-and-header-rows-as-dated-evidence -->
**Re-derived on 2026-10-16 (CANON-REFRESH-2026-10-16b), from the repository at `0ae33bd3`:**

- the production branch head and the full merge ancestry back to `b9e0003f` (152 merges),
  from `git rev-list --first-parent --merges --count b9e0003f..0ae33bd3`;
- the **2 merges** since the previous record `1ae096e2`: `862c1fee` (#886, `CLAUDE.md`, `docs` only), `0ae33bd3` (#887, `.github`, `scripts`, `tests` only). **None** is
  runtime-bearing and none carries a migration, so the runtime-bearing HEAD stays `ce133c18`;
- repository and hosted migration state: **derived** with `npm run migration:state`
  (unchanged by these merges) and **declared** in
  [`migration-state.json`](./migration-state.json). This document states no number;
- Vercel commit status and deployment id for each of these merges, and a status-code probe
  of six public or protected routes (header row *Health*);
- the open-PR table below, every row re-read from GitHub on 2026-10-16.

**Not re-measured at this sync:** tenant counts (§0), `ops_alerts`, provider state, payment
row counts (§7), and any capability's production exercise. Their own measurement dates stand.

The `0ae33bd3` header rows, preserved verbatim as dated evidence (superseded by the header above):

| Field | Value at the `0ae33bd3` sync |
|---|---|
| **Reconciliation date** | **2026-10-16 UTC source sync** (CANON-REFRESH-2026-10-16b, 2 merges after the `1ae096e2` record, **none** runtime-bearing). Earlier syncs are preserved below as history. Production-data counts elsewhere retain their own older measurement dates. |
| **Current Git branch HEAD at this sync** | **`0ae33bd376720310ec28ba9e896bc7936630a24c` — merge of #887.** Re-read GitHub before any production action; this is a dated sync value, not a perpetual pointer. |
| **Last runtime-bearing application HEAD at this sync** | **`ce133c18b8458e07b86c05301a5a38b92c9cb0be` (#857), unchanged.** It is **not** the branch HEAD above. `git log --first-parent ce133c18..0ae33bd3` returns **7** merges, and by **A3's composed deployed predicate** (unchanged; see the 2026-09-21 record) **none** is runtime-bearing. The 2 merges since the previous record: `862c1fee` (#886, `CLAUDE.md`, `docs` only), `0ae33bd3` (#887, `.github`, `scripts`, `tests` only). **None** carries a migration. With this pin, A3's residue is **0** files. |
| **Current Vercel Production deployment evidence** | **Source and runtime recorded separately.** Source: the branch HEAD above (`0ae33bd3`). Runtime: the application code last changed at `ce133c18` (#857); see the history below for its deployment. Vercel built and deployed each merge since the previous record, all **success**, none carrying a runtime change: `862c1fee` (#886) at `2026-10-16T15:56:36Z` (`89JUZ7mQvbpN2d4pVru4ngCnVDae`); `0ae33bd3` (#887) at `2026-10-16T21:59:46Z` (`7rEebdzGbS3igPRBXBoNYLd4PTev`), all read 2026-10-16. No alias or current health measurement is inferred from those statuses. |
| **Health** | **Status-code probe, 2026-10-16T22:09Z** (unauthenticated GET, redirects not followed): `hone.care` **200** · `/login` **200** · `/dashboard`, `/clients`, `/calendar` and `/api/health` **307 → /login**, all non-5xx. This is a reachability reading only. ⚠️ `ops_alerts` was **not** re-read at this sync. Earlier probes are preserved below as dated readings. These are dated observations, not current health. |
<!-- canonical-facts:ignore-end -->

### Historical preceding baseline from the 2026-10-16 `1ae096e2` reconciliation

<!-- canonical-facts:ignore-start reason=preserves-the-1ae096e2-CANON-REFRESH-derivation-and-header-rows-as-dated-evidence -->
**Re-derived on 2026-10-16 (CANON-REFRESH-2026-10-16), from the repository at `1ae096e2`:**

- the production branch head and the full merge ancestry back to `b9e0003f` (150 merges),
  from `git rev-list --first-parent --merges --count b9e0003f..1ae096e2`;
- the **5** merges since the 2026-10-14 pin `ce133c18`: `b4316a4b` (#880, documentation-only),
  `9f5344a5` (#883, tests-only), `3060a16a` (#881, CI-only), `02916ab6` (#879,
  test-harness-only) and `1ae096e2` (#885, test harness and guide). **None** is runtime-bearing and none carries a migration, so the
  runtime-bearing HEAD stays `ce133c18`;
- repository and hosted migration state: **derived** with `npm run migration:state`
  (unchanged by these five merges) and **declared** in
  [`migration-state.json`](./migration-state.json). This document states no number;
- Vercel commit status and deployment id for each of the five merges, and a status-code probe
  of six public or protected routes (header row *Health*);
- the open-PR table below, every row re-read from GitHub on 2026-10-16.

**Not re-measured at this sync:** tenant counts (§0), `ops_alerts`, provider state, payment
row counts (§7), and any capability's production exercise. Their own measurement dates stand.

The `1ae096e2` header rows, preserved verbatim as dated evidence (superseded by the header above):

| Field | Value at the `1ae096e2` sync |
|---|---|
| **Reconciliation date** | **2026-10-16 UTC source sync** (CANON-REFRESH-2026-10-16, five merges after the 2026-10-14 sync, **none** runtime-bearing). The 2026-10-14, 2026-10-13, 2026-10-12 and 2026-09-21 syncs are preserved below as history. Production-data counts elsewhere retain their own older measurement dates. |
| **Current Git branch HEAD at this sync** | **`1ae096e25127e54304207f44cf2157dde9b67566` — merge of #885.** Re-read GitHub before any production action; this is a dated sync value, not a perpetual pointer. |
| **Last runtime-bearing application HEAD at this sync** | **`ce133c18b8458e07b86c05301a5a38b92c9cb0be` (#857), unchanged since the 2026-10-14 sync.** It is **not** the branch HEAD above. `git log --first-parent ce133c18..1ae096e2` returns **5** merges, and by **A3's composed deployed predicate** (unchanged; see the 2026-09-21 record) **none** is runtime-bearing: `b4316a4b` (#880) is documentation-only (3 files under `docs/production/`); `9f5344a5` (#883) is tests-only (3 files under `tests/eng/v2/verify/`); `3060a16a` (#881) is CI-only (`.github/workflows/ci.yml`, `.github/workflows/nightly.yml`, `scripts/ci/supabase-start-bind-retry.sh` and its test); `02916ab6` (#879) is test-harness-only (3 files under `e2e/helpers/` and one test); `1ae096e2` (#885) is test-harness and guide only (`vitest.db.config.ts`, one test, `CLAUDE.md`). **None** carries a migration. With this pin, A3's residue is **0** files. |
| **Current Vercel Production deployment evidence** | **Source and runtime recorded separately.** Source: the branch HEAD above (`1ae096e2`). Runtime: the application code last changed at `ce133c18` (#857), whose Vercel commit status is **success** (`2026-10-14T03:31:02Z`, deployment `Ch9W23Q5LEpQj2QTt89TuiXGbEWC`). Vercel also built and deployed each of the five later merges, all **success**, none carrying a runtime change: `b4316a4b` (#880) at `2026-10-14T15:47:24Z` (`5GputXRPo2U8EyXyvRcSRVhcusJQ`), `9f5344a5` (#883) at `2026-10-14T15:48:22Z` (`H2P5mgaEN7g4zYm9b8dVAvSrqLnn`), `3060a16a` (#881) at `2026-10-14T17:57:46Z` (`8s4BiB5G7uxPpjCqKVLJUWZAhp8c`) `02916ab6` (#879) at `2026-10-15T04:55:55Z` (`AChX29bvy7EjFE36wB3pfNqjZScn`) and `1ae096e2` (#885) at `2026-10-15T22:00:33Z` (`A3WRvXE2tfJa5UxwouRAgidbaKxG`), all read 2026-10-16. No alias or current health measurement is inferred from those statuses. |
| **Health** | **Status-code probe, 2026-10-16T12:24Z** (unauthenticated GET, redirects not followed): `hone.care` **200** · `/login` **200** · `/dashboard`, `/clients`, `/calendar` and `/api/health` **307 → /login**, all non-5xx. This is a reachability reading only. ⚠️ `ops_alerts` was **not** re-read at this sync. The **2026-10-15T15:52Z** (at `02916ab6`), **2026-10-14T12:23Z**, **2026-10-14T02:40Z**, **2026-10-13T16:20Z**, **2026-10-12T23:07Z** and **2026-08-23** probes are preserved as earlier dated readings. These are dated observations, not current health. |
<!-- canonical-facts:ignore-end -->

### Historical preceding baseline from the 2026-10-14 reconciliation

<!-- canonical-facts:ignore-start reason=preserves-the-2026-10-14-CANON-REFRESH-derivation-and-header-rows-as-dated-evidence -->
**Re-derived on 2026-10-14 (CANON-REFRESH-2026-10-14), from the repository at `ce133c18`:**

- the production branch head and the full merge ancestry back to `b9e0003f` (145 merges),
  from `git rev-list --first-parent --merges --count b9e0003f..ce133c18`;
- the **5** merges since the 2026-10-13 pin `6f7281bb`: `f5c87f93` (#877, documentation-only),
  `d0118f75` (#869), `82a0e520` (#769), `338014f4` (#776) and `ce133c18` (#857), the last four
  runtime-bearing; none carries a migration;
- repository and hosted migration state: **derived** with `npm run migration:state`
  (unchanged by these five merges) and **declared** in
  [`migration-state.json`](./migration-state.json). This document states no number;
- Vercel commit status and deployment id for each runtime merge, and a status-code probe of six
  public or protected routes (header row *Health*);
- the open-PR table below, every row re-read from GitHub on 2026-10-14.

**Not re-measured at this sync:** tenant counts (§0), `ops_alerts`, provider state, payment
row counts (§7), and any capability's production exercise. Their own measurement dates stand.

The 2026-10-14 header rows, preserved verbatim as dated evidence (superseded by the header above):

| Field | Value at the 2026-10-14 sync |
|---|---|
| **Reconciliation date** | **2026-10-14 UTC source sync** (CANON-REFRESH-2026-10-14, five merges after the 2026-10-13 sync, four of them runtime-bearing). The 2026-10-13, 2026-10-12 and 2026-09-21 syncs are preserved below as history. Production-data counts elsewhere retain their own older measurement dates. |
| **Current Git branch HEAD at this sync** | **`ce133c18b8458e07b86c05301a5a38b92c9cb0be` — merge of #857.** Re-read GitHub before any production action; this is a dated sync value, not a perpetual pointer. |
| **Last runtime-bearing application HEAD at this sync** | **`ce133c18b8458e07b86c05301a5a38b92c9cb0be` (#857).** This is also the branch HEAD above. `git log --first-parent 6f7281bb..ce133c18` returns **5** merges, classified by **A3's composed deployed predicate** (unchanged; see the 2026-09-21 record): `f5c87f93` (#877) is documentation-only (3 files, 0 application files) and does not move the runtime baseline; `d0118f75` (#869) changes **1** application file (`lib/analytics/client-boundary.ts`); `82a0e520` (#769) changes **5** application files under `app/(app)/settings/`; `338014f4` (#776) changes **5** application files under `app/(app)/clients/[id]/sessions/`; `ce133c18` (#857) changes **2** application files (`lib/stripe/setup-intent.ts`, `app/portal/payment-method-actions.ts`). **None** of the five carries a migration. With this pin, A3's residue is **0** files. |
| **Current Vercel Production deployment evidence** | **Source and runtime recorded separately.** Source: the branch HEAD above. Runtime: Vercel commit status for `ce133c18…` is **success** ("Deployment has completed", `2026-10-14T03:31:02Z`, deployment `Ch9W23Q5LEpQj2QTt89TuiXGbEWC`, read 2026-10-14). The three intermediate runtime merges also report **success**: `338014f4` (#776) at `2026-10-14T02:14:53Z` (`GRRSxjM8rK6zqxCJSkuz2UHWbCip`), `82a0e520` (#769) at `2026-10-14T01:48:48Z` (`EGXdJYey4ajRcEP1D46w2iM8jjzG`) and `d0118f75` (#869) at `2026-10-14T01:31:31Z` (`At3JpQw6RFLFR7SPa64ZZ62SVvSa`). No alias or current health measurement is inferred from those statuses. |
| **Health** | **Status-code probe, 2026-10-14T12:23Z** (unauthenticated GET, redirects not followed): `hone.care` **200** · `/login` **200** · `/dashboard`, `/clients`, `/calendar` and `/api/health` **307 → /login**, all non-5xx. This is a reachability reading only. ⚠️ `ops_alerts` was **not** re-read at this sync. The **2026-10-14T02:40Z** (at `338014f4`), **2026-10-13T16:20Z**, **2026-10-12T23:07Z** and **2026-08-23** probes are preserved as earlier dated readings. These are dated observations, not current health. |
<!-- canonical-facts:ignore-end -->

### Historical preceding baseline from the 2026-10-13 reconciliation

<!-- canonical-facts:ignore-start reason=preserves-the-2026-10-13-CANON-REFRESH-derivation-and-header-rows-as-dated-evidence -->
**Re-derived on 2026-10-13 (CANON-REFRESH-2026-10-13), from the repository at `6f7281bb`:**

- the production branch head and the full merge ancestry back to `b9e0003f` (140 merges),
  from `git rev-list --first-parent --merges --count b9e0003f..6f7281bb`;
- the **2** merges since the 2026-10-12 pin `d5efa20a`: `f91cdf03` (#875, documentation-only)
  and `6f7281bb` (#834, runtime-bearing, no migration);
- repository and hosted migration state: **derived** with `npm run migration:state`
  (unchanged by these two merges; neither carries a migration) and **declared** in
  [`migration-state.json`](./migration-state.json). This document states no number;
- Vercel commit status and deployment id for `6f7281bb`, and a status-code probe of six
  public or protected routes (header row *Health*).

**Not re-measured at this sync:** tenant counts (§0), `ops_alerts`, provider state, payment
row counts (§7), and any capability's production exercise. Their own measurement dates stand.

The 2026-10-13 header rows, preserved verbatim as dated evidence (superseded by the header above):

| Field | Value at the 2026-10-13 sync |
|---|---|
| **Reconciliation date** | **2026-10-13 UTC source sync** (CANON-REFRESH-2026-10-13, one runtime merge after the 2026-10-12 sync). The 2026-10-12 and 2026-09-21 syncs are preserved below as history. Production-data counts elsewhere retain their own older measurement dates. |
| **Current Git branch HEAD at this sync** | **`6f7281bb1b90e5a1911166495a249f7ac2770189` — merge of #834.** Re-read GitHub before any production action; this is a dated sync value, not a perpetual pointer. |
| **Last runtime-bearing application HEAD at this sync** | **`6f7281bb1b90e5a1911166495a249f7ac2770189` (#834).** This is also the branch HEAD above. `git log --first-parent d5efa20a..6f7281bb` returns **2** merges, classified by **A3's composed deployed predicate** (unchanged; see the 2026-09-21 record): `f91cdf03` (#875) is documentation-only (3 files, 0 application files, no migration) and does not move the runtime baseline; `6f7281bb` (#834) changes **5** application files in `lib/billing/` and `lib/stripe/`, with **no migration**. With this pin, A3's residue is **0** files. |
| **Current Vercel Production deployment evidence** | Vercel commit status for `6f7281bb…` is **success** ("Deployment has completed", `2026-10-13T14:18:38Z`, deployment `2Q9aZM1QYN7WMn76MSxTBrFEaex5`, read 2026-10-13). No alias or current health measurement is inferred from that status. |
| **Health** | **Status-code probe, 2026-10-13T16:20Z** (unauthenticated GET, redirects not followed): `hone.care` **200** · `/login` **200** · `/dashboard`, `/clients`, `/calendar` and `/api/health` **307 → /login**, all non-5xx. This is a reachability reading only. ⚠️ `ops_alerts` was **not** re-read at this sync. The **2026-10-12T23:07Z** and **2026-08-23** probes are preserved as earlier dated readings. These are dated observations, not current health. |
<!-- canonical-facts:ignore-end -->

### Historical preceding baseline from the 2026-10-12 reconciliation

<!-- canonical-facts:ignore-start reason=preserves-the-2026-10-12-CANON-REFRESH-derivation-and-header-rows-as-dated-evidence -->
**Re-derived on 2026-10-12 (CANON-REFRESH-2026-10-12), from the repository at `d5efa20a`:**

- the production branch head and the full merge ancestry back to `b9e0003f` (138 merges),
  from `git rev-list --first-parent --merges --count b9e0003f..d5efa20a`;
- the **57** merges since the previous sync's pin `410e5039`, each classified by **A3's
  composed deployed predicate** (unchanged from the previous sync, described there): **40**
  runtime-bearing, **17** not, **8** carrying a migration. The latest runtime-bearing merge is
  `d5efa20a` (#827). Documentation-only or non-shipping merges in that span include #756, #755,
  #783, #782, #787, #792, #794, #797, and the ENG-LOOP and CAP lane merges #802 to #811;
- repository and hosted migration state: **derived** with `npm run migration:state`, and
  **declared** in [`migration-state.json`](./migration-state.json). The reconciled position is
  [migration-ledger.md](./migration-ledger.md) under *Current state*. This document still
  states no number;
- Vercel commit status for `d5efa20a` (success) and a status-code probe of four public routes
  (header row *Health*).

**Not re-measured at this sync:** tenant counts (§0), `ops_alerts`, provider state, and any
capability's production exercise. Their own measurement dates stand.

The 2026-10-12 header rows, preserved verbatim as dated evidence (superseded by the header above):

| Field | Value at the 2026-10-12 sync |
|---|---|
| **Reconciliation date** | **2026-10-12 UTC source sync** (CANON-REFRESH-2026-10-12). The previous sync was 2026-09-20 / 2026-09-21; its derivations are preserved below as history. Production-data counts elsewhere retain their own older measurement dates. |
| **Current Git branch HEAD at this sync** | **`d5efa20ade0af7cdb8624185b2520cd507fa2713` — merge of #827.** Re-read GitHub before any production action; this is a dated sync value, not a perpetual pointer. |
| **Last runtime-bearing application HEAD at this sync** | **`d5efa20ade0af7cdb8624185b2520cd507fa2713` (#827).** This is also the branch HEAD above. `git log --first-parent 410e5039..d5efa20a` returns **57** merges. **40** are runtime-bearing and **17** are not, by **A3's composed deployed predicate**: *not documentation* (asked of `scripts/classify-changes.mjs`) **and** *not in a non-shipping root* (`tests/`, `e2e/`, `.github/`, `scripts/` except `PRODUCTION_BUILD_SCRIPTS`, test-runner and linter configs, `openwiki/`). **8** of the 57 carry a migration. #827 is the latest runtime-bearing head because it merged last and changes 3 shipping files; with this pin, A3's residue is **0** files. The per-merge derivation is in *Re-derived at this reconciliation* below. |
| **Current Vercel Production deployment evidence** | Vercel commit status for `d5efa20a…` is **success** ("Deployment has completed", `2026-10-12T22:04:08Z`, read 2026-10-12). No deployment id, alias or current health measurement is inferred from that status. |
| **Health** | **Status-code probe, 2026-10-12T23:07Z** (unauthenticated GET, redirects not followed): `hone.care` **200** · `/login` **200** · `/dashboard` **307 → /login** · `/api/health` **307 → /login**, all non-5xx. This is a reachability reading only, not an `ops_alerts` or provider-health measurement. ⚠️ `ops_alerts` was **not** re-read at this sync. The **2026-08-23** probe (same four routes, same codes, `ops_alerts` unresolved **4**, §13) is preserved as the previous dated reading. These are dated observations, not current health. |
<!-- canonical-facts:ignore-end -->

### Historical preceding baseline from the 2026-09-21 reconciliation

<!-- canonical-facts:ignore-start reason=preserves-the-2026-09-21-PROD-TRUTH-01-derivation-and-header-rows-as-dated-evidence -->
**Re-derived on 2026-09-21 (PROD-TRUTH-01), from the repository at `410e5039`:**

- the production branch head and the full merge ancestry back to `b9e0003f` (eighty-one merges);
- which of those merges are runtime-bearing, by **A3's composed deployed predicate** rather than
  by PR title or intuition — *not documentation* (asked of `scripts/classify-changes.mjs`) **and**
  *not in a non-shipping root*, where `scripts/` is **not** blanket-exempt: A3 subtracts the
  scripts `package.json`'s `build` executes (today `scripts/check-production-env-gates.mjs`),
  because a script the production build runs can change what the deployment does. The classifier
  answers "is this documentation", which is a different question from "does this ship": it
  returns `docs_only=false` for `.github/workflows` and `e2e/` alike, neither of which Vercel
  serves;
- repository migration max, total, next free number and pending set (`npm run migration:state`);
- hosted migration max as **declared** in [`migration-state.json`](./migration-state.json).

These are derivations from the repository and the Git graph. The **2026-08-30** measurement
boundary recorded below is unchanged: the figures derived there from `bf6f09c4` remain dated
evidence of that reconciliation and are not restated as facts about today. That is why the
ancestry count appears twice — **twenty-nine** through `bf6f09c4` on 2026-08-30, **eighty-one**
through `410e5039` on 2026-09-21 — and why neither number is edited into the other's block.

The 2026-09-21 header rows, preserved verbatim as dated evidence (superseded by the header above):

| Field | Value at the 2026-09-21 sync |
|---|---|
| **Reconciliation date** | **2026-09-20 / 2026-09-21 UTC source sync**; production-data counts elsewhere retain their own older measurement dates. |
| **Current Git branch HEAD at this sync** | **`410e5039d1b11b32c19e752ae2ae278c4b288b8f` — merge of #745.** Re-read GitHub before any production action; this is a dated sync value, not a perpetual pointer. |
| **Last runtime-bearing application HEAD at this sync** | **`410e5039d1b11b32c19e752ae2ae278c4b288b8f` (#745).** This is also the branch HEAD above. `git log --first-parent --merges c6bc5949..410e5039` returns **three** merges, not two: `27a4c960` (#751), which carried **0** application files (`app/`, `lib/`, `components/`) and is documentation-only by the classifier; `c00bcfed` (#753), which carried **0** application files but is **database-bearing** — the classifier returns `docs_only=false`, `database=true`, because it carries migration `0202`, and A3's non-shipping exclusions do not exempt `supabase/migrations/`; and `410e5039` (#745), which carried **2** (`app/(app)/getting-started/page.tsx`, `lib/onboarding/getting-started.ts`). #745 is the latest runtime-bearing head because it merged last, not because #753 carried nothing. #751 is documentation-only and does not move the runtime baseline, but omitting it made the derivation incomplete. The verdict is **A3's composed deployed predicate** — *not documentation* (asked of `scripts/classify-changes.mjs`) **and** *not in a non-shipping root* (`tests/`, `e2e/`, `.github/`, `scripts/`, test-runner and linter configs) — not judgement, and not the classifier alone: it has no "ships" output to borrow. **`scripts/` is not blanket-exempt:** A3 subtracts `PRODUCTION_BUILD_SCRIPTS` — the scripts `package.json`'s `build` actually executes, today `scripts/check-production-env-gates.mjs` — because a script the production build runs can change what the deployment does. |
| **Current Vercel Production deployment evidence** | Vercel commit status for `410e5039…` is **success**. No deployment id, alias/runtime probe or current health measurement is inferred from that status. |
| **Health** | ⚠️ **NOT RE-PROBED AT THIS SOURCE SYNC.** The last probe remains the **2026-08-23** reading: `hone.care` **200** · `/login` **200** · `/dashboard` **307** (auth redirect) · `/api/health` **307**, all non-5xx, `ops_alerts` unresolved **4** (§13). Production has moved substantially since then; this document deliberately does **not** restate a merge-age count. These are dated observations, not current health. |
<!-- canonical-facts:ignore-end -->

### Historical preceding baseline from the 2026-08-30 reconciliation

`4fee652fe67f9fdc06b7d5e719cdb73d5e6d294b` — the PR #649 merge — is preserved here only as the
baseline that preceded the **2026-08-30** reconciliation. It is **not** the predecessor of the
current #745 runtime baseline and must not be used as a current release boundary. The current
production ancestry must be re-read from GitHub at action time.

### What this reconciliation did and did not measure

**This reconciliation is a documentation lane.** It re-derived what can be derived from the
repository and the Git graph, and it re-measured **nothing** in the production database, at
Vercel, or at any provider. It has been refreshed to each production head in turn —
`8418a755` (#648), `5ad81129` (#646) and `4fee652f` (#650, #649) on 2026-08-27, then
`0f07dae6` (#651, #653, #652, #654, #655, #656, #657, #658, #659) on 2026-08-30 — **the
measurement boundary below is unchanged by any of those refreshes — production moving is not
a reason to restate a figure nobody re-read.** Read the two lists as a boundary, not as a
caveat:

**Re-derived on 2026-08-30, from the repository at `bf6f09c4`:**

- the production branch head and the full merge ancestry back to `b9e0003f` (twenty-nine merges);
- the nine merges since the previous baseline `4fee652f`, and that **all nine are
  runtime-bearing** (none is documentation-only), by changed-path analysis;
- which of those merges are runtime-bearing, by changed-path analysis;
- repository migration max, total, next free number and pending set (`npm run migration:state`);
- hosted migration max as **declared** in [`migration-state.json`](./migration-state.json);
- every capability status below that rests on merged source, migrations or tests.

**NOT measured on 2026-08-30, and therefore carried forward with their original 2026-08-23
stamps rather than restated as current:**

- every per-studio row count in §0, and every derived figure that depends on them;
- payment counts, stored payment methods and Connect account status (§7);
- portal, intake and consent counts (§6);
- `ops_alerts` rows and the admin audit event count (§13);
- treatment-image counts (§12);
- HTTP health, and whether Sentry or PostHog is receiving events;
- **any production performance figure.** The PERF-02C measurement recorded in §1 was taken
  on a local stack against a synthetic fixture. Nothing was measured in production, and no
  production latency claim is made anywhere in this document.

A figure with a 2026-08-23 stamp is **evidence of what was true on 2026-08-23**. It is not a
claim about today, and a later reader must re-measure before treating it as one.

### NEW-CLIENT-MODE-01 release — what actually happened on 2026-10-01

**These are operational facts, not a re-pin.** The reconciliation header above is
still the **2026-09-21** sync and still pins `410e5039`; this subsection deliberately
does **not** move it. Re-pinning re-derives every count derived from the pin across
this document, [release-changelog.md](./release-changelog.md) and
[capability-register.md](./capability-register.md) — it is a PROD-TRUTH-class re-sync
and belongs in its own change, as `#756` was. Recording a release while silently
re-pinning would hide one of those jobs inside the other.

**Production has advanced past this document's pin, and that is stated rather than
papered over.** Production has advanced TWICE since the release recorded below — `afb2b509` (**#778**,
waitlist email branding) and then `ce3091e9` (**#777**, waitlist invitation identity).
That is not an aside: it is why re-pinning is its own change rather than a line edit
here, since each advance re-derives every count derived from the pin. Re-read GitHub
before any production action; this sentence is itself a dated observation.

| Fact | Value |
|---|---|
| **Migration `0204` applied** | **2026-10-01.** `supabase db push --linked`, no `--include-all`, pinned CLI `2.102.0`, exit code 0, from the reviewed **#773** head `d8617859`. Hosted max is declared in [`migration-state.json`](./migration-state.json) — **this document still states no migration number.** Full record: [migration-ledger.md](./migration-ledger.md). |
| **#773 merged and deployed** | Merge commit **`d7e712ef`** at `2026-10-01T20:25:16Z`; production deployment `dpl_AQrWznf5fKqLKPZiH4RNCgDFwxsZ`, `READY`, holding `hone.care`, ready `2026-10-01T20:27:33.821Z`. **The migration was applied BEFORE this deploy**, because the new application calls `create_public_appointment_for_new_client` and that function does not exist until `0204` lands. |
| **Willow persisted as WAITLIST** | Stored `new_client_admission_mode` = **`waitlist`**, `set_at` **`2026-10-01T21:35:33.139540Z`** (server-generated). Written by **Willow's own owner** through Settings → Booking, which calls `set_new_client_admission_mode`; `set_by` resolves to a `practitioners` row of that studio with `role = 'owner'`. |
| **Willow's authority source is PERSISTED** | Because the row is stamped, the reader returns `source: "persisted"` before the env bridge is consulted. The legacy list no longer moves Willow. Its effective **admission mode** did not change — measured WAITLIST on the public surface both before and after. ⚠️ **Scope that narrowly:** whether the **commit point** changed at that instant is **UNKNOWN**, because step E never read `NEW_CLIENT_WAITLIST_DURABLE_STUDIO_SLUGS`, and historical waitlist rows cannot establish contemporaneous membership of it. Proven: authority moved. Not proven, and not claimed: that nothing else about the join behaviour moved with it. |
| **Step G passed — a real public durable join** | Entry `ff942ef2-a272-4549-a3b9-c5d000b05b69`, `joined_at` `2026-10-01T22:25:36.347700Z`, `status` `waiting`, `source` `public_booking`, `joined_at_provenance` `form`. Willow entries **48 → 49**, globally **51 → 52** — exactly one row created anywhere. **The row, not the email, was the check.** |
| **Legacy email-only path NOT used** | Proven by the row existing: the email-only path writes no row — **and that proof is about THIS stamped studio's request.** ⚠️ **AN EARLIER REVISION OVERSTATED IT** as *"the deployed submit path contains no call to `isNewClientWaitlistDurableEnabled`, so there is no second commit point left to take"*, and that is **withdrawn**. The env-gate test pins only that `waitlist-actions.ts` makes no **direct** call; the call is **transitive** — `waitlist-actions.ts` → `newClientWaitlistCommitIsDurable` → `isNewClientWaitlistDurableEnabled` — and that branch is still reached for any **unstamped** studio. So **the second commit point is still live for unstamped studios**, which is also what the "both bridges intact" row says. With step-F completeness UNKNOWN, do not read this as licence to retire the bridge. |
| **No appointment, no client record** | Willow appointments **330 → 330**; Willow clients **78 → 78**. Three pre-existing client rows happen to share the synthetic test address (newest created 2026-09-19, none since), and the join did **not** attach or convert to any of them — `converted_at` and `converted_client_id` are NULL. |
| **No Twilio / SMS / provider mutation** | `sms_consent_at`, `sms_consent_source`, `mobile_verified_at` all NULL. The waitlist surface carries no SMS field and the join path contains zero Twilio references. The only provider traffic was the two emails the join itself sends — a studio notification (provider-**accepted**) and a client acknowledgement (no failure logged). |
| **Both legacy bridges still intact** | `envForcesWaitlist` in `lib/booking/new-client-admission.ts` and `lib/booking/new-client-waitlist-durability-bridge.ts` are both present in the deployed tree. **No environment variable was deleted.** Activation step H is **NOT STARTED**. ⚠️ **Its ELIGIBILITY is UNKNOWN, not negative.** H is gated on every studio in `NEW_CLIENT_WAITLIST_STUDIO_SLUGS` being stamped and verified; one studio was, and because step E never read that list it is unknown whether that was all of it — **if it was, H is already eligible.** An earlier revision said "not yet eligible" and derived it from one stamped row; that is **withdrawn**. |
| **ONE studio written; step-F completeness UNKNOWN** | Willow was stamped and verified. The other **six** studios were read as stored `'open'` and **unstamped** on 2026-10-01 and **were therefore governed by the env bridge at that reading**. ⚠️ **Whether they still are is UNKNOWN** — if any of those six owners has since written a mode, the persisted row has already taken authority over from the bridge for that studio. **Re-read the rows before asserting any studio's current authority source.** ⚠️ **There is no denominator, and none may be invented.** Earlier revisions of this row said "1 of 7" and then "of an unknown total"; both still implied the remaining six are step-F work. Step F applies only to studios in `NEW_CLIENT_WAITLIST_STUDIO_SLUGS`, **step E never read that list**, and **unstamped means neither listed nor unlisted**. **STEP_F_COMPLETENESS = UNKNOWN** — if Willow was the list's only member, F is already COMPLETE. Until a studio is stamped its owner **cannot** choose OPEN or CLOSED: the command answers `legacy_waitlist_cutover_required`, and writing `waitlist` is the way out. |
| **Activation step E was NEVER performed** | The live `NEW_CLIENT_WAITLIST_STUDIO_SLUGS` / `NEW_CLIENT_WAITLIST_DURABLE_STUDIO_SLUGS` values were **not read**, so **no slug set is recorded and none may be inferred** — not from which studios are stamped, not from which hold waitlist rows. |
| **Outstanding migration debt** | `public.studios_admission_mode_guard()` received no explicit `REVOKE`, so `anon`/`authenticated`/`service_role`/`PUBLIC` hold `EXECUTE`. **Not exploitable** — return type `trigger`, which PostgreSQL refuses to invoke outside a trigger context — but inconsistent with the discipline `0204` applies to its own five other functions. `0204` is **APPLIED and FROZEN**: this needs a **new migration**, never an edit. |
| **Synthetic step-G entry RETAINED** | `ff942ef2-…` was deliberately **not** removed, pending authorization. **Two dated observations, and nothing claimed after the second.** **(1) 2026-10-01T22:25:36Z, at step-G acceptance:** status **`waiting`**, position **47 of 47** of Willow's Waiting section (`joined_at` ASC, `id` ASC, page size 100 — then the last row on page one), a submitted phone number, no SMS consent. **(2) 2026-10-02T00:14:55Z, controlled invitation-acceptance exercise:** the same entry was **claimed** and then **invited by a practitioner** — status **`invited`**, so it was **no longer in Waiting**; invitation `delivery_disposition` **`accepted`**, stored `expires_at` **2026-10-04T00:14:55Z**, and `redeemed_at`/`declined_at`/`expired_at`/`released_at`/`closed_at` all NULL. **Real inbox receipt was OPERATOR-OBSERVED**; every other fact here is a read-only database reading. ⚠️ **Its state after that instant is NOT asserted** — the expiry is a stored value, not a prediction. An earlier revision said the entry "sits in" Waiting; **withdrawn**, because it was already false when written. **Re-query by id**, never by position or status. **Origin, which does not change: this row was created by a synthetic acceptance test, not by a real prospect, against a real inbox.** **No cleanup was performed in this change.** Whoever acts on it must **re-read the entry and its invitation by id first**; if either is still outstanding at that moment, removal or release is a **separately authorized** action. **This row makes no claim about whether they are outstanding now** — an earlier revision said it "now carries a live invitation", which asserted a present state immediately after promising not to, and is **withdrawn**. |

### Open pull requests are not production

**No open PR is described as shipped anywhere in this document.** At this reconciliation (every row re-read from GitHub on 2026-10-18; the four US/USD rows were added on 2026-10-13 because §7 cites them):

| PR | State | Why it is not production |
|---|---|---|
| **#775** — SMS-NUMBER-SEARCH-01 number lookup | **OPEN**, release candidate | Not merged. No owner can reach a number lookup in production. |
| **#774** — BROWSER-FINDING-01 probe-lot provenance | **OPEN**, and a **DRAFT** | Not merged. |
| **#833** — PAY-CCY-02 (#824 US/USD 2/4): per-studio payment country and charge currency | **OPEN**, and a **DRAFT** | Not merged. Carries the unapplied **0214**; no studio has a payment country in production. |
| **#836** — PAY-CCY-03 (#824 US/USD 3/4): Stripe accounts follow the studio's verified country | **OPEN**, and a **DRAFT**, stacked on #833 | Not merged. No USD Stripe account is provisioned by production code. |
| **#839** — PAY-CCY-04 (#824 US/USD 4/4): money surfaces name the studio's currency | **OPEN**, and a **DRAFT**, stacked on #836 | Not merged. |
| **#847** — PAY-CCY-05 (#824 US/USD): US studio session payment end to end in USD, fake Stripe | **OPEN**, and a **DRAFT**, stacked on #839 | Not merged. US/USD activation remains **PENDING** (§7). |

**2026-10-14 (CANON-REFRESH-2026-10-14): two rows left the table above because the PRs merged.**
`#769` (UX-02 slice 2, SectionLabel across Settings) merged as `82a0e520` and `#776` (UX-02 slice 3,
SectionLabel across session charting) merged as `338014f4`, both on 2026-10-14 and both deployed
(header row *Current Vercel Production deployment evidence*). They were correctly OPEN at the
2026-10-13 sync; this is a state change, not a correction. Their rows as of 2026-10-13 are preserved here:

<!-- canonical-facts:ignore-start reason=preserves-the-2026-10-13-open-rows-for-769-and-776-which-have-since-merged -->
> | PR | State at 2026-10-13 | Why it was not production then |
> |---|---|---|
> | **#769** — UX-02 slice 2, SectionLabel across Settings | **OPEN**, release candidate | Not merged. It was `MERGEABLE`/`CLEAN` throughout the NEW-CLIENT-MODE-01 release and was deliberately **held** so it could not land ahead of #773. |
> | **#776** — UX-02 slice 3, SectionLabel across session charting | **OPEN**, release candidate | Not merged. |
<!-- canonical-facts:ignore-end -->

⚠️ **CORRECTION, 2026-10-01 (NEW-CLIENT-MODE-01 release) — FIVE ROWS WERE REMOVED FROM THE TABLE ABOVE.**
It declared `#752`, `#754`, `#746`, `#750` and `#755` OPEN. **All five had merged** — `1c50bd95`, `c4b0e263`,
`54ad9cf2`, `d59330d1` and `93381b40` respectively, every one of them contained in this history. They are
removed rather than reworded, for exactly the reason PROD-TRUTH-01 gave when it removed `#647`: a merged PR
does not belong in a table about what is *not* production. **This is the same defect recurring, and the
mechanism is worth naming rather than just fixing** — nobody edited these rows to make them false. Production
moved and the rows stayed still, which is why the guard checks the converse direction too and why this
correction will be needed again the next time production advances without this table being re-read. The rows
now listed are the candidates genuinely open at this reconciliation, re-read from GitHub at this sync.

**AND IT RECURRED WHILE THIS VERY CORRECTION WAS BEING WRITTEN.** `#777` was listed as
OPEN in the first draft of the table above and merged as `ce3091e9` before the change
landed, so its row was deleted too. That is not an embarrassing footnote, it is the
measurement: the window in which this table is true is shorter than the time it takes
to edit it, which is the argument for the guard rather than for more careful authors.

⚠️ **CORRECTION, 2026-09-21 (PROD-TRUTH-01) — `#647` WAS REMOVED FROM THE TABLE ABOVE.** It carried two rows
declaring TRUTH-01B-1 open and `#647` a parked draft. `#647` merged on **2026-08-30** as `1d6d7c48` and is
contained in this history, so those rows had been false for three weeks. Describing a merged PR as open is the
same class of defect as the converse, and production advancing creates it by default — which is why the rows
were deleted rather than reworded: a merged PR does not belong in a table about what is *not* production. The
rows now listed are the candidates genuinely open at this reconciliation.

> **No head SHA is recorded for an open PR, deliberately.** An open branch's head moves whenever
> it is pushed to, so a SHA written here is stale the moment it is useful — the same defect this
> reconciliation exists to close, reintroduced in a table about not reintroducing it. This was
> not hypothetical: a draft of this very section pinned `#646` at a head that had already been
> superseded before the section was finished. **The durable property is the relationship, not the
> identifier**: check it with
> `git merge-base --is-ancestor <pr-head> <production-head>`, which answers *is this shipped?*
> whatever the head happens to be today. CI state is likewise omitted — it is a property of a
> SHA, not of a PR, and it is not evidence of deployment in any case.

## 0. Tenant register — real, controlled-test, synthetic

**This section is the canonical classification of every production tenant.** Other documents
reference it; they do not restate it. Every count below is a point-in-time measurement, not a
standing property.

> **The production database contains a sanctioned synthetic tenant.** Its generated rows are
> **never** real-customer activity and must never be added into a customer total. A total that
> mixes them is false even when its arithmetic is right.

*(all counts as of 2026-08-23T23:24:44Z, read-only per-studio query)*

| Studio | Class | Clients | Appointments | Practitioners | Sessions |
|---|---|---|---|---|---|
| `willow-electrolysis` | **Real customer** — the live pilot studio | **72** | **215** | 2 | 99 |
| `my-studio-9d37c5` | **Controlled test** — validation only | 7 | 26 | 2 | 33 |
| `hone-synthetic-twin` | **Synthetic** — sanctioned production test tenant, generated privacy-safe data | 50 | 141 | 1 | 68 |
| `my-studio-6cdef7` | Empty | 0 | 0 | 1 | 0 |
| `samhone` | Empty | 0 | 0 | 1 | 0 |
| `samidc` | Empty | 0 | 0 | 0 | 0 |
| **All tenants** *(includes synthetic — not a customer figure)* | — | **129** | **382** | **7** | **200** |

**Reading rules, which the rest of this document obeys:**

- **Real-customer activity is `willow-electrolysis` only: 72 clients, 215 appointments.**
- **Non-synthetic is not the same as real-customer.** Subtracting the Twin leaves **79 clients
  and 241 appointments**, and that remainder still contains the controlled test studio. Never
  present it as customer activity.
- **All-tenant totals may be quoted only when labelled as including synthetic rows.**
- `hone-synthetic-twin` is long-established and already load-bearing in
  [migration-ledger.md](./migration-ledger.md), which verifies *"Synthetic Twin preserved
  exactly"* at each apply. This register makes that classification canonical for every document.
- `my-studio-9d37c5` is the controlled test studio. That is not inferred from its name: it is the
  only studio with `practitioner_capacity_enabled`, `onboarding_v2_enabled` **and**
  `google_calendar_connection_enabled` true, it holds the single Google Calendar connection, and
  it is named as the test studio in `docs/roadmap/P1_RECONCILIATION_REPORT_2026-07-18.md`.

---

## 1. Charting and treatment memory

**Deployed · enabled for all studios · human acceptance pending.**

Session blocks, observation chips, treatment areas, probe-lot suggestion, and the
*Before Today* / *Treatment Intelligence* surfaces are in continuous operator use.
*(as of 2026-08-23, read-only per-studio query)* **Real-customer charting — Willow:
96 `session_blocks`, 86 `electrolysis_entries`.** Controlled test studio: 12 and 6.
Synthetic Twin: 66 and 1 — **not customer activity**. All tenants: 174 and 93.

The **Phase A charting correction** (PR #479, merge `3cabdca`, **code-only — no migration**)
is deployed and reachable:

- **One unified `Treatment observations & skin response` box.** What were previously two
  separate concepts — *Treatment observations* and *Client / skin response* — are now a
  single multi-select. The canonical constants live in `lib/sessions/charting-labels.ts`.
- **Reaction-driven analytics consume the unified representation.** The dashboard
  *Clients needing attention* card and the treatment-intelligence surfaces read the unified
  chip set, not a separate response field.
- **Legacy `reaction_type` compatibility is preserved.** `session_blocks.reaction_type` is
  folded into the unified set on load and display, so historical rows still surface on
  every reaction-aware surface. Nothing was migrated or rewritten.
- **Galvanic intensity is retired** from current writes and ordinary display.
  `galvanic_intensity_percent` is no longer supplied by any form, is never emitted by the
  write path, and is ignored if a forged spec supplies it. **Historical values are
  preserved** — the column was not dropped and existing rows were not modified.
  *`galvanic_ma` and `galvanic_duration_seconds` remain active galvanic readings.*
- **Exact thermolysis precision.** A stored `0.733` displays as **`0.733 seconds`** — never
  a lossily rounded `0.73`. Trailing zeros are trimmed (`lib/sessions/format-seconds.ts`).
- **Pulse is labeled `Thermolysis pulse count`** and sits inside the thermolysis section,
  in both the block setup form and the simplified entry form.
- **Larger `Additional notes`** field.

**Chloe has not yet performed on-device acceptance of any of the above.**

Also deployed on this baseline: conditional numbing notes (0156, kept only when
`numbing_status='used'`), inventory-backed probe-lot linkage (0155), and the in-form
"Copy settings" prefill (PR #473).

### Clinical read truth — a failed read is never "no history" (CLIN-01-B)

**Implemented · merged (PR #642, `a3b85af2`) · deployed · enabled for all studios.**
**No migration.**

The client profile ran two `session_blocks` reads that consumed `data` and **dropped `error`**,
so a failed read became `null ?? []` — byte-identical to a client with no charted history. Four
surfaces then made affirmative clinical statements nobody had read: *Last visit* said
`No recorded visits yet.`, *Last treatment* said `No charted treatments yet.`, *Treatment
Intelligence* reported every stat as a known zero, and *Before today* reported no watch or plan
notes and a complete procedure record.

The current client profile checks read availability before `hasHistory`: all four surfaces render `unavailable` **before** treating an empty result as absence, and
`session_blocks.caution_for_next_session` / `caution_note` — which reach the practitioner only
through the Watch/Plan band built from that same read — are protected on both the Overview and
Sessions tabs. Read failure now renders *clinical history could not be loaded*. **Re-run on
2026-10-18 through `f9cd9013` (CANON-REFRESH-2026-10-18b):** across `aaf3042b..f9cd9013` (1
merge; #894's changes sit in `components/client-pinned-notes-card.tsx`,
`components/pinned-notes-readonly.tsx`, `e2e/` and `tests/components/`), none of the five files
named below changed. **Re-run on
2026-10-18 through `aaf3042b` (CANON-REFRESH-2026-10-18):** across `6acea261..aaf3042b` (3
merges; #915's changes sit under `docs/production/`, #919's under `.github/workflows/` and
`tests/ci/`, #918's under `lib/analytics/`, `tests/lib/analytics/`, `docs/` and the root
`instrumentation-client.ts`), none of the five files named below changed. **Re-run on
2026-10-17 through `6acea261` (CANON-REFRESH-2026-10-17c):** across `62ff27b2..6acea261` (3
merges; #913's changes sit under `app/(app)/clients/[id]/images/` and `lib/images/`, #912's
under `app/ingest/`, `app/monitoring/`, `lib/observability/` and the root config), none of the
five files named below changed. **Re-run on
2026-10-17 through `62ff27b2` (CANON-REFRESH-2026-10-17b):** across `b08845ce..62ff27b2` (3
merges; #842's changes sit under `app/_components/` and `lib/analytics/`, #891's under
`lib/observability/`), none of the five files named below changed. **Re-run on
2026-10-17 through `b08845ce` (CANON-REFRESH-2026-10-17):** across `ce133c18..b08845ce` (9
merges; only #898 is runtime-bearing, and its changes sit under `lib/billing/`), none of the
five files named below changed. **Re-run on
2026-10-16 through `0ae33bd3` (CANON-REFRESH-2026-10-16b):** across `ce133c18..0ae33bd3` (7
merges, none runtime-bearing), none of the five files named below changed. **Re-run on
2026-10-16 through `1ae096e2` (CANON-REFRESH-2026-10-16):** across `ce133c18..1ae096e2` (5
merges, none runtime-bearing), none of the five files named below changed. **Re-run on
2026-10-14 through `ce133c18` (CANON-REFRESH-2026-10-14):** across `6f7281bb..ce133c18` (5
merges), none of the five files named below changed; #776's changes sit under
`app/(app)/clients/[id]/sessions/`, outside them. **Re-run on
2026-10-13 through `6f7281bb` (CANON-REFRESH-2026-10-13):** across `d5efa20a..6f7281bb` (2
merges), none of the five files named below changed at all. **Re-run again on
2026-10-12 through `d5efa20a` (CANON-REFRESH-2026-10-12):** across `410e5039..d5efa20a` (57
merges), no added or removed line touching `unavailable` or `hasHistory` appears in the five
files named below; the only change among them is two lines of `app/(app)/clients/[id]/page.tsx`,
neither touching the guards. The 2026-09-21 record follows unchanged. **Re-pinned from
the original #659 observation (`0f07dae6`), and verified mechanically rather than assumed — the
comparison was RE-RUN through the current baseline on 2026-09-21, not merely re-pointed: across
`0f07dae6..410e5039`, which now includes #751, #753 and #745, no added or removed line touching
`unavailable` or `hasHistory` appears in any of the five files that carry these guards — `app/(app)/clients/[id]/page.tsx`,
`components/last-visit-card.tsx`, `components/treatment-intelligence-card.tsx`,
`components/before-today-card.tsx` and `components/clinical-unavailable-notice.tsx`. The guards
are unchanged across the interval, so the property carries to the current baseline rather than
being re-asserted at it.**

**Deliberate non-change, recorded so it is not mistaken for a gap:** `attachStructuredAreas`
still **throws** on a `session_block_areas` read failure, surfacing the error boundary. That is
loud, not a false absence, and was left alone.

Since **PR #659 (PERF-02C, merged, `0f07dae6`)** those same reads run differently while saying
the same thing. The clinical-notes summary and the two `session_blocks` reads are mutually
independent, and on the Overview tab they ran as three consecutive awaits; they are now one
`Promise.all` wave, with `attachStructuredAreas` still serial after it because it genuinely
consumes both block reads. **This is a reordering, not a dedupe** — per-tab query counts were
measured identical before and after, not assumed. CLIN-01-B's containment is preserved by
construction: each unit resolves with its own outcome and never rejects, so one read failing
still cannot blank the other's card, and the two unavailability flags and two
`logClinicalReadFailure` event names are unchanged.

**The measurement, with the condition that makes it meaningful.** On a local stack against a
synthetic client carrying **40 sessions and 80 `session_blocks`**, the Overview navigation's
server-render window (`clients → client profile`, response-headers to first useful content)
measured **588 ms → 530 ms, −58 ms**, n=22 per arm, interleaved, reproduced in both A→B
pairings. The parallelism itself was proven at the database rather than inferred from the
clock: sampling `pg_stat_activity` found **zero** instants with the summary and intelligence
reads concurrently active before, and **thirty** after. On a client with **no** charted
history the same change measures ≈0, because both `session_blocks` reads are gated on a
session count and never execute — so the figure is meaningless without its fixture and must
never be quoted bare. **Nothing was measured in production**, and no production latency
improvement is claimed.

**The merged #659 PR body carries an EARLIER measurement, and it is superseded here.**
That body reports `606 ms → 519 ms`, `−88 ms`, `−14.4%`. Those figures are real but they
were taken against `c94258eb`, before the final runtime-head correction; `df9674bb` — the
head that actually merged — was committed afterwards and re-measured, because the fix
changed the runtime blob and a number taken on a superseded blob cannot describe the
shipped one. For shipped-head reporting the canonical figure is the fixture-bound
**588 → 530 ms** recorded above, and the PR-body figures are **not** competing current
evidence. The PR body is history and is deliberately not rewritten. **Neither measurement
was a production latency measurement**; both were local, on the same synthetic fixture,
and no percentage is stated for the final-head run because none was derived for it.

The paired asymmetry check (the Sessions tab, which runs only one of the three units and
should therefore not move) is **inconclusive** rather than passing: the measurement harness
returns to the Overview tab between samples, so that control's own warm-up runs the code path
under test. That is measurement debt in a test-only harness — it ships nothing and no user can
reach it — and it is recorded as such, not as a product regression.

#### The Dashboard half — F2, closed by PR #648

**Implemented · merged · deployed · enabled for all studios. No migration.**

CLIN-01-B closed the **client profile**. The Dashboard *Before today* pipeline had the same
defect on a different pipeline and was **not** covered by it: its four Supabase reads
destructured `data` alone — the token `error` did not appear in
`lib/dashboard/before-today-previews.ts` at all — so a failed read arrived `null`, became `[]`,
and was rendered as an **answer**.

It went unnoticed because the row did not go blank. `pickLastTreatment` accepts a session on its
**live entries** alone, and those ride on the *sessions* read; so when the `session_blocks` read
failed for a client with real charted history, `hasHistory` stayed **true** while every
block-derived field collapsed to empty, and the row kept its confident voice.

All four reads now pass through one wrapper retaining **both** failure channels — PostgREST's
`error`, and a rejected invocation, which never sets `error` at all. Outcomes classify into two
**independent** facts, and the independence is the design:

- the three **clinical** reads are one evidence set → `clinicalUnavailable`;
- the **clients** read carries no clinical evidence → `clientRecordUnavailable`, which suppresses
  only the missing-from-record reminders.

So a failed clinical read never hides true record reminders, and a failed client read never
blanks a history that *was* read. `compactBeforeToday` checks `unavailable` **before**
`hasHistory` — both arrive as `hasHistory: false`, and collapsing them is exactly what lost the
distinction. **Invariant: a failed read is not an empty history.**

**What #648 explicitly does NOT claim, recorded because the claim was withdrawn:**
`DASHBOARD_RETURNING_AS_NEW = NOT_PROVEN`. The recon did **not** prove this failure renders
returning clients as *"New client · No charted history yet"*; the appointment-prep path has
separate error binding. It is not asserted, not tested and not repeated here.

**Still open, and deliberately out of #648's scope — do not read F2's closure as covering them:**

| Item | State |
|---|---|
| **F3** — SQL/JS recency ordering and tie authority | **Separate, confirmed P2. Open.** `ORDER BY`, latest-selection authority, `starts_at`/`created_at` semantics, truncation and tie-breaking are untouched — verified byte-identical to production bar indentation. |
| **F4** — optional-evidence / absence authority | **Latent, deferred.** The architecture is unchanged. |
| **HIST-01A** | Untouched. The `COMPLETE / PARTIAL / EMPTY_PROVEN / UNAVAILABLE` model is deliberately **not** introduced. |

**No migration, schema, RPC, DB policy or provider change**, and no production data mutation —
four runtime files and five test files.

## 2. Whole-session copy

**DB applied · merged · deployed · enabled · PRODUCTION EXERCISED · human acceptance pending.**

Migration **0157** was applied to production **2026-07-27T02:01:29Z**, *before* PR #478
merged at 13:12:34Z — migration-first. The application (PR #478, merge `96b28d6`) is
deployed and there is no feature flag.

Behaviour:

- **Editable ephemeral preview.** "Copy areas & settings from last session" renders a
  preview the practitioner can edit and remove cards from. The preview is component memory
  only.
- **Zero writes before the explicit commit.** Opening, editing or abandoning the preview
  creates nothing.
- **One atomic commit.** A single CTA reaches the server, which validates canonically and
  calls `copy_session_setup` — one transaction creating the reviewed destination records.
- **Source locking and stale-source rejection.** The commit carries an expected source
  session id and fingerprint; a source that changed underneath is refused.
- **Idempotency and a provenance ledger.** `session_copy_operations` records each operation
  under a `(target_session_id, idempotency_key)` UNIQUE, so a retry or double-submit is an
  at-most-once no-op.
- **Reusable setup only.** **Minutes and outcomes are never copied.**
- **Galvanic intensity is forced to a literal `NULL`** at the destination, and is excluded
  from the source fingerprint — so a forged spec cannot reintroduce it.

**Production exercise: yes** *(measured 2026-08-23; not re-measured since)*. `session_copy_operations` held **24 rows, all 24 on
`willow-electrolysis`**, from **2026-07-28T20:39:54Z** through **2026-08-23T19:40:49Z**
*(as of 2026-08-23, read-only query)*. The commit path and the provenance ledger have executed
repeatedly against real production data at Willow.

**What those 24 rows do NOT evidence.** They are **all accept-path commits**. The idempotency
guarantee is **enforced by the reviewed database contract** — the `(target_session_id,
idempotency_key)` UNIQUE in migration 0157 — but **no production duplicate-retry event has been
isolated**, and neither has a **stale-source rejection**. The guarantee is not weakened by this;
it is simply not *separately production-exercised*, and this document does not claim it is. Same
boundary as [known-limitations.md](./known-limitations.md) L2 and
[capability-register.md](./capability-register.md) §2.

<!-- canonical-facts:ignore-start reason=quotes-the-superseded-zero-row-claim -->
> **Corrected 2026-08-23.** This section previously read *"Production exercise: none —
> `session_copy_operations` holds 0 rows"*, and instructed readers not to call the feature
> production-exercised. That was written at the 2026-07-27 reconciliation and was true then.
> It stopped being true on 2026-07-28 and stayed in the document for roughly four weeks while
> 24 real operations accumulated. The original deployment verification did deliberately perform
> zero copy operations; that fact is preserved, and it is now history rather than current state.
<!-- canonical-facts:ignore-end -->

**This is exercise, not acceptance.** Chloe has not confirmed that she has used the feature and
accepts its behaviour, and 24 operations do not establish that she has. Human acceptance remains
**pending** — see §15 and [known-limitations.md](./known-limitations.md) L1.

## 3. Clinical finalization, corrections and amendments — RETIRED

**RETIRED by product decision (2026-07-29) and enforced in production by migration 0159, applied
and verified 2026-07-30.** Signed and
cryptographically finalized clinical records are **not a Hone product capability**. Treatment
sessions are ordinary, editable operational records, and practitioners correct charting mistakes
by editing them through the normal charting commands. Full reasoning, the retained legacy
artifact and the reintroduction bar:
**[../decisions/clinical-finalization-retired.md](../decisions/clinical-finalization-retired.md)**.

| | State |
|---|---|
| Phase 1 — finalization boundary (0119) | **RETIRED.** `clinical_finalization_enabled` is **false on every studio** (verified across all six, 2026-08-23) and is pinned false by CHECK constraint `studios_clinical_finalization_retired` — no role can turn it on. `EXECUTE` on `finalize_session` is revoked from every runtime role, and `sessions_guard_retired_finalization` refuses any transition into `finalized`/`void`. Historically production-exercised **exactly once**, on the controlled non-Willow test studio (1 finalized session + 1 snapshot, hash still re-deriving, retained unchanged). **Willow: 0 non-draft sessions, ever.** |
| Phase 2 — corrections & amendments backend (0120) | **RETIRED.** `clinical_corrections_enabled` is **false on all studios** and pinned false by `studios_clinical_corrections_retired`. **Never production-exercised** — 0 amendments, 0 clinical audit events, and `INSERT` is now refused on all three signed-record ledgers, so none can ever be produced. The generic 3-field correction UX was never approved, and no full-chart correction workspace will be built. |
| Reliability/observability (PR #402) | **RETIRED with Phase 2.** The amendment path it instrumented is unreachable. |
| Practitioner-facing Finalize / signed-record Correction controls | **REMOVED — both from the database and from the deployed source.** Migration 0159 pinned both flags `false` by validated CHECK constraint and revoked `EXECUTE` from every runtime role; PR #482 then deleted `FinalizeSessionCard`, `RecordVersionsPanel`, `finalize-actions.ts` and `correction-actions.ts`, and deployed successfully on 2026-07-30 (merge `d77d44346addd98f4829f757531011bc7ca0c0d1`). There is no Finalize or signed-Correction surface in the running application, and no runtime role can invoke the RPCs. |
| Append-only clinical notes (0126/0127) | **Live for all studios, no flag** — **Willow 52, Synthetic Twin 3, 55 all-tenant** *(last measured 2026-08-23; not re-measured at this reconciliation)*. **Unrelated to the above and NOT retired** — a correction here is a new row (`supersedes_note_id`), never a signed snapshot. |

**Migration 0159 drops nothing.** The 0119/0120 objects stay in place so those migrations remain
replayable, and the guards that protect the one legacy artifact are deliberately kept on. The
deployed backend — immutable snapshots, version lineage, `clinical_audit_events` and append-only
RLS — **is preserved and must not be weakened**, but
**not** so finalization can be enabled later: it is preserved because it keeps the legacy
evidence immutable, keeps the retirement fail-closed, and forbids `authenticated` `TRUNCATE` and
any write to the three signed-record ledgers. **One 0120 mechanism was deliberately NOT preserved:**
the `hone.correction_session_id` GUC permit is **removed** — `set_config` on a custom placeholder is
available to any role, so once the correction RPCs were `EXECUTE`-revoked the permit stopped being a
guarded escape and became an open one (reproduced as plain `authenticated`). Verified gone in
production: the guard body no longer references it, or `current_setting` at all. It does NOT stop
ordinary direct DML.

> ⚠️ **CORRECTED 2026-08-26.** This passage previously continued: *"`authenticated` still holds
> row INSERT/UPDATE/DELETE on `sessions`, `session_blocks`, `electrolysis_entries`,
> `laser_entries` and `treatment_images`, restricted only by RLS to same-studio rows — see
> known-limitations L18."* **That was true when written and is false at `6786b07b`.** Migration
> **0169** (applied 2026-08-03) revokes `insert, update, delete` from `authenticated` on all six
> of those tables by name; `authenticated` retains **SELECT only**, and every writer goes through
> one of the sixteen reviewed commands. **L18 is CLOSED**, so the sentence and the reference it
> cited contradicted each other on a security boundary — a reader auditing the write surface got
> opposite answers from two canonical documents. The correct statement is that the removed GUC
> permit was never what stopped direct DML; **0169** is. Ordinary operational audit trails
(`session_audit`, `record_keeping_audit_events`, `session_copy_operations`,
`admin_action_events`, `client_portal_access_events`), actor attribution, timestamps,
treatment-history integrity, whole-session-copy provenance and tenant isolation are all
**retained**. `clinical_audit_events` is **not** one of those — despite its name it records only
signed-record corrections/amendments and is retired with the rest.

Reintroducing finalization is **not a backlog item**. It would require a new explicit product
decision, an architecture review, a legal/privacy review, a migration plan and fresh acceptance.

## 3b. Clinical record lineage — ENFORCED IN PRODUCTION (migration 0160)

**The same-studio wrong-client / wrong-encounter re-parenting defect is closed: database-enforced,
deployed and production-verified.** Migration `0160_immutable_clinical_lineage.sql` was applied on
**2026-07-30T17:52:48Z–17:52:51Z**, SHA-256
`e56a1ee7efc95e561cd17a0c33750ee4aaaf2a956f425576af39ce4a0e6094d4`. It ran inside an **explicit
`BEGIN` / `SET LOCAL lock_timeout` / `COMMIT` transaction** and completed **without** the `SET LOCAL`
warning (SQLSTATE 25P01) that migration 0159's apply produced, and without any lock timeout (55P03).

**The defect it closed.** RLS correctly refuses a cross-*studio* move, but *within* a studio the member
policies are `using (is_studio_member(studio_id)) with check (is_studio_member(studio_id))`, and that
predicate still holds after a parent changes — so a raw PostgREST `PATCH` could move a whole treatment
session onto another client's chart, or move a settings block (and its structured areas) onto another
client's encounter.

**Protected identity fields** — pinned immutable on `UPDATE`, verified live in production:

| Column | Rule |
|---|---|
| `sessions.client_id` | immutable once the row exists |
| `sessions.studio_id` | immutable once the row exists |
| `session_blocks.session_id` | immutable once the row exists |
| `session_blocks.studio_id` | immutable once the row exists |
| `electrolysis_entries.session_id` | immutable once the row exists |
| `electrolysis_entries.block_id` | **clearable only to `NULL`** (the `ON DELETE SET NULL` cascade); never re-pointed at another block |
| `laser_entries.session_id` | immutable once the row exists |

Two `SECURITY INVOKER` trigger functions with `search_path` pinned empty
(`guard_immutable_clinical_lineage`, `guard_clearable_clinical_lineage`), driven by trigger-defined
`TG_ARGV` — never by browser input — plus five `BEFORE UPDATE OF …` row triggers, all enabled, each
present exactly once. `treatment_images` is deliberately **not** re-guarded: migration 0093's
`treatment_images_enforce_integrity` already enforces the stronger identity contract and remains enabled.

**Ordinary charting remains fully editable.** Notes, structured settings, areas and laterality, machine
values, probe information, numbing, observations, timings, pricing, aftercare, sort order and
soft-delete are all untouched — 0160 pins **no** clinical-content column. The correct remedy for a
mis-filed session is still soft-delete plus re-chart on the right client, which leaves an
actor-attributed audit trail instead of silently rewriting history.

**No signed-record capability returned.** 0160 adds no snapshot, no finalization, no signed correction
and no `record_status` logic — see §3.

**What 0160 changed, and did not.** It changed **no business data** (all row counts and lineage
checksums identical across the apply window, nothing created), **no RLS policy**, **no table grant**,
**no application configuration** and **no provider state**. Its two trigger functions carry the default
`PUBLIC` EXECUTE that every other guard trigger function in this schema carries; that is inert, because
PostgreSQL refuses direct invocation (`0A000: trigger functions can only be called as triggers`).

> **0160 does not close all clinical write risks.** It closes *re-parenting*, and nothing more.
> The residual clinical-write limitations are **L18**, **L19**, **L20** and **L21**, and
> **[known-limitations.md](./known-limitations.md) is canonical for whether each is open or
> closed** — this paragraph names them, it does not adjudicate them. As of 2026-08-23: **L18 is
> CLOSED** (migration `0169`, 2026-08-03, `authenticated` clinical write grants 12 → 0); **L19**,
> **L20** and **L21** remain **OPEN**. `sessions.treatment_plan_id` and `sessions.appointment_id`
> remain same-studio but **not** same-client validated.
>
> *This paragraph previously ended "All remain open", which stayed false for three weeks after
> `0169` closed L18. Restating another document's status is what made that possible, so the
> status now lives in one place and this one points at it.*

## 4. Probe inventory and record keeping

**Deployed · enabled · in use.** Sterile items, disinfectants and exposure incidents with
audit — **Willow: 8 `record_keeping_sterile_items` rows** *(as of 2026-08-23)*; Synthetic Twin
holds a further 5, which are not customer activity. Exposure-incident history is **owner-only**.
Overdue-disinfectant "Replace now" alerts are computed at read time and auto-resolve.

Migration 0155 adds a durable, probe-specific, same-studio link from a charted block to a
sterile-inventory item (pointer-only, `ON DELETE SET NULL`, frozen snapshot). No production
block carries a link yet. The legacy `probe_lots` table stays **dormant**.

## 5. Booking and calendar

**Deployed · enabled · in continuous use** — **215 appointments at Willow**, the live studio
*(as of 2026-08-23; see §0 for the full tenant register — the all-tenant figure includes
synthetic rows and is not a customer number)*.

Public booking (service selection, availability scan, intake gating, hashed-token
manage/cancel/reschedule), the practitioner calendar (mobile single-day timeline; desktop
week/month with preview drawer), atomic same-record **Move appointment** (0133), and
backward-packed slot anchoring with source-aware conflicts.

**Migration 0152** makes actual treatment overlap a **HARD** database constraint while the
configured buffer becomes a **SOFT** constraint an authenticated internal owner may
override. An owner override bypasses the buffer only — never a real overlap.

**The direct new-client consultation booking route is `Deferred by product decision`
(2026-07-27).** It is not built, not a launch blocker, and not the next engineering task.

**That deferral is not the whole picture for new-client intake — see §5b.** New-client booking at
Willow is currently **refused and routed to a waitlist**, which is a different capability from a
direct booking route and is live today.

## 5b. New-client waitlist (admission control)

### 2026-09-20 Level 3 WAIT checkpoint — TOP PRODUCT PRIORITY

**Decision scope:** this is a product-priority and shipped-software reconciliation. It is **not**
a customer-message, provider-effect, migration or launch-acceptance authorization.

At this checkpoint the production branch contains the following WAIT tranche:

| Layer | Shipped production software | What it establishes | What it does **not** establish |
|---|---|---|---|
| **Level 1 — durable queue** | Existing WAIT-02B durable queue + owner lifecycle/manual/legacy tools | A studio-scoped durable waiting list exists; Willow was collecting on it throughout the last measured interval. | Present allowlist configuration, complete historical reconciliation or Chloe acceptance. |
| **Level 2 — Invite-to-book core** | #708/#709/#713 core; **#741/#747** redeemed-no-booking exit; **#748** 48-hour invitation **default** | Scoped email invitation, proof-bound Book/Decline, atomic booking/conversion, lifecycle exits, a 48-hour default, and a safe operator exit after redemption without booking. | **Fixed/no-choice 48h policy remains open** because the composer still permits alternate TTLs; the full four-response Chloe taxonomy, WAIT-specific 24h reminder, dual-channel delivery and Willow real-client acceptance also remain open. |
| **Level 3 — Full WAIT Operating System** | **NOT COMPLETE — now Hone's top product priority.** | The required finish line is explicit and bounded. | It must not be inferred from Level 1/2 software being deployed. |
| **SMS sender visibility** | **#749**, read-only owner status on Settings → Integrations | An owner can see whether Hone has a recorded studio sender and its truthful state; UNKNOWN/read-failed stays distinct. | No provisioning, purchase, adoption, release, #716 routing cutover or WAIT SMS. The shared fallback is unchanged. |

**Level 3 exit contract:** retrospective Willow queue/provenance reconciliation + trustworthy
owner discoverability/control → WAIT-04B durable rich profile and completion authority → verified
mobile + waitlist-prospect STOP/suppression → supported studio sender provisioning/adoption/test +
real Willow sender proof → **fixed 48-hour policy with no practitioner expiry choice** → email + eligible SMS as one invitation opportunity → WAIT-specific
24-hour reminder → all four recipient response choices → first-consult cancellation/reschedule/
no-show/exception boundaries → Chloe real-device acceptance.

**Controlled use before Level 3:** the shipped email Invite-to-book core may be exercised only under
the normal current release/activation gates. Before any real Willow send, confirm the current
waitlist gate and delivery posture from their authorities. This section does not infer a current
allowlist value, a real Willow invitation, a provider send or human acceptance.


Two different things share this name. They are at **different stages** and must not be merged
into one status sentence.

### WAIT-01 — the email-delivered waitlist. SUPERSEDED at Willow; the FALLBACK path.

**Implemented · merged (PR #601) · deployed · admission gate WAS enabled for one studio at every
measured instant · its EMAIL COMMIT POINT no longer served any studio.**

> ⚠️ **CORRECTED 2026-09-19.** This section was headed *LIVE at Willow* and read as though the
> email were still Willow's commit point. The **admission gate** below is indeed still on for
> Willow at every measured instant — that part is unchanged and is why new-client booking was
> refused throughout. (`isNewClientWaitlistEnabled` re-reads that variable per call too, so rows
> bound the gate's state exactly as weakly as they bound the durable flag's.) What changed is
> what happens next: `app/book/[slug]/waitlist-actions.ts:562` routes a studio named on **both**
> allowlists to the durable branch, and Willow was on both at every measured instant from on or
> before 2026-08-25 to 2026-09-15.
> So for Willow the email was a **notification** and the row the record, at every measured
> instant. WAIT-01's commit point applies to a waitlisted studio outside the durable allowlist;
> **no such studio existed at any measured instant, and that is a dated observation, not a
> statement about route occupancy now.** ⚠️ **THAT APPLIES ONLY TO A STUDIO THAT IS NOT CUT OVER.** Since 2026-10-01T21:35:33.139540Z Willow's mode is **persisted**, and `newClientWaitlistCommitIsDurable` (`lib/booking/new-client-waitlist-durability-bridge.ts`) returns true at its cut-over check **before** it consults `NEW_CLIENT_WAITLIST_DURABLE_STUDIO_SLUGS`. **Clearing or emptying that list therefore cannot return a cut-over studio to WAIT-01 email-only** — it governs only studios still on the legacy bridge. An operator who clears it expecting a commit-point rollback at Willow would believe the rollback succeeded while durable rows kept being written. **AND THERE IS NO COMMIT-POINT ROLLBACK FOR A CUT-OVER STUDIO AT ALL.** An earlier revision of this note said "rolling a cut-over studio back is a row write through `set_new_client_admission_mode`", which conflated changing its ADMISSION MODE with restoring its COMMIT POINT, and is **withdrawn**. (1) For **NEW-CLIENT ADMISSION AND COMMIT-POINT ROUTING**, clearing or emptying either env list affects **only a studio still on the legacy bridge** — ⚠️ **but that is scoped to new-client routing and is NOT a statement that env edits are inert at a stamped studio.** `NEW_CLIENT_WAITLIST_STUDIO_SLUGS` is read **independently** by EMERG-01's free-consult reschedule restriction (`isFreeConsultWaitlistOnlyReschedule` → `isNewClientWaitlistEnabled`), which never consults `new_client_admission_mode`. Editing that list at a **cut-over** studio therefore still changes whether an **already-confirmed free consultation** can be self-service moved. Deliberately so: an owner changing new-client admission must not move the rights of a confirmed appointment; (2) `set_new_client_admission_mode` is the supported way to change a cut-over studio's **ADMISSION MODE**; (3) ⚠️ **RESTORING A CUT-OVER STUDIO TO WAIT-01 EMAIL-ONLY COMMIT SEMANTICS IS NOT SUPPORTED BY ANY EXISTING MECHANISM** (a consequence of the three-mode set and the bridge's own law, derivable from source rather than measured) — `waitlist` keeps it durable *by law*, `open` / `closed` remove the waitlist rather than making it email-only; (4) **a mode transition is NOT a commit-point rollback** and must never be described as one. Restoring email-only would need a **new, explicitly designed and supported mechanism**, not an operator workaround.
> An earlier revision said *"clearing the allowlist re-routes Willow through WAIT-01 on the very
> next request"*; that was true while Willow sat on the legacy bridge and is **withdrawn** now that
> it does not.

New-client booking at Willow was **refused and routed to a waitlist** at every measured instant.
This is admission control:
a studio whose existing treatment clients cannot be served on a clinically useful cadence stops
accepting brand-new consultations, because each new client consumes capacity already spoken for.

- Gated by the server-only env var `NEW_CLIENT_WAITLIST_STUDIO_SLUGS`, **present on the Vercel
  Production target and no other** *(verified 2026-08-23 by reading variable **names** only — no
  value was read, and none is recorded here)*.
- `GET /book/willow-electrolysis` returns **200** and renders `newClientWaitlistEnabled: true`
  *(verified 2026-08-23)*.
- **The commit point is the studio notification email, not a database row.** Under WAIT-01 a
  waitlist request is delivered; it is not stored.
- Default OFF, exact-slug match only. Clearing the env var is the entire kill switch **for a studio still on the legacy bridge, and is NOT a kill switch for a cut-over studio**. ⚠️ **THAT WAS TRUE WHILE EVERY WAITLISTED STUDIO SAT ON THE LEGACY BRIDGE, AND IS NOT TRUE OF A CUT-OVER STUDIO.** Since 2026-10-01T21:35:33.139540Z Willow's mode is **persisted**, and the admission reader answers a stamped row before the env bridge is consulted — so clearing the env var does **not** switch new-client admission off at a cut-over studio, and `newClientWaitlistCommitIsDurable` likewise returns true at its cut-over check before reading the durable list. **`set_new_client_admission_mode` changes a cut-over studio's ADMISSION MODE, and that is not the same thing as a commit-point rollback.** **THE CONTRACT, IN FULL, BECAUSE A PARTIAL VERSION IS WHAT WENT WRONG HERE:** (1) for **NEW-CLIENT ADMISSION AND COMMIT-POINT ROUTING**, clearing or emptying either env list affects **only a studio still on the legacy bridge** — ⚠️ **but that is scoped to new-client routing and is NOT a statement that env edits are inert at a stamped studio.** `NEW_CLIENT_WAITLIST_STUDIO_SLUGS` is read **independently** by EMERG-01's free-consult reschedule restriction (`isFreeConsultWaitlistOnlyReschedule` → `isNewClientWaitlistEnabled`), which never consults `new_client_admission_mode`. Editing that list at a **cut-over** studio therefore still changes whether an **already-confirmed free consultation** can be self-service moved. Deliberately so: an owner changing new-client admission must not move the rights of a confirmed appointment; (2) `set_new_client_admission_mode` is the supported way to change a cut-over studio's **ADMISSION MODE**; (3) ⚠️ **RESTORING A CUT-OVER STUDIO TO WAIT-01 EMAIL-ONLY COMMIT SEMANTICS IS NOT SUPPORTED BY ANY EXISTING MECHANISM** (a consequence of the three-mode set and the bridge's own law, derivable from source rather than measured) — `waitlist` keeps it durable *by law*, and `open` / `closed` remove the waitlist rather than making it email-only; (4) **a mode transition is therefore NOT a commit-point rollback**, and must never be described as one. Restoring email-only would need a **new, explicitly designed and supported mechanism**, not an operator workaround.
- Release record: [releases/2026-08-19-willow-new-client-waitlist.md](./releases/2026-08-19-willow-new-client-waitlist.md).

### WAIT-02B Stage A — the durable waitlist. ACTIVATED and collecting at every measured instant (2026-08-25 – 2026-09-15).

**Implemented · merged (PR #629, `48f02389`) · DB applied (migration 0185) · deployed ·
WAS ACTIVATED for `willow-electrolysis` at every measured instant · production exercised
(joining only).** ⚠️ **Dated evidence, not current configuration** — the bound is
2026-08-25T22:27Z through 2026-09-15; see the paragraph in Stage B1 below for why committed rows
cannot report the present. Owner device acceptance is **still outstanding** and is not implied by
any row below.

> ⚠️ **CORRECTED 2026-09-19 (WAIT-DOCS-RECON).** Every bullet in this subsection previously
> described the durable path as deployed-but-dark, switched on for no studio at all. Production
> had disproved that for roughly three weeks. The superseded text is preserved verbatim in the
> frozen block at the end of this subsection rather than deleted.

- The durable table `new_client_waitlist_entries` and both commands
  (`join_new_client_waitlist`, `remove_new_client_waitlist_entry`) **exist in production
  schema**. Migration 0185 is applied and frozen — evidence in
  [migration-ledger.md](./migration-ledger.md).
- **The table held 31 rows when measured 2026-09-19** *(read-only hosted query)* — **28 of them
  for `willow-electrolysis`**: 27 `waiting` and 1 `removed`, the remaining 3 on the controlled
  test studio. ⚠️ That is evidence **for 2026-09-19** and is not a claim about today. It does
  prove the table is **not** empty and that prospect data **is** being collected.
- **Oldest durable Willow entry: 2026-08-25T22:27Z; most recent: 2026-09-15.** Activation
  therefore happened on or before 2026-08-25 — a **bound**, not a timestamp. The activating act
  itself was not recorded and **no production release record for it exists**; see
  [known-limitations.md](./known-limitations.md) **L25**.
- **`NEW_CLIENT_WAITLIST_DURABLE_STUDIO_SLUGS` NAMED `willow-electrolysis` at every instant a
  durable row was written** — earliest 2026-08-25T22:27Z, latest 2026-09-15 — **established
  STRUCTURALLY rather than by reading the variable.** The value is Sensitive and was **not**
  read. Every one of the 31 rows carries `source = 'public_booking'`, which migration 0193's
  CHECK constraints make exclusive to the public path; its only writer is
  `join_new_client_waitlist`, whose only caller is reached solely when **both**
  `isNewClientWaitlistEnabled` and `isNewClientWaitlistDurableEnabled` return true.
- ⚠️ **THAT IS A BOUND, NOT A CURRENT READING, and the distinction is load-bearing.** A row is
  durable and outlives the flag; `lib/booking/new-client-waitlist.ts` re-reads `process.env` on
  every call, so for a studio **still on the legacy bridge** clearing the variable returns new
  submissions to WAIT-01 **immediately** — but **not for a cut-over studio**, whose persisted mode
  is answered before the list is read (see the cut-over note in §5b) — while
  every row already written stays exactly where it is. **A persisted row can never prove present
  configuration.** This document previously over-read the same evidence in the opposite
  direction — carrying a dated *absence* forward as a standing posture — and asserting a dated
  *presence* as the current value is the same error wearing the other sign.
- **Willow's public booking page served the durable commit point** at every measured instant
  above, rather than the WAIT-01 notification behaviour. To learn what it serves **now**, confirm
  it in the product.
- **The application code shipped FIRST and DARK** — the reverse of the migration-first ordering
  used for 0183/0184. That was deliberate: WAIT-01 was already live, so shipping the durable path
  on the existing flag would have moved a live studio's commit point with no operator GO in
  between, and clearing the gate list to keep it dark would have reopened new-client booking —
  the exact failure the gate exists to prevent. **That dark period has ended.**
- **The public privacy policy covers the three fields actually collected** (name, email, optional
  phone) and no others. It is **not** yet widened for WAIT-04B's proposed profile fields, which
  are not collected and must not be described as though they were.

<!-- canonical-facts:ignore-start reason=preserves-the-superseded-deployed-dark-waitlist-subsection-verbatim -->
> **SUPERSEDED 2026-09-19, preserved verbatim.** This subsection formerly read:
> *"WAIT-02B Stage A — the durable waitlist. DEPLOYED DARK. Reachable by nobody. … NOT ENABLED ·
> NOT production exercised. … **The table held 0 rows when last measured.** It held 0 at apply
> verification and **0 on 2026-08-23** (read-only query), and **has not been re-measured since**.
> … This row used to read 'holds **0 now** … **No prospect data is being collected**', which
> converted a dated measurement into a standing fact. … **`NEW_CLIENT_WAITLIST_DURABLE_STUDIO_SLUGS`
> is absent from the Vercel Production environment** (verified 2026-08-23, variable names only).
> **No studio is enabled. Willow is not enabled.** Willow's public booking page continues to serve
> the WAIT-01 behaviour above. … **The public privacy policy is unchanged.**"*
>
> It was true when written and false by 2026-08-25. The failure was not the measurement but the
> **carrying forward of a dated absence as a standing posture** — the same defect this document
> had already named one paragraph earlier and then committed again in the next bullet.
<!-- canonical-facts:ignore-end -->

### WAIT-02B Stage B1 — disclosure shipped, and since ACTED ON. SHIPPED · ACTIVATION TAKEN.

**Implemented · merged (PR #637, `1013a97b`) · deployed · ONE STUDIO WAS ENABLED at every
measured instant · production exercised (joining only).** **No migration.** Merging it enabled nothing by itself; the activation was a
**separate, later operator act** against the runtime allowlist, bounded to on or before
**2026-08-25** by the oldest durable Willow row.

Stage B1 changed **two** things, and the difference between them matters:

1. **The public privacy notice now covers waitlist prospects.** `app/privacy/page.tsx` names
   **Prospective clients** as a covered category, describes what the waitlist form collects,
   states the purpose, says the request goes to one studio and no other, gives an account-free
   removal route, and describes waitlist retention. Policy `effectiveDate` **May 22, 2026**,
   `lastUpdated` **August 24, 2026** *(read from the deployed source at `6786b07b`)*. This is
   the defect Stage A's blanket prohibition existed to hold shut, and it is now closed.
2. **The Stage-A build prohibition is GONE, replaced by a Stage-B configuration report.**

> ⚠️ **CORRECTION — this section previously said the opposite, and it was carried forward
> unverified.** It stated that *"a Vercel production build fails while
> `NEW_CLIENT_WAITLIST_DURABLE_STUDIO_SLUGS` enables one or more studios"* and that the gate has
> *"no bypass and no per-studio exception."* **Neither is true at `6786b07b`.** Gate 4 of
> `scripts/check-production-env-gates.mjs` is now **report-only** and its pinned contract says so
> in its own first two sentences: *"Gate 4 is report-only. It does not fail the build solely
> because of `NEW_CLIENT_WAITLIST_DURABLE_STUDIO_SLUGS`."* A reader relying on the old sentence
> would believe a build-time stop still guards prospect collection. It does not.

**What guards activation now is runtime membership, and it takes TWO allowlists, not one.**
Gate 4's contract, sentence 9: *"Naming a studio in `NEW_CLIENT_WAITLIST_DURABLE_STUDIO_SLUGS`
activates nothing unless that studio is also named in `NEW_CLIENT_WAITLIST_STUDIO_SLUGS`."* The
durable variable selects the **commit point** for a studio that is *already* on the admission
waitlist; it cannot by itself put a studio onto one. An empty durable allowlist leaves every
**studio still on the legacy bridge** on the non-durable (WAIT-01, email) path. ⚠️ **THAT APPLIES ONLY TO A STUDIO THAT IS NOT CUT OVER.** Since 2026-10-01T21:35:33.139540Z Willow's mode is **persisted**, and `newClientWaitlistCommitIsDurable` (`lib/booking/new-client-waitlist-durability-bridge.ts`) returns true at its cut-over check **before** it consults `NEW_CLIENT_WAITLIST_DURABLE_STUDIO_SLUGS`. **Clearing or emptying that list therefore cannot return a cut-over studio to WAIT-01 email-only** — it governs only studios still on the legacy bridge. An operator who clears it expecting a commit-point rollback at Willow would believe the rollback succeeded while durable rows kept being written. **AND THERE IS NO COMMIT-POINT ROLLBACK FOR A CUT-OVER STUDIO AT ALL.** An earlier revision of this note said "rolling a cut-over studio back is a row write through `set_new_client_admission_mode`", which conflated changing its ADMISSION MODE with restoring its COMMIT POINT, and is **withdrawn**. (1) For **NEW-CLIENT ADMISSION AND COMMIT-POINT ROUTING**, clearing or emptying either env list affects **only a studio still on the legacy bridge** — ⚠️ **but that is scoped to new-client routing and is NOT a statement that env edits are inert at a stamped studio.** `NEW_CLIENT_WAITLIST_STUDIO_SLUGS` is read **independently** by EMERG-01's free-consult reschedule restriction (`isFreeConsultWaitlistOnlyReschedule` → `isNewClientWaitlistEnabled`), which never consults `new_client_admission_mode`. Editing that list at a **cut-over** studio therefore still changes whether an **already-confirmed free consultation** can be self-service moved. Deliberately so: an owner changing new-client admission must not move the rights of a confirmed appointment; (2) `set_new_client_admission_mode` is the supported way to change a cut-over studio's **ADMISSION MODE**; (3) ⚠️ **RESTORING A CUT-OVER STUDIO TO WAIT-01 EMAIL-ONLY COMMIT SEMANTICS IS NOT SUPPORTED BY ANY EXISTING MECHANISM** (a consequence of the three-mode set and the bridge's own law, derivable from source rather than measured) — `waitlist` keeps it durable *by law*, `open` / `closed` remove the waitlist rather than making it email-only; (4) **a mode transition is NOT a commit-point rollback** and must never be described as one. Restoring email-only would need a **new, explicitly designed and supported mechanism**, not an operator workaround.

**Activation bound: one studio WAS activated at every measured instant**, 2026-08-25T22:27Z
through 2026-09-15. Established from **committed rows**: 28 durable `willow-electrolysis`
entries, all `source = 'public_booking'` *(read-only hosted query, 2026-09-19)*. The allowlist
value is Sensitive and was **not** read; see the structural derivation in Stage A above.

⚠️ **THERE IS NO CURRENT POSTURE RECORDED HERE, AND THAT IS DELIBERATE.** This paragraph opened by naming a
current posture — activated, one studio — and derived it from those rows. Rows are durable
and outlive the flag, and `lib/booking/new-client-waitlist.ts` re-reads `process.env` on every
call — so if the variable was cleared after 2026-09-15, every row above still exists while no
studio is activated at all. **Committed rows can bound an activation in time; they can never
report present configuration.** Confirm that in the product.

<!-- canonical-facts:ignore-start reason=preserves-the-superseded-not-activated-posture-paragraph -->
> **SUPERSEDED 2026-09-19, preserved verbatim.** This paragraph formerly read:
> *"**Current posture: NOT ACTIVATED.** `NEW_CLIENT_WAITLIST_DURABLE_STUDIO_SLUGS` was **absent
> from the Vercel Production environment** when last read (2026-08-23, variable names only) and
> was **not re-read on 2026-08-26** — so absence is carried forward as dated evidence, not
> re-asserted. **Willow is not enabled on the durable path** and continues to serve WAIT-01."*
>
> And: *"**Stage B2 — activation — has not been granted and remains blocked.**"* Activation was
> in fact taken. Whether it carried the explicit per-studio GO and activation smoke that Stage B2
> required **is not established by any repository artefact**, and is not asserted either way here.
<!-- canonical-facts:ignore-end -->

**Stage B2 — activation — WAS TAKEN, and its governance record is missing.** Stage B2 required an
explicit per-studio operator GO and a human activation smoke. The activation happened; **no
release record, ledger entry or smoke result for it exists in this repository.** That gap is the
open item — not the activation. Tracked as **L25** in
[known-limitations.md](./known-limitations.md).

> **The durable waitlist WAS ACTIVATED at every measured instant, and that is still not the same
> as ACCEPTED.** It was
> *deployed*, *disclosed*, *was enabled for one studio at every measured instant* and
> *collecting*. It has **not** been
> exercised beyond joining on that studio at the measured instants — **zero invitations had been
> issued there as of that reading** — ⚠️ **NO LONGER TRUE, AND THE COUNT IS DATED.** One invitation **was** issued at Willow on **2026-10-02T00:14:55.792262Z**, by a practitioner, against the synthetic step-G acceptance entry; its `delivery_disposition` read `accepted`. That was an **acceptance exercise, not ordinary operator use**, and it is a dated observation — nothing is asserted about invitation state after that instant. Treat the zero above as the reading it was, not as a standing fact. —
> and owner device acceptance has not been given.

## 6. Client portal and intake

**Deployed · enabled · in use.** Magic-link portal login with an append-only access-event log,
portal messages and replies, intake forms with reminders and terminal-state immutability, and
versioned consent with e-signatures.

**Willow, the real-customer studio** *(as of 2026-08-23, read-only per-studio query)*: **32
portal sessions · 2 portal messages · 72 intake forms · 49 consent signatures.** Controlled test
studio: 6 · 9 · 6 · 3. Synthetic Twin: 0 · 0 · 50 · 0 — **not customer activity**.

**Launch readiness now requires a live treatment consent** (PR #643, `9eb3c317`, deployed,
**no migration**). A new studio starts with **zero** consent templates and nothing seeded one,
so the launch checklist could read *Done* on every row while the intake presented no consent at
all. `lib/consent/launch-readiness.ts` now requires at least one form with server-resolved
`studio_id`, `form_type = 'treatment_consent'`, `status = 'active'` **and** `is_live = true`.
Draft, archived, and active-but-not-live forms do not satisfy readiness. "Ready" therefore means
something operational: **the intake will actually present a treatment consent.**

⚠️ Consent template wording is **draft**. Lawyer review is required before relying on
enforceability. Hone's documentation does not claim signatures are legally binding.

## 7. Payments and Stripe

**Live-capable and genuinely production-exercised for two approved studios — but not broadly ready.**

- **Willow Electrolysis is live and charging.** **30 succeeded live-mode charges of 34
  attempts**, most recent **2026-08-20T22:48:49Z** *(as of 2026-08-23, read-only query)*. Her
  live Connect account has `charges_enabled` and `payouts_enabled` true. This is the strongest
  production-exercise evidence in the system. **The 4 non-succeeded attempts are the source of
  the 4 unresolved `ops_alerts` recorded in §13** — the two facts are one event, not two.
- The controlled test studio also holds a live account with 2 succeeded live charges.
- **The Synthetic Twin holds no payment rows at all** — zero charge attempts, zero stored cards.
  No payment figure in this document includes synthetic activity.
- **Card-on-file** (SetupIntent) with live/test isolation is in use — **Willow: 18 stored
  payment methods and 18 Stripe customers**; controlled test studio 2 and 3.
  `require_card_on_file` is **false on every one of the four `studio_payment_settings` rows**
  (two studios × live/test), and both studios read `stripe_account_status = 'enabled'`
  *(as of 2026-08-23, read-only query)*.
- **Provider-money integrity is live** (PR #834, PAY-CCY-01, merge `6f7281bb`, deployed
  2026-10-13, no migration). Before a Stripe object updates a prepared payment attempt, its
  **amount and currency must equal the attempt's**. This covers synchronous charges,
  reconciliation, refunds and webhook outcomes, including PaymentIntents that are retrieved,
  created or replayed. A mismatch is not recorded, cancelled or marked failed: the attempt
  stays unresolved for manual review and an operational alert is raised. Matching CAD
  payments behave as before. **No production mismatch has been observed or measured at this
  sync.**
- **An ambiguous THROWN Stripe error is never recorded as failed** (PR #898, HON-11 #1, merge
  `b08845ce`, deployed 2026-10-17, no migration). When the Stripe call for a session charge or
  a refund **throws**, the attempt is now recorded failed only for an allow-listed
  **definitive** Stripe refusal (card, invalid-request, authentication, permission or
  rate-limit errors). Any other thrown Stripe error (connection, API, idempotency,
  unrecognised) falls through to the existing unknown-outcome path: a charge stays
  `pending_stripe` with a critical `session_payment_needs_manual_review` alert; a refund keeps
  `refund_status = 'pending_stripe'` with a critical `payment_refund_stripe_unknown_outcome`
  alert. **Non-error Stripe outcomes are unchanged by #898:** for example, a PaymentIntent
  cancelled after `requires_action` is still recorded failed. **No production occurrence has
  been observed or measured at this sync.**
- **US/USD remains PENDING.** Per-studio payment jurisdiction, USD Stripe accounts and USD
  activation are **not merged and not active**: #833, #836, #839 and #847 are drafts. Their
  migration chain (0214 onward) is unmerged and **not applied**. #834 changes no studio's
  currency or Stripe configuration.
- **Receipts** are live. **Refunds** are deployed but have **zero production rows on this
  baseline**. **Disputes** are **alert-only** — 0 have occurred.
- **Live manual no-show / late-cancellation fees are HELD** by a server-side allow-list;
  only `session_payment` charges live. Willow's 3 test-mode charge attempts all succeeded;
  the **per-reason** split of those test-mode charges was **not re-measured** at this
  reconciliation and is not restated — see [known-limitations.md](./known-limitations.md).
- **Non-card settlement is recorded, not faked** (PR #636, `f9ad0f72`, migration **0187**,
  applied 2026-08-24). A completed appointment previously had exactly one way to stop showing
  *Checkout* — run a card charge — so a cash, e-transfer, waived or still-owing visit invited a
  **fabricated Stripe charge on a real client's card record**. `public.appointment_settlements`
  records the disposition instead. **The structural guarantee is the absence of a value:**
  `method` has **no `card`** and **no `hone`** member, so an attestation that a card was charged
  is *unrepresentable*, not merely discouraged. Stripe truth stays in `payment_charge_attempts`
  and nowhere else, so the two can never be summed into one another.
- **`unknown` is an absence, never a value.** 0187 wrote **zero rows** and backfilled nothing;
  every historical appointment keeps no disposition, which is the truthful answer. The table was
  created empty and held **0 rows** at post-apply verification *(2026-08-24; not re-measured at any
  later reconciliation)*. **no settlement had been recorded in production when last measured**, so this capability is
  **deployed and enabled but not production-exercised.**
- **Public-booking card collection is OFF and unwired.**
- **Deposits, packages and partial payments are not built.**
- **Broad self-serve live payments are not ready** — a new studio starts in test mode and is
  enabled only after supervised onboarding and approval.
- **No automatic, background, batch or public-triggered charge path exists.** Charging is one
  manual practitioner click.

## 8. Communications

Transactional email via Resend (confirmation, reminder, postcare, portal) is live and
fail-soft. **Postcare auto-send is deployed but defaults to `manual`** — opt-in per studio,
skipped if the Resend key or postcare text is missing.

✅⚠️ **Appointment reminders: production operation PROVEN 2026-08-12; scheduler OWNERSHIP still unverified.** The
schedule is owned by an **external scheduler outside this repository** — `vercel.json`
deliberately does not register it, so neither CI nor a successful deploy says anything
about whether reminders are firing. That gap was closed by direct observation rather than
inference: at production SHA `773dbc7008b5`, read-only Vercel request logs show
`GET /api/cron/appointment-reminders` on `hone.care` at **23:00:19Z / 23:15:10Z /
23:30:14Z** (2026-08-12), all **HTTP 200**, ~15 minutes apart, with an unauthenticated
probe returning `401`. **No authenticated invocation was made and no reminder was sent.**

What remains unverified is **human**, not runtime: the cron-job.org account owner, a backup
owner, a single-enabled-job dashboard confirmation, the named alert recipient, and one
observation of the `/admin` **Reminder scheduler** card reading Healthy (an HTTP 200 proves
the run, not that the fail-open Upstash heartbeat persisted). Until those are recorded,
describe reminder delivery as **running in production, ownership unattested** — see the
ownership register in
[docs/08_EMAIL_SMS_AND_CRON.md](../08_EMAIL_SMS_AND_CRON.md).

**Intake reminders moved to a 24h / 2h cadence** (PR #632, `5bbd37a5`, migration **0186**,
applied and verified 2026-08-24). 0186 adds exactly one column — `studios.send_intake_reminders`,
boolean NOT NULL DEFAULT TRUE — plus a comment; no function, index, policy, constraint or
trigger, and no DML anywhere in the file. **The 0098 7d/3d state is preserved, not
reinterpreted**: `intake_reminder_7d_*` / `intake_reminder_3d_*`, their partial indexes and both
`claim_email_send` / `record_email_result` branches remain intact and are **historical**. The
application simply stops writing them.

**SMS is pilot scale only**, env-gated on `TWILIO_*` with a per-studio toggle and per-client
consent, STOP/HELP handled. Broad-SaaS SMS (A2P/10DLC registration, sender strategy, rate
limiting) is **not built**.

Marketing conversion tracking is deployed but **inert per studio** — no studio has configured
a provider token, and configuring one is an enablement step, not a default.

## 9. Google Calendar

**DB applied · deployed · production-exercised exactly once · currently DORMANT.**

- **Willow Electrolysis is not connected to Google Calendar** and has never had an event
  synced.
- One connection exists, on the **controlled test studio only** (connected 2026-07-12,
  `destination_mode='dedicated_app_created'`). Granted scopes are least-privilege:
  `calendar.app.created` — **no** `events.owned`, **no** broad `calendar.events`.
- **Exactly one real outbound Google event has ever been created**, on 2026-07-18, on that
  test studio: one `calendar_sync_outbox` row (`op_type='event.create'`, `status='done'`,
  1 attempt) and one `calendar_event_links` row (`sync_status='synced'`,
  `last_sync_direction='hone_to_google'`).
  *This corrects earlier documentation that described both tables as empty.*
- **Every outbound / inbound-busy / two-way sync flag is `false` on every studio.** No worker
  is draining the queue, and no studio is intent-eligible. **Re-verified 2026-08-23** across
  all six tenants: `google_calendar_connection_enabled` is true on the controlled test studio
  and nowhere else; `google_calendar_outbound_sync_enabled`,
  `google_calendar_inbound_busy_enabled` and `google_calendar_two_way_updates_enabled` are
  false everywhere. The single connection, single outbox row and single event link all sit on
  that one test studio; **Willow holds none of the three**.
- **The calendar cron routes ARE registered and DO run daily** — `vercel.json` schedules
  `/api/cron/calendar-reconcile` at `0 9 * * *` and `/api/cron/calendar-sync` at `30 9 * * *`.
  They authenticate, find zero eligible studios and zero claimable jobs, and exit having done
  nothing. **Dormancy comes from the flags being off, not from the absence of a schedule.**
- Inbound busy import and two-way edits are **designed, not built**.

Deployed ≠ enabled. Each of the following needs **separate authorization**: connecting
Willow, enabling any outbound flag, activating the worker, and starting inbound/two-way work.

## 10. Multi-practitioner and practitioner capacity

**Deployed · enabled only on the controlled test studio · public assignment held off everywhere.**

- Tenant isolation is enforced by RLS (`is_studio_member`) plus composite same-studio
  foreign keys; migration **0151** closed the appointments cross-studio-reference gap.
- Multi-studio users are supported (studio switcher + re-validated httpOnly cookie).
- The practitioner roster is real: **2 practitioners at Willow**; 7 across all six tenants,
  which includes the controlled test and synthetic studios (§0).
- **`practitioner_capacity_enabled` is true only on the controlled test studio, and FALSE on
  Willow Electrolysis.**
- **`practitioner_capacity_booking_enabled` — the public-booking kill switch — is FALSE on
  every studio.** Public practitioner selection and assignment is not active anywhere.
  Both capacity flags were **re-verified across all six tenants on 2026-08-23**.
- Per-practitioner availability, scoped blocks and breaks, and the atomic internal
  booking / move / reassign commands (0135–0150) are deployed and follow the capacity flag.

**Schema and code existing is not launch readiness.** Broad multi-practitioner rollout
requires the deep audit and explicit authorization.

## 10b. Owner business surfaces (OWNER-CAP)

**Implemented · merged (PRs #638 `6e5283db`, #641 `a1639a84`, #645 `14be8198`) · deployed ·
enabled for owners of every studio.** **No migration. No RPC.**

`/dashboard/capacity` answers one question Chloe could not previously ask: **which of her active
treatment clients have fallen off the calendar** — the re-book worklist. Nothing else in
production answers it; `clients-needing-attention.ts` is clinical memory and
`practice-metrics.ts` is period-scoped service value.

- **Owner-only, and the server is the authority.** `app/(app)/dashboard/capacity/page.tsx`
  checks `practitioner.role !== "owner"` **before any capacity read is issued** and renders a
  refusal in place — it does not redirect. A practitioner who types the route sees no figures,
  no worklist and no client identity.
- **One Data API statement, one snapshot**, rooted on the studio's current non-archived clients
  with open-plan evidence embedded as a `count` rather than rows.
- **Owners have a permanent `Business` nav entry** (#645) on desktop and in the compact Menu,
  pointing at `/dashboard/capacity`. A practitioner sees no such item — absent, not disabled.
  It is named *Business* rather than *Capacity* deliberately, so later owner surfaces land
  behind the same word without renaming a tab under owners who already learned it. **Nav
  visibility is presentation only and protects nothing**; the route's own server check remains
  the authority.
- **Browser coverage** (#641): nine tests prove an owner reaches the page, an ordinary
  practitioner is refused **in place**, and the rebooking names are real links landing on the
  right client.
- **Slices 2 and 4 are not started.** Slice 2 (new-client demand and conversion) and Slice 4
  (treatment access and weekly capacity) exist only as an approved decomposition.

**Not production-exercised as a measured fact.** No usage of `/dashboard/capacity` was measured
at this reconciliation, and none is claimed.

### Owner financial truth surface — FIN-01A Slice 1 (PR #646)

**Implemented · merged · deployed · owner-only · NOT production-exercised as a measured fact.**
**No migration, no RPC, no new table, no schema work. Migration 0187 is untouched and no
settlement vocabulary changes.**

`/financials` answers one question: **what the calendar held in one studio-local period, and how
those appointments divided** — still to happen, completed, cancelled, no-show — with the
partition claim printed only when it is true.

- **Owner-only, refused before any query.** The role refusal is the **first statement** of
  `loadFinancialsView`, before a Supabase client is constructed, so a practitioner who types the
  URL causes **no studio-wide query** and receives no aggregate payload — not merely an
  aggregate they are not shown.
- **The route is unadvertised.** It is added to `NON_SEARCHABLE_ROUTES`, which **withholds** it
  from search; there is no `NAV_ENTRIES` row. Owners reach it through the existing *Business*
  entry established by #645.
- **It adds no money arithmetic of any kind**, and a source guard proves it: the slice
  references none of the three truth classes' ledger identifiers and reads **exactly one
  table**. The anchor is answered in **visits, not service value** — resolving a price per visit
  is money arithmetic and belongs to **Slice 2**.
- **Unknown is a closed vocabulary, not free prose.** `lib/finance/financial-fact.ts` carries a
  `Fact<T>` whose unknown side is one of `not_recorded`, `unavailable`, `unknowable`,
  `not_yet_supported`, `not_enumerable` — each with its own label, sentence and shape, because
  *"nobody has said what happened"* and *"Hone could not look"* are different claims.
  **`known(0)` is the only route by which a zero reaches this screen**, so a failed read renders
  a sentence naming the cause, never a zero.
- **Deliberately not OWNER-CAP's `Fact<T>`.** That one carries `reason: string`, which cannot be
  exhaustively checked; the two are structurally incompatible on purpose, so importing the wrong
  one is a type error. OWNER-CAP's type is left alone.
- **No external side effect** — no write, no Stripe call, no email, SMS, Google or analytics
  path. No browser E2E was added, deliberately: an `e2e/` spec would trip the spec-count pin.

**#650 made `Still to happen` temporally truthful.** Slice 1 counted `status = 'confirmed'` and
nothing else — and **status alone cannot say whether something is still ahead**. `confirmed`
means *on the calendar, not closed out either way*, and **nothing in Hone writes a terminal
status when an appointment elapses**, so a visit that came and went without being closed out
reported as upcoming indefinitely. The query selected only `status`, so the model could not
compute the right answer even in principle.

The whole widening is `.select("status")` → `.select("status, starts_at")`: still one table,
still no price, payment, settlement, charge, refund or Stripe column, still the owner gate before
a Supabase client is constructed, still the half-open studio-local window. `confirmed` now splits
on time into **`Still to happen`** (at or after the reference instant) and **`Past, still
confirmed`** (already started).

> **The new line is a fact about the RECORD, not about the visit.** It is not evidence the visit
> happened, was missed, or was cancelled. *"missed"*, *"no-show"*, *"completed"* and *"needs
> action"* are deliberately absent — no authority in production writes them.

⚠️ **The production figures behind that repair were measured by #650's own read-only audit on
2026-08-27, not by this reconciliation:** 29 of Willow's appointments were past and still
confirmed, oldest `2026-05-17`, with the live error at 1 row in 19 for the current month. They
are recorded here as that audit's dated evidence and were **not** re-measured.

**Slice 2 and beyond are not shipped.** The disposition chain and the two money bridges each
render one sentence naming the release rather than a zero or a stub.

## 11. Studio onboarding and self-service

Practitioner signup is **invite-only** — magic-link login creates an account only for an
email with a pending team invitation. Invitation reconciliation (0141) ensures nothing
fabricates consent and no membership activates merely because an Auth user was created
(**12 pending invitations across all tenants — 5 at Willow** *(as of 2026-08-23)*).

**Onboarding v2** (0140) is deployed with `onboarding_v2_enabled` true on the **controlled
test studio only**. Nudges and analytics remain deferred.

**Self-serve studio creation is not built.** New studios are provisioned through the
operator runbook.

## 12. Files, treatment photos and exports

Private `treatment-images` bucket, service-role-only access with short-TTL signed URLs,
per-file EXIF stripping, tenant-scoped paths, multi-file upload (3 `treatment_images` across
all tenants — 1 at Willow, 2 on the controlled test studio, **0 synthetic**, as of 2026-08-23).
Per-client procedure record pull with filtered print is live.

### Studio data export — completeness is now machine-accountable (TRUTH-01A)

**Implemented · merged (PR #644, `6786b07b`) · deployed · enabled.** **No migration.**

The export was an **implicit allowlist** — whatever somebody remembered to add. Nothing was
required to have an opinion about a table, so every migration that created one widened the gap
in silence while the product described the result as a *full* export.

`lib/export/resource-registry.ts` is now the one place a resource's export disposition is
decided, and the guards beside it make a **missing decision a build failure**. Schema authority
is the **database, not the file**: the guards take the live resource and column lists as
arguments, supplied by `information_schema` introspection on the fully migrated stack. Nothing
parses migration SQL.

Every resource carries exactly one of three dispositions, and the counts are **deliberately
recorded here as a shape rather than as three exact integers** — the registry is the authority
and a hand-copied count is the very drift this whole reconciliation exists to stop:

- **exported** — in the ZIP, with its file, headers, in-scope columns and row-count verification
  stated. Roughly **sixteen** resources.
- **excluded** — a decision on the record with its reason. Roughly **eighteen**.
- **pending** — studio-owned, **not** exported, and nobody pretending otherwise. Roughly
  **fifty-nine**, each carrying a ticket (`TRUTH-01B`, or `TRUTH-01C` for a small tail) and a
  tier. The Data settings page and the in-ZIP manifest **render this list**, so an owner is told
  what the archive does not carry.

> ⚠️ **The export PAYLOAD is byte-for-byte unchanged.** TRUTH-01A added no file, no table and no
> column. `tests/app/settings/data/export-emission-parity.test.ts` builds a real archive and
> pins every header row against base `a1639a84` column-for-column. **The export is still
> partial.** What changed is that its incompleteness is now declared, tested and shown to the
> owner instead of being invisible. **TRUTH-01B is what changes the payload, and it is not
> shipped.**

**Two withdrawals are recorded rather than glossed.** The application-source reachability
analyser TRUTH-01A originally carried was **withdrawn** as insufficiently robust, and nothing
replaces it. Pending entries therefore say *"TRUTH-01A makes no finding about which code paths
reach this table"* — neither claiming nor denying that anything uses it. Where a fact survives,
it comes from the database (for example `ON DELETE CASCADE` read from `pg_constraint`), not from
reading application code.

Finalized-record photo **content** immutability was never implemented, and is now **moot**:
signed/finalized clinical records are retired (§3), so no record is ever finalized and there is
no finalized-photo integrity claim to make. This is **not** a scheduled phase. The live
protections — private bucket, service-role-only access, path/identity CHECKs and the integrity
trigger that freezes identity columns after insert — are unaffected and remain in force.

## 13. Operations, alerts and observability

- `ops_alerts` — redacted, never-throws. **4 unresolved alerts** *(as of 2026-08-23,
  read-only query)*, out of 7 rows total. All four are `session_payment_charge_failed`,
  severity **warning**, all raised at Willow inside a two-minute window on
  **2026-08-23T19:30:48Z–19:32:39Z**. They correspond to the 4 non-succeeded live charge
  attempts in §7 — one event, counted two ways, not two separate problems.
  **This corrects a standing "0 unresolved" claim** that was true at the 2026-07-27
  reconciliation and was carried forward unverified. *(Unresolved rows are not a claim about
  incidents ever; equally, do not restate "zero" without re-reading the table.)*
- Admin action audit log (0113) at `/admin/audit` — append-only, service-role-only, no
  token/URL/IP/PII columns (**7 events across all tenants**; 3 carry a studio, 4 carry none,
  as of 2026-08-23).
- `scripts/verify-production.mjs` — read-only health check that **derives** the expected
  migration max from `supabase/migrations/` rather than hardcoding it.
- `scripts/check-stripe-gates.mjs` — a gate suite. **Passing gates is not proof of security.**
- Sentry and PostHog are merged and deployed with hardened settings. **Whether either
  console is receiving events, and whether `NEXT_PUBLIC_POSTHOG_*` is set in Vercel, is
  unknown pending verification** — it cannot be confirmed from code or the CLI.
- **Record ids are redacted in code before two egress paths** (both deployed 2026-10-17, no
  migration; #828 privacy gaps). PR #842 (G-07, merge `25956e5c`): Vercel Web Analytics and
  Speed Insights get `beforeSend={redactVercelEvent}`, which turns UUID and all-digit path
  segments into `[id]`, long opaque segments into `[token]`, `/book/<slug>` into
  `/book/[studio]`, and drops the query string and fragment (canonical marketing pages instead
  keep only the attribution parameters the existing marketing sanitizer allows). PR #891
  (G-25, merge `62ff27b2`): the Sentry scrubber now replaces dashed UUIDs in event URLs,
  names, messages, breadcrumbs and spans with `[id]` (dashless hex such as trace ids is not
  matched). **Neither is a BAA, and whether production
  events actually arrive redacted was not measured at this sync.**
- **The `/ingest` (PostHog) and `/monitoring` (Sentry tunnel) proxies forward only allowlisted
  headers** (PR #912, #828 G-07/G-26, merge `6acea261`, deployed 2026-10-17, no migration).
  They were bare rewrites that forwarded every browser header. Route handlers now forward only
  `content-type`, `content-encoding` and `accept`, so no Referer (the page URL), Origin, Cookie,
  Authorization, client IP or User-Agent, and return only `content-type`, `cache-control`,
  `x-sentry-rate-limits` and `retry-after`. **Not a BAA; production requests were not
  measured.**
- **PostHog: bounded URL/campaign record-id redaction, fail-closed serialization, and `/flags` off** (#828 G-07/G-26; #918 introduced the boundary, #932 extended it at `440829c2`, deployed 2026-10-19; no migration). `guardBrowserEvent` allows only approved marketing events from canonical marketing pages, then sanitizes `properties`, `$set` and `$set_once`.
  - URL strings use the existing marketing URL/path rules: token routes and record-id path segments are redacted; non-allowlisted query parameters and fragments are dropped. Retained `utm_*` values and standalone campaign/ad-click properties (including `$initial_`/`$session_entry_` forms) now redact embedded dashed UUIDs after bounded percent-decoding. Malformed or still-encoded values become `[token]`; non-id attribution text is retained. Other non-URL strings also lose embedded record UUIDs, while bare unencoded UUIDs are deliberately retained for PostHog’s own identifiers.
  - Beyond nesting depth 8, strings become `[redacted]` and containers become `[depth-limited]`, rather than passing their contents through; non-text primitives remain unchanged. Object keys are sanitized too. URL objects are withheld as `[url]` without serialization; Date values use intrinsic time access and a fresh ISO serialization. Callable/accessor `toJSON` and unsupported object types become `[unsupported]` without invoking the serializer; bigint, symbols and functions are dropped.
  - `advanced_disable_flags: true` remains set for posthog-js 1.404.1. The earlier retained-UTM/deep-container gaps are repaired in deployed #932; source/regression evidence is in `tests/lib/analytics/posthog-attribution-values.test.ts`. This is bounded ID/token protection, **not a general PII classifier or an unconditional guarantee that record ids never reach PostHog**. Freeform non-id attribution and PostHog’s own identifiers remain by design. **Not a BAA; production events and current provider configuration were not measured. Vendor-side deletion remains a separate decision.**
- Rate limiting via Upstash **fails OPEN** — if it is down or unset, portal and booking rate
  limits bypass.

## 14. Known limitations and held capabilities

Full register with impact, mitigation, owner and next gate:
**[known-limitations.md](./known-limitations.md)**.

**Held behind a deliberate server-side gate** (do not enable without a dedicated PR + approval):
live manual no-show / late-cancellation fees · public-booking card collection · public
practitioner selection and assignment.

**Dormant** (deployed but not acting): all Google Calendar sync phases · practitioner capacity
at Willow · onboarding v2 at Willow. ⚠️ **CORRECTED 2026-09-19 — the durable new-client waitlist
(WAIT-02B) HAS LEFT THIS LIST.** It was recorded here as dormant *on every studio*; it is
was enabled for `willow-electrolysis` and collecting at every measured instant, **31 rows
measured 2026-09-19** — see §5b.
*(The reasoning that kept it here was sound and is worth preserving: Stage B1 replaced the
build-time prohibition with a report-only gate, so what governed activation became **runtime
allowlist membership** across two allowlists. That is configuration rather than structure — and
configuration is exactly what changed, unobserved, on or before 2026-08-25.)*

**Shipped since the previous reconciliation, and NOT production-exercised:** non-card
appointment settlement (§7 — 0 rows) · `/dashboard/capacity` (§10b — no usage measured).
⚠️ **CORRECTED 2026-09-19 — WAIT-02B Stage B1 HAS LEFT THIS LIST**; it was recorded here as
having none. One studio was enabled and joining exercised at every measured instant (§5b). It is
still
**not accepted**. No invitation had been issued on that studio as of the 2026-09-19 reading; one **was** issued on **2026-10-02T00:14:55.792262Z** during the step-G acceptance exercise (`delivery_disposition` `accepted`), which is a dated observation and not ordinary operator use.

**Retired by product decision (2026-07-29), enforced by migration 0159:** signed / finalized
clinical records · signed-record corrections and amendments · practitioner-facing Finalize and
signed-Correction controls · any "snapshot v2". These are **not dormant and not held** — they
cannot be enabled by any role. See
[../decisions/clinical-finalization-retired.md](../decisions/clinical-finalization-retired.md).

**Not built:** deposits / packages / partial payments · broad self-serve live payments ·
inbound-busy and two-way calendar · broad-SaaS SMS · self-serve studio creation.

**Deferred by product decision (2026-07-27):** the direct new-client consultation booking route.

## 15. Human acceptance still pending

**Chloe has not yet accepted, on-device, any of the following:**

1. The unified **Treatment observations & skin response** box.
2. Galvanic intensity being absent from new charting.
3. `0.733` displaying as **`0.733 seconds`**.
4. The **Thermolysis pulse count** label and its placement inside the thermolysis section.
5. The larger **Additional notes** field.
6. **Whole-session copy.** *(Note the change of grounds: this is no longer waiting on a first
   production copy. **24 have now been performed at Willow**, 2026-07-28 to 2026-08-23 — see
   §2. What is still missing is Chloe's explicit confirmation that she has used it and accepts
   its behaviour. **Usage is evidence of exercise, not of acceptance.**)*
7. Conditional numbing notes (0156) and inventory-backed probe-lot linkage (0155).

**Additional UAT for the 2026-10-20 deployed releases — also pending:** Do not use production
logs, induce a database/provider failure, send live email/SMS, or access or modify real-client
records. Existing CI fixtures prove the redaction invariants; they are not Chloe's runtime
acceptance.

8. **#903 safe operator logging:** no existing non-destructive application path is available
to produce a database/provider failure containing a synthetic record UUID. Do not create an
orphaned record or deliberately break a dependency to exercise this log branch. Runtime
acceptance of UUID redaction is therefore unavailable through the current UI; the existing
synthetic unit/CI evidence remains the only verification of that invariant.
9. **#897 treatment history:** on the Sessions tab, confirm an uncharted recent visit's
Watch/Plan note remains associated with that visit. Separately, in the existing synthetic
staging workspace, create one older charted session and exactly **25 newer, non-deleted,
non-void, uncharted sessions** that all start before a synthetic target appointment and are
not linked to that appointment. Open the target appointment's **detail page**; the Last
treatment section must say **“Previous treatment could not be loaded. Open the client's chart
to review it before treating.”** The 25-row candidate limit is what makes older history
unavailable here. Also confirm a charted prior treatment shows its date, modality and summary
on the appointment detail page. Check desktop and phone layouts.
10. **#895 operator alert email:** the existing `sendTestCriticalAlertAction` emits a static
synthetic event with no record identifiers. Its captured email can verify delivery and
operational context only; it cannot verify identifier redaction. Do not treat this action as
acceptance of that invariant. Existing synthetic CI fixtures remain its only verification.
11. **#942 portal magic-link logging:** in the existing synthetic staging workspace, issue a
portal link for a synthetic client/studio and use the existing mail-capture inbox only. Confirm
the `portal_magic_link_sent` log shows `studioId` and `clientId` as `[id]`, preserves its event,
timestamp and success marker, and contains no email, raw token, token hash or UUID. Do not send
to a live email destination or access a real-client record. The insert-failure redaction path
has no safe user-facing trigger and remains verified by synthetic CI fixtures only.
12. **#944 portal last-seen failure logging:** there is no safe user-facing action that produces
a controlled database failure for either last-seen callback. Do not induce an error or inspect
production logs. Existing synthetic fake-database tests prove that session IDs and free-form
error text are omitted while the failure event, timestamp and database code remain. A human
runtime check requires an existing approved synthetic staging failure trigger; none is
currently recorded.
13. **#945 portal lookup/logout failure logging:** use only an approved isolated synthetic staging account and preconfigured failure trigger. Exercise lookup and logout, confirm anonymous fallback and cookie clearing, then inspect only staging logs to verify event/code/time remain and provider free-form message, session/client/email/cookie data are absent. No approved staging fixture or failure trigger is currently recorded; do not induce production errors or inspect production logs.
14. **#921 server analytics boundary:** Chloe's acceptance requires an approved staging-only synthetic actor and event sink. With that fixture, send one supported event containing allowed coarse values and verify it is accepted; then exercise the existing rejected ID-like event-name/value cases and confirm no rejected value reaches the staging sink. No approved staging actor/sink is currently recorded. Do not emit test events from production or include real-client data; until that fixture exists, synthetic CI is the only recorded verification and Chloe's acceptance remains pending.
15. **#959 client-lookup diagnostic redaction:** `isClientVisible` logs only the fixed event and timestamp when its studio-scoped `clients` lookup fails; the action still returns the generic “Client not found.” response and performs no update. No safe UI path, controlled staging database-failure trigger, or approved staging-log viewer is currently recorded. If an isolated synthetic staging fixture and approved failure trigger/viewer are provided, use only a synthetic client, cause the `clients` lookup to return a synthetic error containing an email/clinical/token sentinel, submit the normal client-update action, and verify the generic refusal/no write plus a `client_visible_lookup_failed` event whose payload contains only event and timestamp. Verify the sentinel and all client IDs, database code/message, email and clinical text are absent from staging logs. Do not induce production failures, inspect production logs, or use real-client data. Until those staging prerequisites exist, the synthetic regression test is the only verification and Chloe's acceptance remains pending.
16. **#957 portal/manual-fee diagnostic redaction:** in an approved isolated synthetic staging workspace, invoke the existing portal magic-link and manual-fee eligibility flows against controlled synthetic database errors containing a unique sentinel; verify each preserves its established generic result/failure behavior and that staging logs retain only the fixed event, safe code/time metadata while excluding the sentinel, email, client/studio ids, and free-form provider/database text. No approved staging fixture, failure trigger, or log viewer is currently recorded. Do not induce production errors, send a real email, or use real-client data; until those prerequisites exist, synthetic CI is the only verification and Chloe's acceptance remains pending.
17. **#961 duplicate-email lookup diagnostic redaction:** with an approved isolated synthetic client, controlled failure trigger and scoped staging-log viewer, submit the normal client-update action and fail its studio-scoped duplicate-email lookup with a unique synthetic email/clinical/token sentinel. Verify the established generic refusal, no update, and a `client_duplicate_email_lookup_failed` event retaining only its fixed event and timestamp; the sentinel, database message/code and client identity must be absent. Also verify the existing active/archived duplicate responses remain unchanged. No approved staging fixture, failure trigger or log viewer is recorded. Do not induce production errors, inspect production logs, or use real-client data; the synthetic regression tests remain the only recorded verification until those prerequisites exist.
18. **#962 client UPDATE diagnostic redaction:** with the same separately approved isolated staging prerequisites, submit a valid synthetic client update, allow its scoped visibility/duplicate checks, then return a controlled non-duplicate UPDATE error containing a unique synthetic sentinel. Verify the existing generic failure/no successful update and `client_update_failed` metadata retaining only the fixed event, redacted client ID, SQLSTATE code and timestamp; raw database text, email, clinical/token sentinel and unredacted identity must be absent. Preserve duplicate-email collision classification and scoped rechecks. No approved fixture, failure trigger or staging-log viewer is recorded; do not induce production errors, inspect production logs, or use real-client data. Synthetic regression tests provide verification, not Chloe acceptance.

Engineering deployment for all of the above is **complete**. Human acceptance is **not**.
Items 8, 10, 12, 13, 14, 15, 16, 17 and 18 have no currently recorded safe runtime acceptance fixture; adding a
synthetic canary or changing the test-alert payload requires separate scope and safety review.
Do not describe any of it as accepted, validated by Chloe, or signed off.

**Do not infer acceptance from usage.** For items 1–5 and 7, no per-item production-exercise
evidence has been measured in either direction, and none is asserted here. For item 6 the
exercise evidence is now strong and the acceptance record is still absent. Those are
independent dimensions, and only an explicit statement from Chloe closes the second one.

19. **#892 phone photo controls:** after OPS supplies a specifically approved synthetic client, ordinary session, authorized identity and storage fixture, open [Hone](https://hone.care/login), then that client’s Photos. On desktop/phone check Choose images / Take photo chooser cancel, View larger / Close preview, practical touch targets and no overflow. With approved synthetic media only, attach, edit/save a note, refresh and verify persistence; Cancel discards an unsaved note. There is no Previous/Next carousel; close and open another tile. Record exact deployed SHA `e91ddd43`, OS/browser/device and Chloe ACCEPT/REJECT. Physical camera/library, permission denial, rotation and background/resume recovery remain separately UNRUN. No approved fixture binding or human result is recorded, and no real-client mutation is authorized by these steps.

20. **#963 diagnostic privacy:** use an OPS-approved isolated staging URL/SHA, existing synthetic owner/client, existing controlled returned-error fixture and scoped staging log viewer. Exercise archive/unarchive audit-error23514 and portal-client lookup-error57014. Confirm existing UI outcomes and fixed event/SQLSTATE/timestamp only, with redacted client ID where already present; no email, clinical text, token-like text or raw UUID. Disable the fixture and verify only the approved synthetic records. Production fault injection, production logs, live sends and real-client changes are excluded. Record SHA/device/operator and Chloe ACCEPT/REJECT; no approved fixture/fault/viewer binding or human result is recorded, so all three cases remain UNRUN.

21. **#925 latest-treatment ordering:** after Sam supplies an existing approved synthetic client/session fixture and expected latest-visit label, open [Hone](https://hone.care/login). Compare Last treatment, Watch/Plan, the existing preparation card and dashboard using tied charted visits with distinct synthetic notes/settings; refresh on desktop/phone and confirm the same expected visit. Tied charted rows must not produce a false newer-uncharted banner; the separately supplied genuinely newer uncharted fixture should retain that banner. No new treatment/save, real-client mutation, voiding, send or charge is authorized. Record deployed SHA `aa905103`, device/browser and Chloe ACCEPT/REJECT; fixture binding and human result remain UNRUN. Microsecond/Unicode permutation controls are automated. Void parity is separate #927; HON-10 row2 and the two preview scope limbs remain unchanged.

22. **#927 retained-void history parity:** after Sam supplies an existing approved synthetic client with a retained legacy void visit and non-void charted visit, open [Hone](https://hone.care/login). Compare Last treatment, Watch/Plan, existing preparation/dashboard and prior-note/intelligence summaries against the expected non-void visit; refresh desktop/phone. Retained void visits and their blocks must not contribute to current derived summaries. Do not create/void/save a clinical record, send or charge. Record deployed SHA `0dc7d5e4`, fixture label/device/date and Chloe ACCEPT/REJECT. Fixture binding and human result are UNRUN; source CI is separate. HON-10 row2 and earlier preview boundary decisions remain unchanged.

23. **#969 newest-non-void banner:** use an approved existing synthetic client with a newer retained void visit and a charted treatment. Open [Hone](https://hone.care/login); verify the charted treatment remains and the void visit does not trigger a false newer-uncharted banner. A separate approved live-empty-draft fixture must still show that banner. Refresh desktop/phone. Do not create, void, edit, send or charge real-client records. Authenticated smoke and Chloe acceptance are UNRUN.

## 16. Next work

1. **Chloe's human acceptance testing** — may happen separately and later; it does not block
   the audit.
2. **The deep production / security / code audit.** Still not performed against this baseline.
   This remains the next substantive engineering and governance work.
3. **TRUTH-01B — change the export payload.** TRUTH-01A made the gap declared and testable;
   roughly fifty-nine studio-owned resources are still unexported and each carries a ticket.
   See §12.
4. **Broader second-studio and multi-practitioner rollout** — only after the audit and explicit
   authorization.
5. **WAIT-02B Stage B2 (activation)** — requires an explicit per-studio operator GO and human
   activation smoke. The disclosure blocker is closed; the authorization is not granted. See
   §5b and **L25**.
6. **Retention and deletion (F-RET-001)** — there is still **no automated retention or
   permanent-deletion lifecycle**: no purge job, no hard-delete path, no legal hold. The
   published policy is **accurate about that absence** — it says plainly that no automatic timed
   purge runs — so this is a **capability gap, not a breached commitment**. **P2 and open**; see
   [known-limitations.md](./known-limitations.md) **L27**, which records why the earlier
   P1 framing was withdrawn. Sequenced after a complete export and jointly with offboarding.

The direct new-client consultation booking route is **not** on this list. It is deferred by
product decision — a separate matter from the waitlist measured live in §5b.

---

## How to re-verify this document

Never trust a number here without re-checking it. Nothing in this document is evidence for
any other document.

**Three rules this document now follows, and a re-verifier must keep:**

1. **No migration number is written here.** Hosted max is declared once in
   [`migration-state.json`](./migration-state.json); repo max and the next free number are
   derived by `npm run migration:state`. Copying either into prose is what produced the
   `0160`/`0163`/`0165` divergence, and `tests/docs/canonical-production-facts.test.ts` now
   fails the build if it comes back.
2. **Every production count carries an as-of stamp and a tenant scope.** A bare number with
   neither is not a fact, it is a fossil.
3. **Real-customer activity means Willow only.** All-tenant totals include the Synthetic Twin
   and must say so. See §0.
4. **An open PR is never production.** A branch, a green CI run and a mergeable state are not
   deployment. Before writing a capability down as shipped, confirm its merge commit is an
   **ancestor of the production head**. The open set at this reconciliation is listed under
   *Open pull requests are not production* above.
5. **This document is not evidence for itself.** No assertion here may be verified by citing
   another line of this file, and a figure carried forward from an earlier reconciliation is
   dated evidence rather than a current reading. Re-derive from the sources below, in order.

```bash
# 1. Production branch head
gh api repos/SaiSamyukthVemuri/Hone/branches/claude/build-hone-saas-hOex7 --jq .commit.sha

# 1b. Derived + declared migration state (never hand-copied)
npm run migration:state -- --json

# 2. Hosted vs repo migrations (guard the project ref FIRST)
cat supabase/.temp/project-ref          # must be the production project
supabase migration list --linked        # Local and Remote must reconcile

# 3. Read-only production state
supabase db query --linked "<verification sql>"   # never `db execute`

# 4. Health
curl -s -o /dev/null -w '%{http_code}\n' https://hone.care

# 5. Read-only health script
node scripts/verify-production.mjs
```

Source-of-truth order: production Git graph → Vercel deployment record →
`supabase migration list --linked` → read-only production queries → code and migrations at
the exact production SHA → merged PR metadata and CI → deployment/runbook reports →
existing documentation (as claims to verify, never as evidence).

See also: [capability-register.md](./capability-register.md) ·
[known-limitations.md](./known-limitations.md) · [migration-ledger.md](./migration-ledger.md) ·
[release-changelog.md](./release-changelog.md) ·
[../runbooks/migration-first-process.md](../runbooks/migration-first-process.md)
