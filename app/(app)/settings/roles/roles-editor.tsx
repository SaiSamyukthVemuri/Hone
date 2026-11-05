"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { CATALOG, ROLES, type PermissionDef, type Role, type Scope, type StudioPolicy } from "@/lib/permissions/catalog";
import { applyEdit, buildRoleSections, ENFORCEMENT_SCOPE_LINE, NOT_ENFORCED_LINE, ROLE_LABELS, WIDENING_LATER_LINE, type RoleRow } from "@/lib/settings/roles/model";
import { CONSEQUENCE_LABEL } from "@/lib/settings/roles/sections";
import { releaseNarrowings } from "@/lib/settings/roles/diff";
import { classifyUnexpected, UNCERTAIN_SAVE_MESSAGE, type AttemptedEdits } from "@/lib/settings/roles/unexpected";
import { changeRoleCopy } from "@/lib/settings/roles/change-role";
import { pendingActivations, type PendingActivation } from "@/lib/settings/roles/server-effective";
import { BASELINE_NOTES, FUTURE_EFFECTS } from "@/lib/settings/roles/effects";
import {
  isRowError,
  reasonAcceptable,
  reasonRequired,
  roleErrorMessage,
  AUDIT_KIND_LABEL,
  appendHistoryPage,
  type AccessResult,
  type ActivationPreview,
  type ActivationPreviewResult,
  type AuditRow,
  type ChangeRoleResult,
  type CommandResult,
  type HistoryResult,
  type PreviewResult,
  type RoleError,
  type RolePreview,
  type ServerPreview,
} from "@/lib/settings/roles/api";
import type { StudioPolicyState } from "@/lib/settings/roles/policy-store";
import { FormattedDateTime } from "@/components/formatted-date-time";
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
  // The signed-in owner's own row. Their role cannot be changed here (the core refuses it too).
  isSelf?: boolean;
};

export type RolesEditorProps = {
  policies: Record<Role, StudioPolicy>;
  reviewed: boolean;
  writable: boolean;
  notWritableReason: string | null;
  // The operator ship gate for changing a person's role (change_staff_role). Off: the page says it is not available yet.
  staffRoleChange: boolean;
  initialView?: "people" | "permissions" | "history";
  people: PersonView[];
  // The studio's IANA timezone, for the history timestamps.
  timezone: string;
  // Every preview and every write is the permission core's. The page sends only changed keys and the version a preview returned.
  previewSave: (edits: Partial<Record<Role, Record<string, Scope>>>) => Promise<PreviewResult>;
  previewReset: (role: Role) => Promise<PreviewResult>;
  previewAdopt: () => Promise<PreviewResult>;
  save: (edits: Partial<Record<Role, Record<string, Scope>>>, expectedVersion: number, sensitiveConfirmed: boolean, reason: string) => Promise<CommandResult>;
  // The authoritative policy as the core holds it now; read after a save so the page never assumes its draft became the saved state.
  reload: () => Promise<{ ok: true; state: StudioPolicyState } | { ok: false; error: RoleError }>;
  reset: (role: Role, expectedVersion: number, reason: string, sensitiveConfirmed: boolean) => Promise<CommandResult>;
  adopt: (expectedVersion: number, reason: string, sensitiveConfirmed: boolean) => Promise<CommandResult>;
  // Released settings the owner has not activated yet: the core previews the change (with a digest) and commits only that exact preview.
  previewActivation: (keys: string[]) => Promise<ActivationPreviewResult>;
  activate: (keys: string[], expectedVersion: number, reason: string, previewDigest: string, sensitiveConfirmed: boolean) => Promise<CommandResult>;
  loadHistory: (before: string | null) => Promise<HistoryResult>;
  loadAccess: (membershipId: string) => Promise<AccessResult>;
  // Move one person between practitioner and receptionist. The core is the only writer and the only judge (gate, self, owner, stale
  // role, upcoming appointments); the page shows exactly what it answers.
  changeRole: (membershipId: string, newRole: Role, expectedCurrentRole: Role, reason: string) => Promise<ChangeRoleResult>;
};

type View = "people" | "permissions" | "history";
// `role` is the role that was PREVIEWED: a reset is confirmed for that role, whatever tab is showing when the owner clicks.
type Preview = { kind: "reset" | "adopt"; role: Role; data: ServerPreview };

const scopeText = (s: Scope) => (s === "off" ? "Off" : s === "own" ? "Own assigned" : "Whole studio");

export function RolesEditor(props: RolesEditorProps) {
  const [view, setView] = useState<View>(props.initialView ?? "people");
  const [role, setRole] = useState<Role>("practitioner");
  const [saved, setSaved] = useState<Record<Role, StudioPolicy>>(props.policies);
  const [drafts, setDrafts] = useState<Record<Role, StudioPolicy>>(props.policies);
  const [rowError, setRowError] = useState<{ key: string; message: string } | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  // The owner's explicit confirmation when a reset or adopt would newly enable a sensitive permission (the core refuses without it).
  const [previewConfirmed, setPreviewConfirmed] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [reviewData, setReviewData] = useState<ServerPreview | null>(null);
  const [reason, setReason] = useState("");
  const router = useRouter();
  const [confirmed, setConfirmed] = useState(false);
  const [reviewed, setReviewed] = useState(props.reviewed);
  const feedback = useSaveFeedback();
  const baseId = useId();
  // Bumped whenever a pending preview stops being wanted (tab switch, cancel), so a late response is ignored.
  const previewSeq = useRef(0);
  // Codex P2 4476375641: a reset or adoption preview describes the SAVED state and its confirm replaces the page with the result, so it must not
  // outlive an edit. Any edit drops it (and ignores a preview response still in flight); confirm also refuses while the draft is dirty.
  function dropPreview() {
    previewSeq.current += 1;
    setPreview(null);
    setPreviewConfirmed(false);
  }
  // PY-3. The review is sequenced the same way: a late preview from an earlier click is ignored, and Save sends the edits that were
  // PREVIEWED (not whatever the draft has become), so the owner cannot confirm a consequence list that is not the one being saved.
  const reviewSeq = useRef(0);
  const reviewedEdits = useRef<Partial<Record<Role, Record<string, Scope>>> | null>(null);

  const dirtyRoles = ROLES.filter((r) => JSON.stringify(drafts[r].values) !== JSON.stringify(saved[r].values));
  const dirty = dirtyRoles.length > 0;
  useUnsavedChangesGuard("roles-draft", dirty);
  const readOnly = !props.writable;

  const sections = useMemo(() => buildRoleSections(role, drafts[role]), [role, drafts]);
  const savedRows = useMemo(
    () => new Map(buildRoleSections(role, saved[role]).flatMap((s) => [...s.common, ...s.advanced]).map((r) => [r.key, r])),
    [role, saved],
  );

  // Settings the core has released but the owner has not activated: saved or default values that are NOT in force yet.
  const pending = useMemo(() => pendingActivations(props.policies), [props.policies]);

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
    reviewSeq.current += 1;
    reviewedEdits.current = null;
    setReviewing(false);
    setReviewData(null);
    dropPreview();
    setDrafts((d) => ({ ...d, [role]: result.policy }));
  }

  // Discard a saved choice that is waiting on a release: stage the key back on the studio's basis in the draft. Nothing is written
  // until the owner goes through the usual Review and Save, so the core previews it and records who did it.
  function stageBasisChoice(forRole: Role, key: string, basis: Scope) {
    const result = applyEdit(forRole, drafts[forRole], key, basis);
    if (!result.ok) {
      setRowError({ key, message: result.reason });
      return;
    }
    setRole(forRole);
    setRowError(null);
    feedback.reset();
    reviewSeq.current += 1;
    reviewedEdits.current = null;
    setReviewing(false);
    setReviewData(null);
    dropPreview();
    setDrafts((d) => ({ ...d, [forRole]: result.policy }));
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
      // Back to the draft, every choice kept, with the Review button available again for a fresh preview.
      setReviewing(false);
      setReviewData(null);
      setConfirmed(false);
      setPreview(null);
    }
    feedback.failed(roleErrorMessage(err));
  }

  async function onReview() {
    const seq = ++reviewSeq.current;
    const edits = changedEdits();
    reviewedEdits.current = null;
    setReviewing(true);
    setReviewData(null);
    setConfirmed(false);
    const r = await props.previewSave(edits);
    if (seq !== reviewSeq.current) return; // the draft changed (or the review was closed) while the core was answering
    if (r.ok) {
      reviewedEdits.current = edits;
      setReviewData(r.preview);
    } else handleError(r.error);
  }

  const needsReason = reviewing && reasonRequired("save", sensitiveCount > 0);
  const reasonOk = reasonAcceptable("save", sensitiveCount > 0, reason);

  async function onSave() {
    if (!reviewData || !reviewedEdits.current) return;
    feedback.saving();
    const boundVersion = reviewData.version;
    const result = await props.save(reviewedEdits.current, boundVersion, confirmed, reason.trim());
    if (result.ok) {
      // The core owns what was saved: read it back rather than assume the draft became the saved state.
      const fresh = await props.reload();
      if (fresh.ok) {
        setSaved(fresh.state.policies);
        setDrafts(fresh.state.policies);
        setReviewed(fresh.state.reviewed);
      } else {
        // Could not read it back: do not claim a state we have not seen. Refresh the page from the server.
        router.refresh();
      }
      setReviewing(false);
      setReviewData(null);
      setConfirmed(false);
      setReason("");
      feedback.saved();
    } else if (result.error.code === "unexpected") {
      await resolveUnexpected(boundVersion, reviewedEdits.current);
    } else {
      handleError(result.error);
    }
  }

  // PY-6. A transport error after a commit looks the same as a failure, so "Nothing was changed" cannot be claimed. Read the policy
  // back: a moved version means it went through; the same version means it did not; an unreadable policy is said plainly.
  // A moved version alone is never proof (another writer may have committed): success is claimed only when the reloaded choices equal
  // the exact set this operation attempted. Otherwise the draft is kept and the outcome is said to be uncertain.
  async function resolveUnexpected(boundVersion: number, attempted: AttemptedEdits | null) {
    const fresh = await props.reload();
    const outcome = classifyUnexpected({
      boundVersion,
      attempted,
      fresh: fresh.ok ? { version: fresh.state.version, policies: fresh.state.policies } : null,
    });
    if (outcome === "unreadable" || !fresh.ok) {
      feedback.failed("We could not confirm whether that was saved. Reload the page to check before trying again.");
      return;
    }
    if (outcome === "unchanged") {
      feedback.failed("Something went wrong. We checked, and nothing was changed.");
      return;
    }
    setSaved(fresh.state.policies);
    setReviewed(fresh.state.reviewed);
    setReviewing(false);
    setReviewData(null);
    setPreview(null);
    setConfirmed(false);
    if (outcome === "landed") {
      setDrafts(fresh.state.policies);
      setReason("");
      feedback.failed("The response was lost, but the change went through. The page now shows what is saved.");
      return;
    }
    // Uncertain: our draft stays exactly as the person left it, against the permissions as they are now.
    feedback.failed(UNCERTAIN_SAVE_MESSAGE);
  }

  function discard() {
    reviewSeq.current += 1;
    setDrafts(saved);
    setReviewing(false);
    setReviewData(null);
    setConfirmed(false);
    setReason("");
    setRowError(null);
    feedback.reset();
  }

  async function openPreview(kind: Preview["kind"]) {
    // PY-4. Reset and adopt replace the page with the saved state and would drop every unsaved choice, on both roles, without a
    // warning. They are refused while there are unsaved choices.
    if (dirty) {
      feedback.failed("You have unsaved changes. Save or discard them first; resetting or adopting would replace them.");
      return;
    }
    setReason("");
    setPreviewConfirmed(false);
    const forRole = role;
    const seq = ++previewSeq.current;
    const r = await (kind === "adopt" ? props.previewAdopt() : props.previewReset(forRole));
    // A tab switch or cancel while the core was answering makes this response stale: it belongs to a view that is gone.
    if (seq !== previewSeq.current) return;
    if (r.ok) setPreview({ kind, role: forRole, data: r.preview });
    else handleError(r.error);
  }

  async function confirmPreview() {
    if (!preview) return;
    // Defence in depth: the preview is dropped on every edit, but a confirm that still arrives with unsaved choices is refused, never run.
    if (dirty) {
      dropPreview();
      feedback.failed("You have unsaved changes. Save or discard them first; resetting or adopting would replace them.");
      return;
    }
    feedback.saving();
    const boundVersion = preview.data.version;
    const result =
      preview.kind === "adopt" ? await props.adopt(boundVersion, reason.trim(), previewConfirmed) : await props.reset(preview.role, boundVersion, reason.trim(), previewConfirmed);
    if (!result.ok && result.error.code === "unexpected") {
      await resolveUnexpected(boundVersion, null);
      return;
    }
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

      {view === "people" && <PeoplePanel people={props.people} loadAccess={props.loadAccess} staffRoleChange={props.staffRoleChange} changeRole={props.changeRole} refresh={() => router.refresh()} />}

      {view === "history" && <HistoryPanel load={props.loadHistory} timeZone={props.timezone} />}

      {view === "permissions" && (
        <div className="flex min-w-0 flex-col gap-8">
          <ActivationSection
            pending={pending}
            writable={props.writable}
            blockedByDraft={dirty}
            previewActivation={props.previewActivation}
            activate={props.activate}
            onActivated={() => router.refresh()}
            onDiscard={stageBasisChoice}
          />
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
                  previewSeq.current += 1;
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

          <p data-testid="enforcement-scope" className="rounded-md bg-neutral-50 p-3 text-sm text-neutral-700 dark:bg-neutral-900 dark:text-neutral-300">
            {ENFORCEMENT_SCOPE_LINE}
          </p>

          <p data-testid="role-holders" className="text-sm text-neutral-600 dark:text-neutral-400">
            {peopleWith(role).length === 0
              ? `No active ${ROLE_LABELS[role].toLowerCase()}s yet. Changes apply when someone holds this role.`
              : `Editing this role changes access for every active ${ROLE_LABELS[role].toLowerCase()} in this studio: ${peopleWith(role).map((p) => p.name).join(", ")}.`}
          </p>

          {preview && (
            <PreviewPanel
              kind={preview.kind}
              role={preview.role}
              data={preview.data}
              sensitiveCount={preview.data.roles.reduce((n, r) => n + r.diff.newlyEnabledSensitive, 0)}
              confirmed={previewConfirmed}
              onConfirmed={setPreviewConfirmed}
              canConfirm={props.writable && !dirty && reasonAcceptable(preview.kind, false, reason) && (preview.data.roles.reduce((n, r) => n + r.diff.newlyEnabledSensitive, 0) === 0 || previewConfirmed)}
              blockedReason={props.writable ? null : props.notWritableReason}
              reason={reason}
              onReason={setReason}
              onConfirm={confirmPreview}
              onCancel={() => {
                previewSeq.current += 1;
                setPreview(null);
              }}
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
          <p className="text-xs text-neutral-500">A saved change applies to a person&rsquo;s next request, including people who are signed in now, but only for settings the app already enforces. Settings marked &ldquo;Not enforced yet&rdquo; do nothing today.</p>
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
            <fieldset disabled={readOnly || row.locked !== null || (row.enforcement === "observe" || row.enforcement === "not_yet")} className="min-w-0">
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
            {row.enforcement === "deny_only" && (
              <p data-testid="deny-only-note" className="break-words text-xs text-neutral-600 dark:text-neutral-400">
                Turning this down takes effect now. {WIDENING_LATER_LINE}
              </p>
            )}
            {(row.enforcement === "observe" || row.enforcement === "not_yet") && (
              <p data-testid="not-enforced-yet" data-enforcement={row.enforcement} className="break-words text-xs font-medium text-neutral-700 dark:text-neutral-300">
                {NOT_ENFORCED_LINE}
              </p>
            )}
            {BASELINE_NOTES[row.key] && (
              <p data-testid="baseline-note" className="break-words text-xs text-neutral-600 dark:text-neutral-400">
                {BASELINE_NOTES[row.key]}
              </p>
            )}
            {row.inactiveUntil && (
              <p data-testid="inactive-until" className="break-words text-xs text-amber-800 dark:text-amber-300">
                {row.inactiveUntil}
              </p>
            )}
            {row.inactiveBecause && (
              <p data-testid="inactive-because" className="break-words text-xs text-amber-800 dark:text-amber-300">
                {row.inactiveBecause}
              </p>
            )}
            {row.alsoSwitchesOff.length > 0 && row.chosen !== "off" && (
              <p className="break-words text-xs text-neutral-500">
                If you turn this off, these become inactive (their settings are kept and apply again when this is back on): {row.alsoSwitchesOff.join(", ")}.
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

function HistoryPanel({ load, timeZone }: { load: (before: string | null) => Promise<HistoryResult>; timeZone: string }): ReactNode {
  const [state, setState] = useState<{ kind: "loading" } | { kind: "error"; message: string } | { kind: "rows"; rows: AuditRow[]; next: string | null }>({ kind: "loading" });
  // "Load older" appends the next page by the cursor the core returned. A failed page keeps what is shown and says so; a second click
  // while one is loading does nothing.
  const [more, setMore] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    load(null).then((r) => {
      if (!live.current) return;
      setState(r.ok ? { kind: "rows", rows: r.rows, next: r.next } : { kind: "error", message: roleErrorMessage(r.error) });
    });
    return () => {
      live.current = false;
    };
  }, [load]);
  const loadOlder = async (cursor: string) => {
    if (more.busy) return;
    setMore({ busy: true, error: null });
    const r = await load(cursor).catch(() => null);
    if (!live.current) return;
    if (!r || !r.ok) {
      setMore({ busy: false, error: r ? roleErrorMessage(r.error) : "Could not load older changes. Nothing was changed." });
      return;
    }
    setState((s) => (s.kind === "rows" ? { kind: "rows", rows: appendHistoryPage(s.rows, r.rows), next: r.next } : s));
    setMore({ busy: false, error: null });
  };
  return (
    <section data-testid="roles-history" className="flex min-w-0 flex-col gap-3">
      <h3 className="text-base font-medium">Change history</h3>
      <p className="text-sm text-neutral-600 dark:text-neutral-400">
        Every role and permission change: who made it, when, who or what it affected, and the before and after. Staff cannot edit or delete it.
      </p>
      {state.kind === "loading" && <p className="text-sm text-neutral-500">Loading&hellip;</p>}
      {state.kind === "error" && (
        <p data-testid="history-unavailable" className="text-sm text-neutral-600 dark:text-neutral-400">
          History is not available yet. {state.message}
        </p>
      )}
      {state.kind === "rows" && state.rows.length === 0 && <p className="text-sm text-neutral-500">No changes have been recorded yet.</p>}
      {state.kind === "rows" && (
        <ul className="flex flex-col gap-2">
          {state.rows.map((r) => (
            <li key={r.id} data-audit-kind={r.kind} className="min-w-0 break-words rounded-lg border border-neutral-200 p-3 text-sm dark:border-neutral-800">
              <p className="font-medium">{AUDIT_KIND_LABEL[r.kind]}</p>
              <p className="text-neutral-600 dark:text-neutral-400">
                {r.actorName} on <FormattedDateTime iso={r.at} timeZone={timeZone} />
                {r.role ? `, ${ROLE_LABELS[r.role].toLowerCase()}s` : ""}
                {r.personName ? `, ${r.personName}${r.personState === "deactivated" ? " (no longer active)" : ""}` : r.kind === "staff_role_changed" ? ", former member" : ""}
              </p>
              {r.reason && <p className="mt-1">Reason: {r.reason}</p>}
              <ul className="mt-1 text-xs text-neutral-600 dark:text-neutral-400">
                {Object.keys(r.after).map((k) => {
                  const hasStored = r.storedAfter[k] !== undefined || r.storedBefore[k] !== undefined;
                  // The saved choice and what is in force are shown SEPARATELY only when they differ: a setting not released or activated
                  // yet, or held inactive by a prerequisite, can be saved Off while access stays where it was.
                  const differs = hasStored && (r.storedBefore[k] !== r.before[k] || r.storedAfter[k] !== r.after[k]);
                  if (!differs) {
                    return (
                      <li key={k}>
                        {k}: {r.before[k] ?? "unset"} to {r.after[k]}
                      </li>
                    );
                  }
                  return (
                    <li key={k}>
                      <span data-testid="history-stored">
                        {k}: saved choice {r.storedBefore[k] ?? "unset"} to {r.storedAfter[k] ?? "unset"}
                      </span>
                      <span data-testid="history-in-force" className="block pl-3">
                        {r.before[k] === r.after[k] ? `in force: stays ${r.after[k]}` : `in force: ${r.before[k] ?? "unset"} to ${r.after[k]}`}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </li>
          ))}
        </ul>
      )}
      {state.kind === "rows" && more.error && (
        <p data-testid="history-more-error" role="alert" className="text-sm text-neutral-600 dark:text-neutral-400">
          {more.error}
        </p>
      )}
      {state.kind === "rows" && state.next !== null && (
        <button
          type="button"
          data-testid="history-load-older"
          disabled={more.busy}
          onClick={() => void loadOlder(state.next as string)}
          className="min-h-11 self-start rounded-lg border border-neutral-300 px-4 text-sm font-medium disabled:opacity-60 dark:border-neutral-700"
        >
          {more.busy ? "Loading\u2026" : "Load older changes"}
        </button>
      )}
    </section>
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

function PeoplePanel({
  people,
  loadAccess,
  staffRoleChange,
  changeRole,
  refresh,
}: {
  people: PersonView[];
  loadAccess: RolesEditorProps["loadAccess"];
  staffRoleChange: boolean;
  changeRole: RolesEditorProps["changeRole"];
  refresh: () => void;
}) {
  const [open, setOpen] = useState<string | null>(null);
  // A role change gives the person a NEW membership id, so their old row is gone after the refresh. The confirmation therefore lives
  // here, above the lists, and survives the row that produced it.
  const [notice, setNotice] = useState<string | null>(null);
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
      {notice && (
        <p role="status" data-testid="change-role-ok" className="break-words rounded-md border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700">
          {notice}
        </p>
      )}
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
                    {p.state === "active" && p.role !== "owner" && !staffRoleChange && (
                      <p data-testid="change-role-unavailable" className="break-words text-xs text-neutral-500">
                        Change role: not available yet.
                      </p>
                    )}
                    {p.state === "active" && p.role !== "owner" && staffRoleChange && p.isSelf && (
                      <p data-testid="change-role-self" className="break-words text-xs text-neutral-500">
                        You cannot change your own role.
                      </p>
                    )}
                    {p.state === "active" && p.role !== "owner" && staffRoleChange && !p.isSelf && (
                      <ChangeRole person={p as PersonView & { role: Role }} changeRole={changeRole} onChanged={(text) => { setNotice(text); refresh(); }} />
                    )}
                    {open === p.id && <AccessSummary person={p} load={loadAccess} />}
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

// Change one person's role. The consequences are stated before the owner confirms; the core decides everything else and its answer is
// shown as is. Nothing is deleted: the old membership is deactivated and the person keeps their sign-in.
function ChangeRole({ person, changeRole, onChanged }: { person: PersonView & { role: Role }; changeRole: RolesEditorProps["changeRole"]; onChanged: (notice: string) => void }) {
  const copy = changeRoleCopy(person.role);
  const target = copy.to;
  const widens = target === "practitioner";
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ kind: "error"; text: string } | null>(null);
  const id = useId();
  const needsReason = copy.reasonRequired;
  const reasonOk = reasonAcceptable(widens ? "adopt" : "save", false, reason);
  const canConfirm = !busy && reasonOk && (!needsReason || reason.trim() !== "");

  async function confirm() {
    if (!canConfirm) return;
    setBusy(true);
    setResult(null);
    try {
      const r = await changeRole(person.id, target, person.role, reason.trim());
      if (r.ok) {
        setOpen(false);
        setReason("");
        onChanged(`${person.name} is now a ${ROLE_LABELS[target].toLowerCase()}. It is in the history.`);
      } else {
        setResult({ kind: "error", text: roleErrorMessage(r.error) });
      }
    } catch {
      setResult({ kind: "error", text: roleErrorMessage({ code: "unexpected" }) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div data-testid="change-role" className="mt-1 flex min-w-0 flex-col gap-2">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={`${id}-panel`}
        onClick={() => {
          setOpen(!open);
          setResult(null);
        }}
        className="min-h-[44px] self-start text-sm font-medium underline underline-offset-2"
      >
        {open ? "Cancel role change" : "Change role"}
      </button>
      {open && (
        <div id={`${id}-panel`} data-testid="change-role-panel" className="flex min-w-0 flex-col gap-3 rounded-lg border border-neutral-200 p-3 text-sm dark:border-neutral-800">
          <p className="break-words font-medium">{copy.title(person.name)}</p>
          <ul className="list-disc space-y-1 pl-5 text-neutral-600 dark:text-neutral-400">
            {copy.bullets.map((b) => (
              <li key={b}>{b}</li>
            ))}
          </ul>
          <label className="flex flex-col gap-1">
            <span className="font-medium">{copy.reasonLabel}</span>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={2}
              maxLength={500}
              data-testid="change-role-reason"
              className="w-full rounded-md border border-neutral-300 bg-transparent px-3 py-2 text-base dark:border-neutral-700"
            />
          </label>
          {reason.trim() !== "" && !reasonOk && <p className="text-xs text-red-700 dark:text-red-400">Say why in your own words.</p>}
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={!canConfirm}
              onClick={confirm}
              data-testid="change-role-confirm"
              className="min-h-[44px] rounded-md bg-neutral-900 px-4 text-sm font-medium text-white disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900"
            >
              {busy ? "Changing…" : copy.confirmLabel}
            </button>
          </div>
        </div>
      )}
      {result && (
        <p role="alert" data-testid="change-role-error" className="break-words text-xs text-red-700 dark:text-red-400">
          {result.text}
        </p>
      )}
    </div>
  );
}

const CAP_TEXT = (c: string): string =>
  c === "deactivated" ? "person is deactivated" : c === "not_offered" ? "not offered to this role" : c.startsWith("gate:") ? "not available yet" : c.startsWith("requires:") ? "needs another permission first" : c;

function AccessSummary({ person, load }: { person: PersonView; load: RolesEditorProps["loadAccess"] }) {
  const [state, setState] = useState<{ kind: "loading" } | { kind: "error"; message: string } | Extract<AccessResult, { ok: true }>>({ kind: "loading" });
  const fixed = person.state !== "active" || person.role === "owner";
  useEffect(() => {
    if (fixed) return;
    let live = true;
    load(person.id).then((r) => {
      if (live) setState(r.ok ? r : { kind: "error", message: roleErrorMessage(r.error) });
    });
    return () => {
      live = false;
    };
  }, [fixed, load, person.id]);
  const note = "mt-2 text-sm text-neutral-600 dark:text-neutral-400";
  if (person.state === "invited") return <p data-testid="access-summary" className={note}>An invitation has no access to the studio until it is accepted.</p>;
  if (person.state === "deactivated") return <p data-testid="access-summary" className={note}>This person is deactivated and has no access to the studio.</p>;
  if (person.role === "owner") return <p data-testid="access-summary" className={note}>Owners have every permission. Owner access is protected and cannot be changed here.</p>;
  if ("kind" in state) {
    return (
      <p data-testid="access-summary" className={note}>
        {state.kind === "loading" ? "Loading what this person can do now…" : state.message}
      </p>
    );
  }
  const defs = new Map((CATALOG as readonly PermissionDef[]).map((d) => [d.key, d]));
  return (
    <div data-testid="access-summary" className="mt-2 flex flex-col gap-2 text-sm">
      <p className="text-neutral-600 dark:text-neutral-400">Access in force right now. Choices saved but waiting for activation, and unsaved edits, are not counted here.</p>
      <ul className="flex flex-col gap-0.5">
        {state.rows.map((r) => (
          <li key={r.key} data-access-row={r.key} data-effective={r.scope} className="break-words text-xs">
            {defs.get(r.key)?.label ?? r.key}: <span className="font-medium">{scopeText(r.scope === "own" || r.scope === "studio" ? r.scope : "off")}</span>
            {r.cappedBy ? <span className="text-neutral-500"> ({CAP_TEXT(r.cappedBy)})</span> : null}
            {r.source === "inactive_until_activated" ? <span data-testid="access-pending" className="text-neutral-500"> (a saved choice is waiting for activation)</span> : null}
          </li>
        ))}
      </ul>
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
      {diff.fixedNarrowings.some((f) => f.kind === "narrows") && (
        <div data-testid="preview-fixed-narrowings" className="rounded-md bg-amber-50 p-2 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-200">
          <p className="font-medium">Practitioners lose today&apos;s access:</p>
          <ul className="mt-1 list-disc pl-5">
            {diff.fixedNarrowings.filter((f) => f.kind === "narrows").map((f) => (
              <li key={f.id} data-fixed-narrowing={f.id} className="break-words">{f.label}</li>
            ))}
          </ul>
        </div>
      )}
      {diff.fixedNarrowings.some((f) => f.kind === "safeguard") && (
        <div data-testid="preview-safeguards" className="rounded-md bg-neutral-50 p-2 text-sm text-neutral-800 dark:bg-neutral-900 dark:text-neutral-200">
          <p className="font-medium">Safeguards that apply from the release:</p>
          <ul className="mt-1 list-disc pl-5">
            {diff.fixedNarrowings.filter((f) => f.kind === "safeguard").map((f) => (
              <li key={f.id} data-safeguard={f.id} className="break-words">{f.label}</li>
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

const ACTIVATION_DRAFT_LINE = "You have unsaved changes. Save or discard them first; activating replaces this page with the saved state.";

function ActivationSection({
  pending,
  writable,
  blockedByDraft,
  previewActivation,
  activate,
  onActivated,
  onDiscard,
}: {
  pending: PendingActivation[];
  writable: boolean;
  blockedByDraft: boolean;
  previewActivation: RolesEditorProps["previewActivation"];
  activate: RolesEditorProps["activate"];
  onActivated: () => void;
  onDiscard: (role: Role, key: string, basis: Scope) => void;
}): ReactNode {
  const id = useId();
  const [review, setReview] = useState<ActivationPreview | null>(null);
  const [reason, setReason] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  // A late preview from an earlier click is ignored, so the owner never confirms a list that is not the one being committed.
  const seq = useRef(0);
  if (pending.length === 0) return null;

  async function open() {
    if (blockedByDraft) {
      setMessage(ACTIVATION_DRAFT_LINE);
      return;
    }
    const mine = ++seq.current;
    setBusy(true);
    setMessage(null);
    const r = await previewActivation(pending.map((p) => p.key));
    if (mine !== seq.current) return;
    setBusy(false);
    if (r.ok) {
      setReview(r.preview);
      setReason("");
      setConfirmed(false);
    } else {
      setMessage(roleErrorMessage(r.error));
    }
  }

  function cancel() {
    seq.current += 1;
    setReview(null);
    setReason("");
    setConfirmed(false);
    setMessage(null);
    setBusy(false);
  }

  async function commit() {
    if (!review) return;
    setBusy(true);
    setMessage(null);
    // The keys, version and digest are the ones the owner was shown; the core refuses the commit if any of them has moved.
    const r = await activate(review.keys, review.version, reason.trim(), review.digest, confirmed);
    setBusy(false);
    if (r.ok) {
      cancel();
      onActivated();
    } else {
      setMessage(roleErrorMessage(r.error));
      if (r.error.code === "unexpected" || r.error.code === "stale_version" || r.error.code === "stale_preview") onActivated();
    }
  }

  const needsConfirm = review?.confirmationRequired === true;
  const canCommit = review !== null && !busy && writable && reasonAcceptable("adopt", false, reason) && (!needsConfirm || confirmed);
  return (
    <section data-testid="activation-pending" aria-label="Settings waiting for activation" className="flex min-w-0 flex-col gap-3 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
      <h3 className="font-medium">Pending activation</h3>
      <p>
        These settings have been released in the app, but they are not in force for your staff until you activate them. Today your
        staff keep the access they have now. Review what would change, then activate.
      </p>
      <ul className="flex flex-col gap-1">
        {pending.map((p) => (
          <li key={p.key} data-pending-key={p.key} className="break-words">
            {p.label}
            <span className="text-xs"> ({p.roles.map((r) => ROLE_LABELS[r].toLowerCase()).join(", ")})</span>
            {p.discard.map((d) => (
              <button
                key={d.role}
                type="button"
                data-testid="activation-discard"
                data-discard-role={d.role}
                onClick={() => onDiscard(d.role, p.key, d.basis)}
                disabled={!writable}
                className="ml-2 min-h-[44px] rounded-md border border-amber-400 px-2 py-1 text-xs font-medium hover:bg-amber-100 disabled:opacity-50 dark:border-amber-700 dark:hover:bg-amber-900"
              >
                Discard {ROLE_LABELS[d.role].toLowerCase()} choice
              </button>
            ))}
          </li>
        ))}
      </ul>
      {review === null ? (
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            data-testid="activation-review"
            onClick={open}
            disabled={busy || !writable}
            className="min-h-[44px] rounded-md border border-amber-400 px-3 py-2 text-sm font-medium hover:bg-amber-100 disabled:opacity-50 dark:border-amber-700 dark:hover:bg-amber-900"
          >
            Review activation
          </button>
        </div>
      ) : (
        <div data-testid="activation-review-panel" className="flex min-w-0 flex-col gap-3 rounded-md bg-white p-3 text-neutral-900 dark:bg-neutral-900 dark:text-neutral-100">
          {review.roles.every((r) => r.diff.changes.length === 0) ? (
            <p>Activating changes nobody&apos;s access today. It records that you reviewed these settings.</p>
          ) : (
            review.roles.map((item) => (
              <div key={item.role} data-activation-role={item.role} className="flex min-w-0 flex-col gap-2">
                <h4 className="font-medium">{ROLE_LABELS[item.role]}s</h4>
                <DiffList item={item} testPrefix="preview" />
              </div>
            ))
          )}
          <ReasonField id={`${id}-reason`} value={reason} onChange={setReason} required />
          {needsConfirm && (
            <label className="flex min-h-[44px] items-start gap-2 text-sm">
              <input type="checkbox" data-testid="activation-confirm" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} className="mt-1" />
              <span>I understand this switches on financial or sensitive access for the people listed.</span>
            </label>
          )}
          <div className="flex flex-wrap items-center gap-3">
            <button type="button" data-testid="activation-commit" onClick={commit} disabled={!canCommit} className="min-h-[44px] rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-white dark:text-neutral-900">
              Activate these settings
            </button>
            <button type="button" onClick={cancel} className="min-h-[44px] rounded-md border border-neutral-300 px-4 py-2 text-sm dark:border-neutral-700">
              Cancel
            </button>
          </div>
        </div>
      )}
      {message && (
        <p data-testid="activation-message" role="alert" className="break-words font-medium">
          {message}
        </p>
      )}
    </section>
  );
}

function PreviewPanel({
  kind,
  role,
  data,
  sensitiveCount,
  confirmed,
  onConfirmed,
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
  sensitiveCount: number;
  confirmed: boolean;
  onConfirmed: (v: boolean) => void;
  canConfirm: boolean;
  blockedReason: string | null;
  reason: string;
  onReason: (v: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const id = useId();
  const empty = data.roles.every((r) => r.diff.changes.length === 0 && r.diff.fixedNarrowings.length === 0 && r.storedRemoved.length === 0);
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
            {item.storedRemoved.length > 0 && (
              <div data-testid="preview-stored-removed" className="rounded-md bg-neutral-50 p-2 text-sm text-neutral-800 dark:bg-neutral-900 dark:text-neutral-200">
                <p className="font-medium">Removes your saved choices:</p>
                <ul className="mt-1 list-disc pl-5">
                  {item.storedRemoved.map((r) => (
                    <li key={r.key} data-stored-removed={r.key} className="break-words">
                      {/* Access in force did not move: the choice was held inactive, so say that rather than imply a change in access. */}
                      {r.effectiveBefore === r.effectiveAfter
                        ? `${r.label}: removes your saved ${r.stored}, not in force yet. Access stays ${r.effectiveAfter}.`
                        : `${r.label}: removes your saved ${r.stored}. Access in force: ${r.effectiveBefore} to ${r.effectiveAfter}.`}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        ))
      )}
      {sensitiveCount > 0 && (
        <label className="flex items-start gap-2 text-sm font-medium">
          <input type="checkbox" data-testid="preview-sensitive-confirm" checked={confirmed} onChange={(e) => onConfirmed(e.target.checked)} className="mt-1" />
          <span data-testid="preview-sensitive">
            I understand this newly enables {sensitiveCount} financial or sensitive {sensitiveCount === 1 ? "permission" : "permissions"}.
          </span>
        </label>
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
