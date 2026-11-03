"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useMemo, useState, type ReactNode } from "react";
import { ROLES, type Role, type Scope, type StudioPolicy } from "@/lib/permissions/catalog";
import { applyEdit, buildRoleSections, ROLE_LABELS, type RoleRow } from "@/lib/settings/roles/model";
import { CONSEQUENCE_LABEL } from "@/lib/settings/roles/sections";
import { releaseNarrowings } from "@/lib/settings/roles/diff";
import { BASELINE_NOTES, FUTURE_EFFECTS } from "@/lib/settings/roles/effects";
import {
  isRowError,
  reasonAcceptable,
  reasonRequired,
  roleErrorMessage,
  type CommandResult,
  type PreviewResult,
  type RoleError,
  type RolePreview,
  type ServerPreview,
} from "@/lib/settings/roles/api";
import { SaveStatus, useSaveFeedback } from "@/components/settings/save-status";
import { useUnsavedChangesGuard } from "@/components/settings/unsaved-changes";
import {
  BOOKING_RULES_KEYS,
  BOOKING_RULES_LINKS,
  BOOKING_RULES_SCOPE_TEXT,
  ERASURE_NOTE,
  PORTAL_OFF_CONFIRMATION,
} from "@/lib/settings/roles/studio-notes";

// The Roles control center (R2, People-first). Three views: People (who holds what, from the saved policy), Permissions (the eight
// sections, one draft across both roles, a review screen before anything is saved) and History. Scope controls appear only where
// the catalog supports them; nothing is ever enabled as a side effect of another switch. Save is atomic and version-bound; Reset
// is a separate, previewed operation. While the studio cannot save yet (writable=false) every control is a read-only review.

export type PersonView = {
  id: string;
  name: string;
  email: string;
  role: "owner" | Role;
  state: "active" | "invited" | "deactivated";
};

export type RolesEditorProps = {
  policies: Record<Role, StudioPolicy>;
  reviewed: boolean;
  writable: boolean;
  notWritableReason: string | null;
  initialView?: "people" | "permissions" | "history";
  people: PersonView[];
  // Every preview and every write is the permission core's. The page sends only changed keys and the version a preview returned.
  previewSave: (edits: Partial<Record<Role, Record<string, Scope>>>) => Promise<PreviewResult>;
  previewReset: (role: Role) => Promise<PreviewResult>;
  previewAdopt: () => Promise<PreviewResult>;
  save: (edits: Partial<Record<Role, Record<string, Scope>>>, expectedVersion: number, sensitiveConfirmed: boolean, reason: string) => Promise<CommandResult>;
  reset: (role: Role, expectedVersion: number, reason: string) => Promise<CommandResult>;
  adopt: (expectedVersion: number, reason: string) => Promise<CommandResult>;
};

type View = "people" | "permissions" | "history";
type Preview = { kind: "reset" | "adopt"; data: ServerPreview };

const scopeText = (s: Scope) => (s === "off" ? "Off" : s === "own" ? "Own assigned" : "Whole studio");

export function RolesEditor(props: RolesEditorProps) {
  const [view, setView] = useState<View>(props.initialView ?? "people");
  const [role, setRole] = useState<Role>("practitioner");
  const [saved, setSaved] = useState<Record<Role, StudioPolicy>>(props.policies);
  const [drafts, setDrafts] = useState<Record<Role, StudioPolicy>>(props.policies);
  const [rowError, setRowError] = useState<{ key: string; message: string } | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [reviewData, setReviewData] = useState<ServerPreview | null>(null);
  const [reason, setReason] = useState("");
  const router = useRouter();
  const [confirmed, setConfirmed] = useState(false);
  const [reviewed, setReviewed] = useState(props.reviewed);
  const feedback = useSaveFeedback();
  const baseId = useId();

  const dirtyRoles = ROLES.filter((r) => JSON.stringify(drafts[r].values) !== JSON.stringify(saved[r].values));
  const dirty = dirtyRoles.length > 0;
  useUnsavedChangesGuard("roles-draft", dirty);
  const readOnly = !props.writable;

  const sections = useMemo(() => buildRoleSections(role, drafts[role]), [role, drafts]);
  const savedRows = useMemo(
    () => new Map(buildRoleSections(role, saved[role]).flatMap((s) => [...s.common, ...s.advanced]).map((r) => [r.key, r])),
    [role, saved],
  );

  const peopleWith = (r: Role) => props.people.filter((p) => p.role === r && p.state === "active");
  const sensitiveCount = (reviewData?.roles ?? []).reduce((n, r) => n + r.diff.newlyEnabledSensitive, 0);

  function choose(key: string, scope: Scope) {
    const result = applyEdit(role, drafts[role], key, scope);
    if (!result.ok) {
      setRowError({ key, message: result.reason });
      return;
    }
    setRowError(null);
    feedback.reset();
    setReviewing(false);
    setReviewData(null);
    setDrafts((d) => ({ ...d, [role]: result.policy }));
  }

  function changedEdits() {
    const edits: Partial<Record<Role, Record<string, Scope>>> = {};
    for (const r of dirtyRoles) {
      const e: Record<string, Scope> = {};
      for (const [k, v] of Object.entries(drafts[r].values)) if (saved[r].values[k] !== v) e[k] = v;
      edits[r] = e;
    }
    return edits;
  }

  // A refusal never touches the draft. A per-key code opens that role and puts the message on the row; a stale version keeps every
  // choice and asks for a fresh review against the version the core now holds.
  function handleError(err: RoleError) {
    if (isRowError(err)) {
      if (err.role) setRole(err.role);
      setView("permissions");
      setRowError({ key: err.key, message: roleErrorMessage(err) });
    }
    if (err.code === "stale_version") {
      setReviewData(null);
      setPreview(null);
    }
    feedback.failed(roleErrorMessage(err));
  }

  async function onReview() {
    setReviewing(true);
    setReviewData(null);
    setConfirmed(false);
    const r = await props.previewSave(changedEdits());
    if (r.ok) setReviewData(r.preview);
    else handleError(r.error);
  }

  const needsReason = reviewing && reasonRequired("save", sensitiveCount > 0);
  const reasonOk = reasonAcceptable("save", sensitiveCount > 0, reason);

  async function onSave() {
    if (!reviewData) return;
    feedback.saving();
    const result = await props.save(changedEdits(), reviewData.version, confirmed, reason.trim());
    if (result.ok) {
      setSaved(drafts);
      setReviewing(false);
      setReviewData(null);
      setConfirmed(false);
      setReason("");
      feedback.saved();
    } else {
      handleError(result.error);
    }
  }

  function discard() {
    setDrafts(saved);
    setReviewing(false);
    setReviewData(null);
    setConfirmed(false);
    setReason("");
    setRowError(null);
    feedback.reset();
  }

  async function openPreview(kind: Preview["kind"]) {
    setReason("");
    const r = await (kind === "adopt" ? props.previewAdopt() : props.previewReset(role));
    if (r.ok) setPreview({ kind, data: r.preview });
    else handleError(r.error);
  }

  async function confirmPreview() {
    if (!preview) return;
    feedback.saving();
    const result = preview.kind === "adopt" ? await props.adopt(preview.data.version, reason.trim()) : await props.reset(role, preview.data.version, reason.trim());
    if (result.ok) {
      // The core owns the resulting policy; reload to read it rather than guess it here.
      setPreview(null);
      setReason("");
      feedback.saved();
      router.refresh();
    } else {
      handleError(result.error);
    }
  }

  const tabs: { id: View; label: string }[] = [
    { id: "people", label: "People" },
    { id: "permissions", label: "Permissions" },
    { id: "history", label: "History" },
  ];

  return (
    <div className="flex flex-col gap-8" data-testid="roles-editor">
      {!reviewed && (
        <section data-testid="roles-review-banner" className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
          <h3 className="font-medium">Your studio keeps its current access until you review it</h3>
          <p className="mt-1">
            Nothing changes for your staff until you adopt the new defaults or save your own settings. Review what would change for
            each role, then choose.
          </p>
          <button
            type="button"
            onClick={() => {
              setView("permissions");
              openPreview("adopt");
            }}
            className="mt-3 min-h-[44px] rounded-md border border-amber-400 px-3 py-2 text-sm font-medium hover:bg-amber-100 dark:border-amber-700 dark:hover:bg-amber-900"
          >
            Review changes for {ROLE_LABELS[role].toLowerCase()}s
          </button>
        </section>
      )}

      {!reviewed && (
        <section data-testid="release-narrowings-notice" className="rounded-lg border border-neutral-300 p-4 text-sm dark:border-neutral-700">
          <h3 className="font-medium">Coming with the access update: these become owner-only</h3>
          <p className="mt-1 text-neutral-600 dark:text-neutral-400">
            When access is enforced, only you can do the following. Practitioners can do some of them today. Nothing is deleted, and
            history stays recoverable. You will see this before it takes effect.
          </p>
          <ul className="mt-2 list-disc pl-5">
            {releaseNarrowings().map((f) => (
              <li key={f.id} data-release-narrowing={f.id} className="break-words">
                {f.label}
              </li>
            ))}
          </ul>
        </section>
      )}

      {readOnly && props.notWritableReason && (
        <p data-testid="roles-read-only" className="rounded-md border border-neutral-200 bg-neutral-50 p-3 text-sm text-neutral-600 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-400">
          {props.notWritableReason}
        </p>
      )}

      <div role="tablist" aria-label="Roles views" className="flex flex-wrap gap-2">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={view === t.id}
            data-roles-view={t.id}
            data-state={view === t.id ? "selected" : "idle"}
            onClick={() => setView(t.id)}
            className={`min-h-[44px] rounded-md border px-4 py-2 text-sm font-medium ${
              view === t.id
                ? "border-neutral-900 bg-neutral-900 text-white dark:border-white dark:bg-white dark:text-neutral-900"
                : "border-neutral-300 text-neutral-700 hover:bg-neutral-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-900"
            }`}
          >
            {t.label}
            {t.id === "permissions" && dirty ? " (unsaved)" : ""}
          </button>
        ))}
      </div>

      {view === "people" && <PeoplePanel people={props.people} saved={saved} />}

      {view === "history" && (
        <section data-testid="roles-history" className="flex flex-col gap-2">
          <h3 className="text-base font-medium">Change history</h3>
          <p className="text-sm text-neutral-600 dark:text-neutral-400">
            History starts when saving turns on. Each entry will show who changed a role or permission, when, the person or role
            affected, and the before and after values. It cannot be edited or deleted by staff.
          </p>
        </section>
      )}

      {view === "permissions" && (
        <div className="flex min-w-0 flex-col gap-8">
          <div role="tablist" aria-label="Role" className="flex gap-2">
            {ROLES.map((r) => (
              <button
                key={r}
                type="button"
                role="tab"
                aria-selected={role === r}
                data-role-tab={r}
                data-state={role === r ? "selected" : "idle"}
                onClick={() => {
                  setRole(r);
                  setPreview(null);
                  setRowError(null);
                }}
                className={`min-h-[44px] rounded-md border px-4 py-2 text-sm font-medium ${
                  role === r
                    ? "border-neutral-900 bg-neutral-100 dark:border-white dark:bg-neutral-800"
                    : "border-neutral-300 text-neutral-700 dark:border-neutral-700 dark:text-neutral-300"
                }`}
              >
                {ROLE_LABELS[r]}
                {dirtyRoles.includes(r) ? " (unsaved)" : ""}
              </button>
            ))}
          </div>

          <p data-testid="role-holders" className="text-sm text-neutral-600 dark:text-neutral-400">
            {peopleWith(role).length === 0
              ? `No active ${ROLE_LABELS[role].toLowerCase()}s yet. Changes apply when someone holds this role.`
              : `Editing this role changes access for every active ${ROLE_LABELS[role].toLowerCase()} in this studio: ${peopleWith(role).map((p) => p.name).join(", ")}.`}
          </p>

          {preview && (
            <PreviewPanel
              kind={preview.kind}
              role={role}
              data={preview.data}
              canConfirm={props.writable && reasonAcceptable(preview.kind, false, reason)}
              blockedReason={props.writable ? null : props.notWritableReason}
              reason={reason}
              onReason={setReason}
              onConfirm={confirmPreview}
              onCancel={() => setPreview(null)}
            />
          )}

          {sections.map((sec) => (
            <section key={sec.id} aria-labelledby={`${baseId}-${sec.id}`} data-permission-section={sec.id} className="flex min-w-0 flex-col gap-3">
              <h3 id={`${baseId}-${sec.id}`} className="text-base font-medium">
                {sec.label}
              </h3>
              <RowList rows={sec.common} {...{ role, baseId, readOnly, rowError, choose, savedRows }} />
              {sec.advanced.length > 0 && (
                <details data-advanced={sec.id} className="rounded-lg border border-neutral-200 dark:border-neutral-800">
                  <summary className="min-h-[44px] cursor-pointer px-4 py-3 text-sm font-medium">
                    Advanced ({sec.advanced.length})
                  </summary>
                  <RowList rows={sec.advanced} {...{ role, baseId, readOnly, rowError, choose, savedRows }} />
                </details>
              )}
            </section>
          ))}

          <OwnerOnlySettingsNotes />

          {reviewing && (
            <ReviewPanel
              data={reviewData}
              sensitiveCount={sensitiveCount}
              confirmed={confirmed}
              onConfirmed={setConfirmed}
              needsReason={needsReason}
              reason={reason}
              onReason={setReason}
            />
          )}

          <div className="flex flex-wrap items-center gap-3">
            {!reviewing ? (
              <button
                type="button"
                onClick={onReview}
                disabled={!dirty}
                className="min-h-[44px] rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-white dark:text-neutral-900"
              >
                Review changes{dirty ? ` (${dirtyRoles.length === 1 ? "1 role" : "2 roles"})` : ""}
              </button>
            ) : (
              <button
                type="button"
                onClick={onSave}
                disabled={!props.writable || !reviewData || feedback.state.kind === "saving" || (sensitiveCount > 0 && !confirmed) || !reasonOk}
                className="min-h-[44px] rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-white dark:text-neutral-900"
              >
                Save changes
              </button>
            )}
            <button type="button" onClick={discard} disabled={!dirty} className="min-h-[44px] rounded-md border border-neutral-300 px-4 py-2 text-sm disabled:opacity-50 dark:border-neutral-700">
              Discard changes
            </button>
            <button
              type="button"
              onClick={() => openPreview("reset")}
              className="min-h-[44px] rounded-md border border-neutral-300 px-4 py-2 text-sm hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
            >
              Reset {ROLE_LABELS[role].toLowerCase()}s to defaults
            </button>
            <SaveStatus state={feedback.state} />
          </div>
          <p className="text-xs text-neutral-500">Changes apply to each person&rsquo;s next request, including people who are signed in now.</p>
        </div>
      )}
    </div>
  );
}

function RowList({
  rows,
  role,
  baseId,
  readOnly,
  rowError,
  choose,
  savedRows,
}: {
  rows: RoleRow[];
  role: Role;
  baseId: string;
  readOnly: boolean;
  rowError: { key: string; message: string } | null;
  choose: (key: string, scope: Scope) => void;
  savedRows: Map<string, RoleRow>;
}): ReactNode {
  return (
    <ul className="divide-y divide-neutral-200 overflow-hidden rounded-lg border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
      {rows.map((row) => {
        const unsaved = savedRows.get(row.key)?.chosen !== row.chosen;
        return (
          <li key={row.key} data-permission-row={row.key} data-chosen={row.chosen} data-effective={row.effective} data-unsaved={unsaved ? "true" : "false"} className="flex min-w-0 flex-col gap-2 px-4 py-3">
            <fieldset disabled={readOnly || row.locked !== null} className="min-w-0">
              <legend className="min-w-0 break-words text-sm font-medium">{row.label}</legend>
              <p className="mt-0.5 break-words text-xs text-neutral-500">{row.description}</p>
              {row.ownMeaning && <p className="mt-0.5 break-words text-xs text-neutral-500">Own assigned means: {row.ownMeaning}.</p>}
              <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-neutral-500">
                <span data-testid="default-setting">New-studio default: {scopeText(row.defaultScope)}</span>
                {unsaved && <span data-testid="unsaved-mark" className="font-medium text-neutral-800 dark:text-neutral-200">Unsaved change</span>}
              </div>
              {row.needs.length > 0 && (
                <p data-testid="requires" className="mt-0.5 break-words text-xs text-neutral-500">
                  Requires: {row.needs.join(", ")}
                </p>
              )}
              {row.consequence && (
                <p data-testid="consequence" data-consequence={row.consequence} className="mt-1 break-words text-xs font-medium text-neutral-700 dark:text-neutral-300">
                  {CONSEQUENCE_LABEL[row.consequence]}
                </p>
              )}
              {row.futureBusiness && (
                <p data-testid="affects-future-business" className="mt-0.5 text-xs font-medium text-neutral-700 dark:text-neutral-300">
                  Affects future studio business
                </p>
              )}
              {row.futureBusiness && FUTURE_EFFECTS[row.key] && (
                <p data-testid="future-effect" className="mt-0.5 break-words text-xs text-neutral-600 dark:text-neutral-400">
                  {FUTURE_EFFECTS[row.key]}
                </p>
              )}
              <div className="mt-2 flex flex-wrap gap-2">
                {row.options.map((o) => (
                  <label
                    key={o.scope}
                    className={`inline-flex min-h-[44px] cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm ${
                      o.selected ? "border-neutral-900 bg-neutral-100 font-medium dark:border-white dark:bg-neutral-800" : "border-neutral-300 dark:border-neutral-700"
                    } ${o.disabled ? "cursor-not-allowed opacity-60" : ""}`}
                  >
                    <input
                      type="radio"
                      name={`${baseId}-${role}-${row.key}`}
                      value={o.scope}
                      checked={o.selected}
                      disabled={o.disabled}
                      aria-describedby={o.reason ? `${baseId}-${row.key}-${o.scope}-why` : undefined}
                      onChange={() => choose(row.key, o.scope)}
                    />
                    {o.label}
                  </label>
                ))}
              </div>
            </fieldset>
            {row.options.filter((o) => o.disabled && o.reason).map((o) => (
              <p key={o.scope} id={`${baseId}-${row.key}-${o.scope}-why`} className="break-words text-xs text-neutral-500">
                {o.label} is unavailable. {o.reason}
              </p>
            ))}
            {row.locked && <p className="break-words text-xs text-neutral-500">{row.locked}</p>}
            {BASELINE_NOTES[row.key] && (
              <p data-testid="baseline-note" className="break-words text-xs text-neutral-600 dark:text-neutral-400">
                {BASELINE_NOTES[row.key]}
              </p>
            )}
            {row.inactiveBecause && (
              <p data-testid="inactive-because" className="break-words text-xs text-amber-800 dark:text-amber-300">
                Chosen but not in force. {row.inactiveBecause}
              </p>
            )}
            {row.alsoSwitchesOff.length > 0 && row.chosen !== "off" && (
              <p className="break-words text-xs text-neutral-500">
                If you turn this off, these switch off with it (their settings are kept): {row.alsoSwitchesOff.join(", ")}.
              </p>
            )}
            {row.gateNote && (
              <p data-testid="not-available-yet" className="break-words text-xs font-medium text-neutral-700 dark:text-neutral-300">
                Not available yet. {row.gateNote}.
              </p>
            )}
            {row.heldUntil && (
              <p data-testid="held-until" className="break-words text-xs text-neutral-500">
                Raising this is held until: {row.heldUntil}.
              </p>
            )}
            {row.snapshotBasis === "approved_policy" && (
              <p data-testid="approved-policy-note" className="break-words text-xs text-amber-800 dark:text-amber-300">
                Approved policy: not yet enforced everywhere. The setting shown is the approved one; the database may still allow more until the closing changes ship.
              </p>
            )}
            {BOOKING_RULES_KEYS.includes(row.key) && (
              <p data-testid="booking-rules-scope" className="break-words text-xs text-neutral-500">
                {BOOKING_RULES_SCOPE_TEXT} See{" "}
                {BOOKING_RULES_LINKS.map((l, i) => (
                  <span key={l.href}>
                    {i > 0 && " and "}
                    <Link href={l.href} className="underline">
                      {l.label}
                    </Link>
                  </span>
                ))}
                .
              </p>
            )}
            {row.pendingDecision && <p className="text-xs text-neutral-500">This default is still being decided; it keeps today&rsquo;s behaviour.</p>}
            {rowError?.key === row.key && (
              <p role="alert" className="break-words text-xs text-red-700 dark:text-red-400">
                {rowError.message}
              </p>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function OwnerOnlySettingsNotes(): ReactNode {
  return (
    <section data-testid="owner-only-settings" aria-label="Owner-only settings" className="flex min-w-0 flex-col gap-3">
      <h3 className="text-base font-medium">Only you can change these</h3>
      <div data-owner-only="erase_client_permanently" className="rounded-lg border border-neutral-200 p-4 text-sm dark:border-neutral-800">
        <p className="font-medium">{ERASURE_NOTE.title}</p>
        <p className="mt-1 break-words text-neutral-600 dark:text-neutral-400">{ERASURE_NOTE.body}</p>
      </div>
      <div data-owner-only="client_portal_setting" className="rounded-lg border border-neutral-200 p-4 text-sm dark:border-neutral-800">
        <p className="font-medium">{PORTAL_OFF_CONFIRMATION.title}</p>
        <p className="mt-1 text-neutral-600 dark:text-neutral-400">{PORTAL_OFF_CONFIRMATION.intro}</p>
        <ul className="mt-1 list-disc pl-5 text-neutral-600 dark:text-neutral-400">
          {PORTAL_OFF_CONFIRMATION.affected.map((a) => (
            <li key={a} className="break-words">
              {a}
            </li>
          ))}
        </ul>
        <p className="mt-1 break-words text-neutral-600 dark:text-neutral-400">{PORTAL_OFF_CONFIRMATION.continues}</p>
      </div>
    </section>
  );
}

function PeoplePanel({ people, saved }: { people: PersonView[]; saved: Record<Role, StudioPolicy> }) {
  const [open, setOpen] = useState<string | null>(null);
  const groups: { state: PersonView["state"]; label: string; empty: string }[] = [
    { state: "active", label: "Active", empty: "" },
    { state: "invited", label: "Invitation pending", empty: "Nobody is waiting to join." },
    { state: "deactivated", label: "Deactivated", empty: "Nobody has been deactivated." },
  ];
  return (
    <div data-testid="roles-people" className="flex min-w-0 flex-col gap-8">
      <p className="text-sm text-neutral-500">
        Add, remove or invite people in{" "}
        <a href="/settings/team" className="font-medium text-neutral-900 underline underline-offset-2 dark:text-neutral-100">
          Team
        </a>
        . Ownership changes use their own protected steps.
      </p>
      {groups.map((g) => {
        const list = people.filter((p) => p.state === g.state);
        return (
          <section key={g.state} data-people-state={g.state} className="flex min-w-0 flex-col gap-2">
            <h3 className="text-base font-medium">
              {g.label} ({list.length})
            </h3>
            {list.length === 0 ? (
              g.empty ? <p className="text-sm text-neutral-500">{g.empty}</p> : null
            ) : (
              <ul className="divide-y divide-neutral-200 overflow-hidden rounded-lg border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
                {list.map((p) => (
                  <li key={`${p.state}-${p.id}`} data-person={p.id} className="min-w-0 px-4 py-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="min-w-0">
                        <div className="break-words font-medium">{p.name}</div>
                        <div className="break-all text-xs text-neutral-500">{p.email}</div>
                      </div>
                      <span className="rounded-sm border border-neutral-300 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-neutral-600 dark:border-neutral-700 dark:text-neutral-400">
                        {p.role === "owner" ? "Owner" : ROLE_LABELS[p.role]}
                      </span>
                    </div>
                    <button
                      type="button"
                      aria-expanded={open === p.id}
                      onClick={() => setOpen(open === p.id ? null : p.id)}
                      className="mt-2 min-h-[44px] text-sm font-medium underline underline-offset-2"
                    >
                      {open === p.id ? "Hide access" : "View access"}
                    </button>
                    {open === p.id && <AccessSummary person={p} saved={saved} />}
                  </li>
                ))}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}

function AccessSummary({ person, saved }: { person: PersonView; saved: Record<Role, StudioPolicy> }) {
  if (person.state === "invited") return <p data-testid="access-summary" className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">An invitation has no access to the studio until it is accepted.</p>;
  if (person.state === "deactivated") return <p data-testid="access-summary" className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">This person is deactivated and has no access to the studio.</p>;
  if (person.role === "owner")
    return <p data-testid="access-summary" className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">Owners have every permission. Owner access is protected and cannot be changed here.</p>;
  const sections = buildRoleSections(person.role, saved[person.role]);
  return (
    <div data-testid="access-summary" className="mt-2 flex flex-col gap-3 text-sm">
      <p className="text-neutral-600 dark:text-neutral-400">
        Saved access for a {ROLE_LABELS[person.role].toLowerCase()}, as it applies today. Unsaved edits are not shown here.
      </p>
      {sections.map((s) => (
        <div key={s.id}>
          <h4 className="font-medium">{s.label}</h4>
          <ul className="mt-1 flex flex-col gap-0.5">
            {[...s.common, ...s.advanced].map((r) => (
              <li key={r.key} data-access-row={r.key} data-effective={r.effective} className="break-words text-xs">
                {r.label}: <span className="font-medium">{r.effective === "off" ? "Off" : r.options.find((o) => o.scope === r.effective)?.label ?? scopeText(r.effective)}</span>
                {r.inactiveBecause ? <span className="text-neutral-500"> ({r.inactiveBecause})</span> : null}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

function DiffList({ item, testPrefix }: { item: RolePreview; testPrefix: "review" | "preview" }): ReactNode {
  const { diff } = item;
  return (
    <>
      <p className="break-words text-sm text-neutral-600 dark:text-neutral-400">
        Affects {item.count === 0 ? "nobody yet" : item.people.map((p) => p.name).join(", ")} ({item.count}). {diff.widened} gain access, {diff.narrowed} lose access.
      </p>
      {diff.newlyEnabledSensitive > 0 && testPrefix === "preview" && (
        <p data-testid="preview-sensitive" role="alert" className="rounded-md bg-red-50 p-2 text-sm font-medium text-red-900 dark:bg-red-950 dark:text-red-200">
          {diff.newlyEnabledSensitive} newly enabled financial or sensitive {diff.newlyEnabledSensitive === 1 ? "permission" : "permissions"}. Check these before you confirm.
        </p>
      )}
      {diff.fixedNarrowings.length > 0 && (
        <div data-testid="preview-fixed-narrowings" className="rounded-md bg-amber-50 p-2 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-200">
          <p className="font-medium">These become owner-only, so practitioners lose the access they have today:</p>
          <ul className="mt-1 list-disc pl-5">
            {diff.fixedNarrowings.map((f) => (
              <li key={f.id} data-fixed-narrowing={f.id}>{f.label}</li>
            ))}
          </ul>
        </div>
      )}
      <ul className="flex flex-col gap-1">
        {diff.changes.map((c) => (
          <li key={c.key} data-review-change={testPrefix === "review" ? c.key : undefined} data-preview-change={testPrefix === "preview" ? c.key : undefined} data-direction={c.direction} data-sensitive={c.newlyEnabledSensitive ? "true" : "false"} className={`break-words rounded-md px-2 py-1 text-sm ${c.newlyEnabledSensitive ? "bg-red-50 font-medium dark:bg-red-950" : ""}`}>
            <span className="text-neutral-500">{c.groupLabel}: </span>
            {c.label}: {scopeText(c.from)} to {scopeText(c.to)}
            {c.futureBusiness ? " (affects future studio business)" : ""}
          </li>
        ))}
      </ul>
    </>
  );
}

function ReasonField({ id, value, onChange, required }: { id: string; value: string; onChange: (v: string) => void; required: boolean }): ReactNode {
  return (
    <label htmlFor={id} className="flex min-w-0 flex-col gap-1 text-sm">
      <span className="font-medium">Why are you making this change?{required ? "" : " (optional)"}</span>
      <input
        id={id}
        data-testid="reason-input"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="min-h-[44px] rounded-md border border-neutral-300 px-3 py-2 dark:border-neutral-700"
        aria-describedby={`${id}-hint`}
      />
      <span id={`${id}-hint`} className="text-xs text-neutral-500">
        {required ? "Required: say why in your own words. " : ""}The before and after are recorded automatically; your reason is kept with them in the change history.
      </span>
    </label>
  );
}

function ReviewPanel({
  data,
  sensitiveCount,
  confirmed,
  onConfirmed,
  needsReason,
  reason,
  onReason,
}: {
  data: ServerPreview | null;
  sensitiveCount: number;
  confirmed: boolean;
  onConfirmed: (v: boolean) => void;
  needsReason: boolean;
  reason: string;
  onReason: (v: string) => void;
}) {
  const id = useId();
  return (
    <section data-testid="roles-review" aria-label="Review changes" className="flex min-w-0 flex-col gap-4 rounded-lg border border-neutral-300 p-4 dark:border-neutral-700">
      <h3 className="text-base font-medium">Review changes</h3>
      {!data && <p className="text-sm text-neutral-600 dark:text-neutral-400">Checking what these changes would do&hellip;</p>}
      {data?.roles.map((item) => (
        <div key={item.role} data-review-role={item.role} className="flex min-w-0 flex-col gap-2">
          <h4 className="font-medium">{ROLE_LABELS[item.role]}s</h4>
          <DiffList item={item} testPrefix="review" />
        </div>
      ))}
      {data && sensitiveCount > 0 && (
        <label className="flex items-start gap-2 text-sm font-medium">
          <input type="checkbox" checked={confirmed} onChange={(e) => onConfirmed(e.target.checked)} className="mt-1" />
          <span data-testid="review-sensitive">
            I understand this newly enables {sensitiveCount} financial or sensitive {sensitiveCount === 1 ? "permission" : "permissions"}.
          </span>
        </label>
      )}
      {data && <ReasonField id={`${id}-reason`} value={reason} onChange={onReason} required={needsReason} />}
    </section>
  );
}

function PreviewPanel({
  kind,
  role,
  data,
  canConfirm,
  blockedReason,
  reason,
  onReason,
  onConfirm,
  onCancel,
}: {
  kind: "reset" | "adopt";
  role: Role;
  data: ServerPreview;
  canConfirm: boolean;
  blockedReason: string | null;
  reason: string;
  onReason: (v: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const id = useId();
  const empty = data.roles.every((r) => r.diff.changes.length === 0 && r.diff.fixedNarrowings.length === 0);
  return (
    <section data-testid="roles-preview" aria-label={kind === "adopt" ? "Review new defaults" : "Reset to defaults"} className="flex min-w-0 flex-col gap-3 rounded-lg border border-neutral-300 p-4 dark:border-neutral-700">
      <h3 className="text-base font-medium">
        {kind === "adopt" ? "Adopt the new defaults" : `Reset to defaults for ${ROLE_LABELS[role].toLowerCase()}s`}
      </h3>
      {empty ? (
        <p className="text-sm text-neutral-600 dark:text-neutral-400">Nothing would change. These settings already match the defaults.</p>
      ) : (
        data.roles.map((item) => (
          <div key={item.role} data-preview-role={item.role} className="flex min-w-0 flex-col gap-2">
            {data.roles.length > 1 && <h4 className="font-medium">{ROLE_LABELS[item.role]}s</h4>}
            <DiffList item={item} testPrefix="preview" />
          </div>
        ))
      )}
      <ReasonField id={`${id}-reason`} value={reason} onChange={onReason} required={reasonRequired(kind, false)} />
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" onClick={onConfirm} disabled={!canConfirm} className="min-h-[44px] rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-white dark:text-neutral-900">
          {kind === "adopt" ? "Adopt these defaults" : "Confirm reset"}
        </button>
        <button type="button" onClick={onCancel} className="min-h-[44px] rounded-md border border-neutral-300 px-4 py-2 text-sm dark:border-neutral-700">
          Cancel
        </button>
      </div>
      {!canConfirm && blockedReason && <p className="text-xs text-neutral-500">{blockedReason}</p>}
    </section>
  );
}
