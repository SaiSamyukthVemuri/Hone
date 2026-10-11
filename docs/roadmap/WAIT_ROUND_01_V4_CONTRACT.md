# WAIT-ROUND-01 v4 — the frozen contract, as supplied

**This file is the authoritative source for v4 target behaviour.** It is reproduced
**verbatim** from the operator's own words. Nothing here is paraphrased, summarised,
reordered or reconstructed.

Where any other document in this repository restates v4 — including
[WAIT_V4_PR1_CONTRACT_AND_COMPATIBILITY.md](./WAIT_V4_PR1_CONTRACT_AND_COMPATIBILITY.md)
§2 — **this file governs.**

---

## Provenance

| | |
|---|---|
| Author | the operator (Sam) |
| Supplied | **2026-10-11T17:01:31.814Z**, as an instruction in the Claude Code session that authored PR #823 |
| Source of record | `~/.claude/projects/-srv-hone-worktrees-db-acl01-payment-helpers/54ab90b9-f372-4761-afc1-8217b8cddefe.jsonl`, line **16907** (`type: "user"`) |
| Message length | 4,670 characters · **13** contract bullets |
| sha256 of the full message | `4009c3f859f8c7847db14e85a820c54809acd2ca439ede2ac2301bd47240e74e` |
| Reproduced below | the 13 bullets, byte-for-byte |

### What this file is NOT

The supplying message opens: *"The supplied October 7 roadmap contains the frozen
WAIT-ROUND-01 v4 contract."* **That October 7 roadmap is not in evidence anywhere on
this host.** Searched 2026-10-11:

* `/srv/hone/handoffs/` — **0** files contain any of `one live round per studio`,
  `weekly intake room`, `clean-time count`, `R-q >= U`, `round-derived appointment`;
* no roadmap artifact on disk dated 2026-10-05 → 2026-10-09;
* `docs/roadmap/CANONICAL_ROADMAP.md` contains **none** of the v4 language (its
  `REBOOK-01` rows are the pre-existing T2 backlog entry, not v4's);
* of every transcript under `~/.claude/projects/`, **exactly one** — the session named
  above — contains these phrases.

So the 13 bullets below are the **only extant form of the v4 contract available in this
environment**. They are the operator's text and the operator designated them
*"authoritative target behaviour"*. **If the October 7 roadmap's v4 section contains
language beyond these bullets, that language is unavailable and is not reproduced
here.** §3 below records what the bullets use but do not define.

---

## 1. The contract — verbatim

> • One live round per studio, belonging to one practitioner and one consultation service/duration. Drafts reserve nothing. A launched round has K real, mutually non-conflicting buffered consultation times and M distinct people, 1 <= M <= K. One weekday OR weekend pool; fixed cohort, no additions.
>
> • R is remaining unbooked reservations; U is active unbooked invitations, including pending/uncertain delivery; C is admission consumption, not calendar inventory. While open, R >= U and C <= M.
>
> • Automatic proposals use queue priority, weekly intake room and a default 14-day horizon. Kind follows the longest-waiting eligible person; Both looks ahead to the next single-kind person, otherwise greater clean-time count with weekday winning ties. K = min(weekly room, compatible times, eligible people). Weekly room counts new-client consultation bookings committed in the trailing seven days across all channels.
>
> • Candidate times begin no earlier than now + 48 hours + authoritative booking notice. Ranking protects treatment capacity, then spreads days, then prefers earlier times. Treatment-length means longest active treatment duration plus its buffer. Launch revalidates against its actual instant.
>
> • Change people and the waitlist picker use the same eligibility and weekly-room cap. Opposing weekday/weekend selections produce two proposals; only one launches. Skipped people retain priority; automatic/final cohorts are audited. No count override.
>
> • Launch is one scheduling-locked database transaction creating the reservations and invitations together. Provider delivery happens only after commit. One shared 48-hour deadline. Failed/stale launch leaves no partial state.
>
> • Recipient booking atomically converts one reservation to an appointment AND redeems the invitation. Failure leaves both untouched. “Consume first, then create appointment” is legacy behaviour to replace, not the v4 target.
>
> • Recipients see only current remaining reserved times. Keep-place/availability-update closes this offer and preserves queue priority. Leaving the waitlist is a separate recipient action.
>
> • Withdrawal means a studio write removing reserved time: availability, blocks, service/buffer/timezone/notice changes, owner booking or moves into reservations. Removing q rows requires R-q >= U, or named offers must be resolved in the same transaction. Owner status is not a bypass.
>
> • Cancelling/moving a round-derived appointment while its round is live restores its OWN original reservation atomically. Its invitation stays used; U and C do not increase; weekly room returns. This is the only post-launch operation allowed to increase R. Closed rounds never revive.
>
> • Ordinary freed time never joins a live round. Far-out time feeds future proposals; near-term time goes to REBOOK-01 for compatible active, due, unbooked existing clients with no future appointment.
>
> • Deadline enforcement works even if cleanup is late. Close is idempotent; uncertain/failed delivery is not non-response. One reminder at 24 hours after launch, for still-active unbooked invitations. Messages never list appointment times.
>
> • Joining the waitlist alone STILL does not reserve an appointment. Anonymous calendar reservations arise at round launch. Do not classify the existing join disclaimer as automatically false.

## 2. The frozen PR sequence — verbatim

> Restore the frozen PR sequence:
> 0 completed buffer fix; 1 contract/compatibility; 2 reservation storage/calendar/locks; 3a automatic proposal; 3b manual cohort authority; 3c picker; 4 atomic launch/post-commit delivery; 5 recipient/atomic booking; 6 withdrawal paths; 7 cancellation/move restoration; 8 expiry/close/reminder; 9 practitioner UI; 10 REBOOK-01; 11 controlled acceptance.
>
> CANCEL-RECOVERY/Fast Fill are excluded from v4 launch. Do not retire unrelated backlog IDs globally.

---

## 3. Terms the contract USES but does not DEFINE

**This section is not contract text.** It is a list of the open definitional
questions, recorded so that no later PR invents an answer and attributes it to v4.
Each is a question for the operator or for the October 7 roadmap, **not** a gap to be
filled by inference.

| Term | Used in | What is undefined |
|---|---|---|
| **queue priority** | bullets 3, 8 | How it is computed and ordered. Bullet 8 requires keep-place to *preserve* it; nothing defines it. |
| **weekly intake room** | bullets 3, 5, 10 | The *counting rule* is given (new-client consultation bookings committed in the trailing seven days, across all channels). **The cap itself is not** — what number the count is compared against, and where that number is configured. |
| **clean-time count** | bullet 3 | Undefined. It decides the `Both` tie-break and has no definition anywhere in this repository. |
| **Kind / Both** | bullet 3 | The weekday/weekend "kind" vocabulary is used as if established. `Both` behaviour is partly given; the enumeration is not. |
| **authoritative booking notice** | bullet 4 | Which setting is authoritative, and its precedence against studio/service-level notice. |
| **compatible times**, **eligible people** | bullet 3 | The eligibility predicate for both operands of `K = min(...)`. |
| **protects treatment capacity** | bullet 4 | The ranking's first key. `Treatment-length` is defined; the *protection rule* that consumes it is not. |
| **named offers** | bullet 9 | What makes an offer "named" in `R - q >= U, or named offers must be resolved in the same transaction`. |
| **audited** | bullet 5 | What record an audited automatic/final cohort produces, and where. |
| **far-out vs near-term** | bullet 11 | The boundary that routes freed time to future proposals versus REBOOK-01. |

`REBOOK-01`'s operands (*active, due, unbooked, no future appointment*) **are** anchored
— `docs/roadmap/CANONICAL_ROADMAP.md:1215` defines the return-state model
(`due soon / due / overdue / no-future-booking`, deterministic, no AI guessing).

---

## 4. Rules for using this file

1. **Quote it; do not paraphrase it into authority.** A restatement elsewhere is a
   reading aid. This file governs.
2. **Never extend it from a summary** — including any summary produced earlier in a
   Claude Code session. §3's terms stay open until the operator or the October 7
   roadmap closes them.
3. **Repository observations never qualify it.** What today's code does is a
   compatibility constraint, recorded separately in
   `WAIT_V4_PR1_CONTRACT_AND_COMPATIBILITY.md` §3.
4. If the October 7 roadmap becomes available, **reconcile this file against it** and
   record any difference here rather than silently editing the bullets.
