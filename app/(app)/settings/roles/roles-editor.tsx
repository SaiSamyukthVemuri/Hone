"use client";

import { useId, useMemo, useState, type ReactNode } from "react";
import { ROLES, type Role, type Scope, type StudioPolicy } from "@/lib/permissions/catalog";
import { applyEdit, buildRoleModel, ROLE_LABELS } from "@/lib/settings/roles/model";
import { defaultsPolicy, diffPolicies, type RoleDiff } from "@/lib/settings/roles/diff";
import { SaveStatus, useSaveFeedback } from "@/components/settings/save-status";
import { useUnsavedChangesGuard } from "@/components/settings/unsaved-changes";
import type { RolesActionResult } from "./actions";

// The Roles page body (R2). One role at a time (one task per view), grouped permissions with Off / Own / Whole studio where the
// catalog offers scope, prerequisites and consequences stated, and NEVER a silent change to another key: a control the catalog
// refuses is disabled with the reason. Save shows "Saving…", success only after the server confirms, and keeps the typed
// choices on failure. Reset and Adopt show a before/after preview first; newly enabled financial or sensitive access is
// highlighted. When the studio cannot save yet (writable=false) the controls are a read-only review.

export type RolesEditorProps = {
  policies: Record<Role, StudioPolicy>;
  reviewed: boolean;
  writable: boolean;
  notWritableReason: string | null;
  staff: Record<Role, ReactNode>;
  version: string | null;
  save: (role: Role, values: Record<string, Scope>, expectedVersion: string | null) => Promise<RolesActionResult>;
  reset: (role: Role, expectedVersion: string | null) => Promise<RolesActionResult>;
};

type Preview = { kind: "reset" | "adopt"; diff: RoleDiff };

export function RolesEditor(props: RolesEditorProps) {
  const [role, setRole] = useState<Role>("practitioner");
  const [saved, setSaved] = useState<Record<Role, StudioPolicy>>(props.policies);
  const [drafts, setDrafts] = useState<Record<Role, StudioPolicy>>(props.policies);
  const [rowError, setRowError] = useState<{ key: string; message: string } | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [reviewed, setReviewed] = useState(props.reviewed);
  const feedback = useSaveFeedback();
  const baseId = useId();

  const draft = drafts[role];
  const dirty = JSON.stringify(draft.values) !== JSON.stringify(saved[role].values);
  useUnsavedChangesGuard(`roles-${role}`, dirty);
  const model = useMemo(() => buildRoleModel(role, draft), [role, draft]);
  const readOnly = !props.writable;

  function choose(key: string, scope: Scope) {
    const result = applyEdit(role, draft, key, scope);
    if (!result.ok) {
      setRowError({ key, message: result.reason });
      return;
    }
    setRowError(null);
    feedback.reset();
    setDrafts((d) => ({ ...d, [role]: result.policy }));
  }

  async function onSave() {
    feedback.saving();
    const result = await props.save(role, draft.values as Record<string, Scope>, props.version);
    if (result.ok) {
      setSaved((s) => ({ ...s, [role]: draft }));
      feedback.saved();
    } else {
      // The choices stay as typed; only the message changes.
      feedback.failed(result.error);
    }
  }

  function openPreview(kind: Preview["kind"]) {
    setPreview({ kind, diff: diffPolicies(role, draft, defaultsPolicy(draft)) });
  }

  async function confirmPreview() {
    if (!preview) return;
    feedback.saving();
    const result = await props.reset(role, props.version);
    if (result.ok) {
      const next = defaultsPolicy(draft);
      setSaved((s) => ({ ...s, [role]: next }));
      setDrafts((d) => ({ ...d, [role]: next }));
      setReviewed(true);
      setPreview(null);
      feedback.saved();
    } else {
      feedback.failed(result.error);
    }
  }

  return (
    <div className="flex flex-col gap-8" data-testid="roles-editor">
      {!reviewed && (
        <section
          data-testid="roles-review-banner"
          className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200"
        >
          <h3 className="font-medium">Your studio keeps its current access until you review it</h3>
          <p className="mt-1">
            Nothing changes for your staff until you adopt the new defaults or save your own settings. Review what would change
            for each role, then choose.
          </p>
          <button
            type="button"
            onClick={() => openPreview("adopt")}
            className="mt-3 min-h-[44px] rounded-md border border-amber-400 px-3 py-2 text-sm font-medium hover:bg-amber-100 dark:border-amber-700 dark:hover:bg-amber-900"
          >
            Review changes for {ROLE_LABELS[role].toLowerCase()}s
          </button>
        </section>
      )}

      {readOnly && props.notWritableReason && (
        <p data-testid="roles-read-only" className="rounded-md border border-neutral-200 bg-neutral-50 p-3 text-sm text-neutral-600 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-400">
          {props.notWritableReason}
        </p>
      )}

      <div role="tablist" aria-label="Roles" className="flex gap-2">
        {ROLES.map((r) => (
          <button
            key={r}
            type="button"
            role="tab"
            id={`${baseId}-tab-${r}`}
            aria-selected={role === r}
            aria-controls={`${baseId}-panel`}
            data-role-tab={r}
            data-state={role === r ? "selected" : "idle"}
            onClick={() => {
              setRole(r);
              setPreview(null);
              setRowError(null);
              feedback.reset();
            }}
            className={`min-h-[44px] rounded-md border px-4 py-2 text-sm font-medium ${
              role === r
                ? "border-neutral-900 bg-neutral-900 text-white dark:border-white dark:bg-white dark:text-neutral-900"
                : "border-neutral-300 text-neutral-700 hover:bg-neutral-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-900"
            }`}
          >
            {ROLE_LABELS[r]}
          </button>
        ))}
      </div>

      <div id={`${baseId}-panel`} role="tabpanel" aria-labelledby={`${baseId}-tab-${role}`} className="flex min-w-0 flex-col gap-8">
        {props.staff[role]}

        {preview && (
          <PreviewPanel
            kind={preview.kind}
            role={role}
            diff={preview.diff}
            canConfirm={props.writable}
            blockedReason={props.notWritableReason}
            onConfirm={confirmPreview}
            onCancel={() => setPreview(null)}
          />
        )}

        {model.map((g) => (
          <section key={g.group} aria-labelledby={`${baseId}-${g.group}`} data-permission-group={g.group} className="flex min-w-0 flex-col gap-3">
            <h3 id={`${baseId}-${g.group}`} className="text-base font-medium">
              {g.label}
            </h3>
            <ul className="divide-y divide-neutral-200 overflow-hidden rounded-lg border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
              {g.rows.map((row) => (
                <li
                  key={row.key}
                  data-permission-row={row.key}
                  data-chosen={row.chosen}
                  data-effective={row.effective}
                  className="flex min-w-0 flex-col gap-2 px-4 py-3"
                >
                  <fieldset disabled={readOnly || row.locked !== null} className="min-w-0">
                    <legend className="min-w-0 break-words text-sm font-medium">{row.label}</legend>
                    <p className="mt-0.5 break-words text-xs text-neutral-500">{row.description}</p>
                    {row.ownMeaning && <p className="mt-0.5 break-words text-xs text-neutral-500">Own assigned means: {row.ownMeaning}.</p>}
                    {row.futureBusiness && (
                      <p data-testid="affects-future-business" className="mt-0.5 text-xs font-medium text-neutral-700 dark:text-neutral-300">
                        Affects future studio business
                      </p>
                    )}
                    <div className="mt-2 flex flex-wrap gap-2">
                      {row.options.map((o) => (
                        <label
                          key={o.scope}
                          className={`inline-flex min-h-[44px] cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm ${
                            o.selected
                              ? "border-neutral-900 bg-neutral-100 font-medium dark:border-white dark:bg-neutral-800"
                              : "border-neutral-300 dark:border-neutral-700"
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
                  {row.snapshotBasis === "approved_policy" && (
                    <p data-testid="approved-policy-note" className="break-words text-xs text-amber-800 dark:text-amber-300">
                      Approved policy: not yet enforced everywhere. The setting shown is the approved one; the database may still allow more until the closing changes ship.
                    </p>
                  )}
                  {row.pendingDecision && <p className="text-xs text-neutral-500">This default is still being decided; it keeps today&rsquo;s behaviour.</p>}
                  {rowError?.key === row.key && (
                    <p role="alert" className="break-words text-xs text-red-700 dark:text-red-400">
                      {rowError.message}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          </section>
        ))}

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={onSave}
            disabled={!props.writable || !dirty || feedback.state.kind === "saving"}
            className="min-h-[44px] rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-white dark:text-neutral-900"
          >
            Save {ROLE_LABELS[role].toLowerCase()} settings
          </button>
          <button
            type="button"
            onClick={() => openPreview("reset")}
            className="min-h-[44px] rounded-md border border-neutral-300 px-4 py-2 text-sm hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
          >
            Reset to defaults
          </button>
          <SaveStatus state={feedback.state} />
        </div>
        <p className="text-xs text-neutral-500">Changes apply to each person&rsquo;s next request, including people who are signed in now.</p>
      </div>
    </div>
  );
}

function PreviewPanel({
  kind,
  role,
  diff,
  canConfirm,
  blockedReason,
  onConfirm,
  onCancel,
}: {
  kind: "reset" | "adopt";
  role: Role;
  diff: RoleDiff;
  canConfirm: boolean;
  blockedReason: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <section
      data-testid="roles-preview"
      aria-label={kind === "adopt" ? "Review new defaults" : "Reset to defaults"}
      className="flex min-w-0 flex-col gap-3 rounded-lg border border-neutral-300 p-4 dark:border-neutral-700"
    >
      <h3 className="text-base font-medium">
        {kind === "adopt" ? "Adopt the new defaults" : "Reset to defaults"} for {ROLE_LABELS[role].toLowerCase()}s
      </h3>
      {diff.changes.length === 0 && diff.fixedNarrowings.length === 0 ? (
        <p className="text-sm text-neutral-600 dark:text-neutral-400">Nothing would change. These settings already match the defaults.</p>
      ) : (
        <>
          <p className="text-sm text-neutral-600 dark:text-neutral-400">
            {diff.widened} would gain access and {diff.narrowed} would lose access.
          </p>
          {diff.newlyEnabledSensitive > 0 && (
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
              <li
                key={c.key}
                data-preview-change={c.key}
                data-direction={c.direction}
                data-sensitive={c.newlyEnabledSensitive ? "true" : "false"}
                className={`break-words rounded-md px-2 py-1 text-sm ${c.newlyEnabledSensitive ? "bg-red-50 font-medium dark:bg-red-950" : ""}`}
              >
                <span className="text-neutral-500">{c.groupLabel}: </span>
                {c.label}: {c.from === "off" ? "Off" : c.from === "own" ? "Own assigned" : "Whole studio"} to{" "}
                {c.to === "off" ? "Off" : c.to === "own" ? "Own assigned" : "Whole studio"}
                {c.futureBusiness ? " (affects future studio business)" : ""}
              </li>
            ))}
          </ul>
        </>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={onConfirm}
          disabled={!canConfirm}
          className="min-h-[44px] rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-white dark:text-neutral-900"
        >
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
