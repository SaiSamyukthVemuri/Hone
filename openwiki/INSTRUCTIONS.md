# OpenWiki instructions — Hone

Hone is an electrolysis-practice operating system. Build a coding-agent wiki
focused on repository truth and operational correctness.

## Prioritize

1. booking/calendar/scheduling authority, buffers, timezone and concurrency;
2. waitlist/new-client admission and invitation lifecycle;
3. treatment memory, sessions, blocks, entries, probes/settings/outcomes;
4. authentication, RLS, tenant boundaries and SECURITY DEFINER commands;
5. email/SMS/provider delivery, consent, STOP and idempotency;
6. migrations, production-state authorities and rollout discipline;
7. CI, browser/DB tests, source guards and release verification.

## Keep lifecycle states distinct

Keep designed, implemented, merged, deployed, migration-applied,
production-exercised and human-accepted states distinct.

## Evidence rules

Prefer code + executable tests for behavioral claims.

For mutable production facts, `docs/production/current-state.md`,
`docs/production/migration-state.json`, `migration-ledger.md` and explicit
release evidence are the authorities. **Do not promote historical handoffs or
comments into standing production truth.**

Identify contradictions instead of silently reconciling them.

Never expose secrets, credentials, tokens or client data.

## Generation rules (from the #782 review findings)

1. **No instance-specific production values.** Never copy production tenant or
   fleet counts, measured row, charge, alert or event counts, "exercised N
   times" tallies, tenant/studio/person names, record ids, deployment ids,
   environment values or any other instance-specific production value into
   pages, page descriptions or Claims. A lifecycle state (deployed,
   migration-applied, production-exercised) may be stated; point to its
   canonical authority (`docs/production/current-state.md`,
   `migration-state.json`, `migration-ledger.md`) for the values behind it.
2. **Executable behaviour needs implementation evidence.** A Claim about what
   code, a script, a migration or a command does must cite that implementation
   and, where they exist, its tests. A prose-only citation may support only a
   statement about what that document says ("CLAUDE.md requires …").
3. **"Exact" means complete.** When presenting a repository procedure or
   sequence as the exact one (for example the CLAUDE.md delivery sequence),
   keep every mandatory step, in order. Otherwise call it a summary and link
   the source.
4. **Route-group paths are never links.** Paths containing Next.js route-group
   parentheses (`app/(app)/…`, `app/(auth)/…`) are inline code, never Markdown
   links. Keep link text free of square brackets (e.g. `[slug]`): OpenWiki
   0.6.1's link validator does not see such links, so they go unchecked.
5. **Treatment Intelligence empty history.** With no charted session,
   `buildTreatmentIntelligence` returns `charted: false`, `chartedSessions: 0`,
   `areasCharted: 0`, `null` for every other overall figure (minutes, hairs,
   hairs/min, first and last treated), no area cards, and `null` reaction,
   tolerance, watch-note and plan fields. Ground this in the empty-state return
   in `lib/sessions/treatment-intelligence.ts` and the tests "no charted history
   returns the empty state" (`tests/app/clients/treatment-intelligence.test.ts`)
   and `tests/app/sessions/whole-session-copy-metric-invariant.test.ts`.

## Page shape

Optimize pages for coding agents: responsibilities, invariants, write
authorities, data flow, failure semantics and exact source links.
