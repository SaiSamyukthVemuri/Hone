# Clinical access audit contract (#828 G-13): proposal for agreement

> **Status: PROPOSAL.**
> - Needs agreement with the RBAC / owner-console lane (#830 role matrix,
>   #838/#850/#852), and Sam's decisions on the open questions in §6.
> - No schema exists yet, and **no migration number is held**. 0219 was
>   requested and then withdrawn; see the census below.
> - **Shape agreed in principle with the RBAC lane (ops01), 2026-10-12.**
>   The agreed points are recorded in §7.
> - This does not establish HIPAA compliance.

Today Hone audits clinical **changes**: `clinical_audit_events` records only
`correction` and `amendment`, `session_audit` records session events, and
`audit_logs` records export and archive. It does **not** record who
**viewed** a client record, intake, note, session or photo. HIPAA's audit
controls standard, 45 CFR 164.312(b), requires mechanisms that "record and
examine activity" in systems containing ePHI. Their scope is set by the
risk analysis (G-01).

## 1. The coverage problem (source-confirmed)

From the #830 inventory (`docs/roadmap/STUDIO_READINESS_824.md` §2.3) and
current source:

| Read path | Example | Seen by a server-side audit hook? |
|---|---|---|
| Server component or server action with the user-scoped client | `/clients/[id]` page, session charting | **Yes**, if the hook is called |
| Service-role (admin client) read reached from a member action | Treatment photo signing (`app/(app)/clients/[id]/images/*`), export | **Yes**, if the hook is called |
| **Direct PostgREST with the member's own JWT** | `GET /rest/v1/client_clinical_notes?client_id=eq.…` from the browser, with the session token | **No.** RLS admits any active member on **56** tables (`is_studio_member`). Postgres has no SELECT trigger |
| Global search | `app/(app)/global-search-actions.ts` reads clients, sessions, blocks, areas | Yes, if hooked; results are themselves clinical |
| Signed photo URL re-use | 60 s TTL | Signing is auditable; a viewer reusing the URL within 60 s is not |
| Platform admin `/admin` | Service role across studios | Only where `admin_action_events` is written |

**Consequence:** an application-level log alone records what Hone's own pages
did. It does **not** record everything an authenticated member *could* read.
The contract therefore has two parts:
- **A. Attributable application events** at every server read boundary of
  clinical data.
- **B. Closing or monitoring direct-API reads.** Proposed options, for
  agreement:
  - **B1 (preferred, staged):** for the highest-sensitivity tables
    (`client_clinical_notes`, `client_intake_forms`, `treatment_images`,
    `session_block_areas`), move reads behind definer RPCs that both
    enforce the role and write the event. Then revoke direct `SELECT` from
    `authenticated` table by table, each with a caller census and
    real-role tests. This aligns with the #830 projection model, which
    already denies receptionists raw SELECT.
  - **B2 (monitoring):** enable Postgres-level statement auditing
    (pgaudit) for the `authenticated` role on those tables. It needs
    Supabase support, log retention on the right plan, and a check that
    logged statements contain no PHI values. **Unverified here.**
  - **B3:** accept and document the residual risk in the risk analysis.
    This needs Sam and advisor sign-off.

## 2. Event contract (proposed `clinical_access_events`)

**Minimum necessary:** ids and coarse codes only. No names, contact
details, note text, file names, search strings, IP addresses or user agents.

| Field | Type / values | Notes |
|---|---|---|
| `id` | uuid | |
| `occurred_at` | timestamptz, server clock | Never browser-supplied |
| `studio_id` | uuid, FK `studios` | Tenant boundary |
| `actor_kind` | `owner`, `practitioner`, `receptionist`, `platform_support`, `platform_admin`, `system` | From the #830 fixed roles, resolved server-side, never from the browser |
| `actor_user_id` | uuid (`auth.users`) | Attributable to a person; null only for `system` |
| `actor_practitioner_id`, `actor_receptionist_id` | uuid, nullable, **typed** | Composite same-studio FKs (the 0174 pattern, as in the RBAC lane's 0220 audit columns), with a CHECK tying each `actor_kind` to exactly one column. A role change stays attributable |
| `action` | `view_client_record`, `view_intake`, `view_clinical_notes`, `view_session`, `view_photo` (signing), `print_clinical_notes`, `export_records`, `search_clinical` | Closed enum; adding a value is a contract change |
| `client_id` | uuid, nullable | The subject |
| `target_type`, `target_id` | text enum, uuid | e.g. `session`, `clinical_note`, `treatment_image` |
| `access_basis` | `treatment`, `operations`, `support_ticket`, `export_request` | Platform access **requires** `support_ticket` plus `support_reference` |
| `support_reference` | text, nullable, bounded and pattern-checked | An opaque ticket id, never free text about the patient |
| `request_id` | text, nullable | Correlates with `admin_action_events` |

**Write path:** one definer command, `record_clinical_access(...)`, granted
only to `service_role`. It resolves the actor from `auth.uid()` (or the
supplied service context) and **re-verifies** the membership and role, in
the pattern of the #838 receptionist commands. Per CLAUDE.md §5, it revokes
EXECUTE from `anon`, `authenticated` and `service_role` explicitly, then
grants back only what is needed.

**Integrity:**
- append-only: no UPDATE or DELETE grant to any role, and a trigger that
  raises on UPDATE or DELETE;
- the row is written in the same request as the read;
- if the event cannot be written, the clinical read **fails closed** for
  the B1 RPC paths. For page reads, the failure raises an ops alert with no
  PHI. This rule needs agreement (§6, Q3).

## 3. Who may read the audit

| Role | Access |
|---|---|
| Owner | Own studio's events, through a projection (owner console, #851) showing actor display names resolved at read time |
| Practitioner | **No** access by default (Q4) |
| Receptionist | **No** access |
| Platform support | Only through the audited support path (#830 §4); reading the audit is itself an event |
| Platform admin | Through `/admin`, logged in `admin_action_events` |

## 4. Retention and review

- **Retention:** a proposal for the counsel decision, Q5. HIPAA's six-year
  rule (45 CFR 164.316(b)(2)) is about *documentation*; how long to keep
  audit events is a risk-analysis decision.
- **Review:** an owner-visible weekly summary of access counts by actor,
  plus anomaly flags (for example, reads outside the actor's own clients).
  This is a later slice, not part of the first migration.

## 5. Proposed slicing

1. **Contract agreed** (this document, with the RBAC lane).
2. **Migration (number allocated at the time by the DB/WAIT coordination owner, ≥ 0224):** table, enum checks, append-only trigger, and
   `record_clinical_access`, with grants pinned by
   `tests/security/clinical-rpc-grant-guard.test.ts`. Real-role DB tests:
   - a member writes no row directly;
   - cross-studio is refused;
   - a receptionist actor is refused for clinical actions;
   - UPDATE and DELETE are refused.
3. Server hooks at the read boundaries in §1. A source guard fails if a
   clinical page or action reads without an event.
4. B1 for one table first (`client_clinical_notes`), with a direct-API
   denial test as the receptionist and as a practitioner, before widening.

## 6. Questions to settle

1. B1, B2, B3, or a combination, for direct-API reads.
2. Does the owner console (#851) or the support path (#830 §4) own the audit
   projection?
3. Fail closed versus alert when the event write fails, for each path.
4. Should practitioners see access to their own clients?
5. Retention period (counsel).
6. Is search an audited "view" (results reveal clinical facts), or only
   opening a result?

## 7. Agreed with the RBAC / owner-console lane (2026-10-12)

| Item | Agreement |
|---|---|
| Shape | Fine as proposed, with **typed** actor FKs (above) instead of one untyped id |
| Receptionists | Denied every clinical table by construction (0216: no `practitioners` row, so `is_studio_member` is false). A receptionist `view_*` event is therefore impossible. **Denied attempts are not recorded in V1** |
| Q1 direct API | **B1, incremental**: clinical notes, intake answers and photos first. The read and its event commit in one definer transaction. **B3 with documented sign-off** covers tables not yet moved. B2 (pgaudit) is **not relied on**: it is unverified on hosted Supabase and records SQL, not the actor or membership |
| Q3 failure | **Fail closed** under B1. Any remaining app-level hook on a direct read can only **alert** |
| Q6 search | A search that returns clinical content (note or intake snippets) is `search_clinical`; a search over name or phone is not |
| Permissions | No new permission engine. In code, use the fixed role map `ROLE_CAPABILITIES` in `lib/auth/capabilities.ts` (#852) |
| Owner console | Do **not** mount anything on #851 yet; it is read-only today |
| **Product authority (Sam)** | **Q2**: RBAC lane recommends the full log on the platform/support path (§4), with an owner-scoped "who accessed your clients' records" projection later. **Q4**: recommends owner-only for V1 |

## Migration census (refreshed 2026-10-15)

- **Production repository maximum:** `0211`
  (`supabase/migrations/0211_client_sms_permission_guard.sql`, merged via
  #827). **Hosted maximum:** `0211`, per `docs/production/migration-state.json`
  (`hosted_migration_max`). 0211 is applied and is no longer a claim (Codex P2
  4279192876).
- **Claimed by open PRs, as of the 2026-10-12 census** (re-derive at claim
  time; some may have merged since): 0212 (#831/#832), 0213 (#831),
  0214 (#833), 0215 (#843), 0216 (#838), 0217 (#844), 0218 (#850).
- **Also claimed in #824 comments** (missed by a PR-file-only census):
  **0219** (DB/WAIT, G1 queue position) and **0220** (STUDIO-READY-02c,
  receptionist scheduling).
- **G-13 holds no number.** Re-derive from PR heads *and* #824 claims at
  claim time, through the shared register `~/hone-migration-coordination.md` and the DB/WAIT coordination owner. 0221 is allocated to DELIVERY-VISIBILITY-04 and 0222 is claimed by #868 and 0223 by #860, so expect ≥ 0224.
