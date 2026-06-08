"use client";

import { useState, useTransition } from "react";
import type {
  ConsentFormTemplate,
  ConsentTemplateFormType,
  ConsentTemplateStatus,
} from "@/lib/types/database";
import { FormattedDateTime } from "@/components/formatted-date-time";

const TITLE_MAX = 160;
const BODY_MAX = 20000;

type CreateResult =
  | { ok: true; templateId: string }
  | { ok: false; error: string };
type StatusResult = { ok: true } | { ok: false; error: string };

type ActionCreate = (formData: FormData) => Promise<CreateResult>;
type ActionStatus = (formData: FormData) => Promise<StatusResult>;

const FORM_TYPE_LABELS: Record<ConsentTemplateFormType, string> = {
  general: "General",
  treatment_consent: "Treatment consent",
  policy_acknowledgement: "Policy acknowledgement",
  card_authorization: "Card on file (deferred)",
  photo_consent: "Photo consent",
};

const STATUS_LABELS: Record<ConsentTemplateStatus, string> = {
  draft: "Draft",
  active: "Active",
  archived: "Archived",
};

// PR #134, PR #167. Practitioner-side consent template management.
// List + create + edit + archive + live-in-portal toggle. No
// drag-and-drop builder, no custom-question builder. Editing bumps
// the version server-side so old signed records keep their
// historical hash. Archive flips status='archived'; there is no
// hard delete (the table has ON DELETE RESTRICT against
// client_consent_signatures to keep the audit chain intact).
//
// PR #167 added the explicit Live in client portal control. The
// rule: a template's life cycle is
//
//   Draft (new) -> Active (ready for use) -> Live (clients see it)
//
// Each transition is a deliberate practitioner click. A new
// template lands as Draft and is_live=false; the practitioner
// must click "Make active" then "Make live in client portal" to
// expose it. Moving back to Draft or Archive automatically pulls
// it off the portal (server-side; the DB CHECK constraint is the
// structural backstop). This is the safety property Chloe asked
// for: "I don't want test forms going out into clients' portal
// and having them sign random stuff I'm doing."
export function ConsentTemplatesEditor({
  templates,
  createAction,
  updateAction,
  setStatusAction,
  setLiveAction,
}: {
  templates: ConsentFormTemplate[];
  createAction: ActionCreate;
  updateAction: ActionCreate;
  setStatusAction: ActionStatus;
  setLiveAction: ActionStatus;
}) {
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function handleStatus(id: string, status: ConsentTemplateStatus) {
    setError(null);
    const fd = new FormData();
    fd.set("id", id);
    fd.set("status", status);
    startTransition(async () => {
      const r = await setStatusAction(fd);
      if (!r.ok) setError(r.error);
    });
  }

  function handleLive(id: string, nextIsLive: boolean) {
    setError(null);
    const fd = new FormData();
    fd.set("id", id);
    fd.set("is_live", nextIsLive ? "true" : "false");
    startTransition(async () => {
      const r = await setLiveAction(fd);
      if (!r.ok) setError(r.error);
    });
  }

  // PR #167 groups templates by client-portal visibility first:
  // Live (is_live=true) comes before Active not-live, before
  // Draft, before Archived. The owner's first glance is "what
  // are my real clients seeing?"
  const live = templates.filter((t) => t.is_live);
  const activeNotLive = templates.filter(
    (t) => !t.is_live && t.status === "active",
  );
  const draft = templates.filter((t) => t.status === "draft");
  const archived = templates.filter((t) => t.status === "archived");

  return (
    <div className="flex flex-col gap-4">
      {error && (
        <p className="text-xs text-red-700 dark:text-red-400" role="alert">
          {error}
        </p>
      )}

      {templates.length === 0 && !adding && (
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          No consent forms yet. Create one to start collecting signatures in
          the secure client portal.
        </p>
      )}

      {!adding && editingId == null && (
        <button
          type="button"
          onClick={() => {
            setAdding(true);
            setError(null);
          }}
          className="self-start rounded-md border border-dashed border-neutral-300 px-3 py-2 text-sm font-medium text-neutral-700 hover:border-neutral-500 hover:bg-neutral-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-900"
        >
          + New consent form
        </button>
      )}

      {adding && (
        <TemplateForm
          mode="create"
          initial={null}
          onCancel={() => setAdding(false)}
          onSubmit={async (fd) => {
            const r = await createAction(fd);
            if (!r.ok) {
              setError(r.error);
              return false;
            }
            setAdding(false);
            return true;
          }}
        />
      )}

      {[
        { label: "Live in client portal", rows: live },
        { label: "Active (not live)", rows: activeNotLive },
        { label: "Drafts", rows: draft },
        { label: "Archived", rows: archived },
      ]
        .filter((g) => g.rows.length > 0)
        .map((group) => (
          <section
            key={group.label}
            className="flex flex-col gap-2 border-t border-neutral-200 pt-3 dark:border-neutral-800"
          >
            <h3 className="text-[11px] font-medium uppercase tracking-wider text-neutral-500">
              {group.label}
            </h3>
            <ul className="flex flex-col gap-3">
              {group.rows.map((t) =>
                editingId === t.id ? (
                  <li key={t.id}>
                    <TemplateForm
                      mode="edit"
                      initial={t}
                      onCancel={() => setEditingId(null)}
                      onSubmit={async (fd) => {
                        fd.set("id", t.id);
                        const r = await updateAction(fd);
                        if (!r.ok) {
                          setError(r.error);
                          return false;
                        }
                        setEditingId(null);
                        return true;
                      }}
                    />
                  </li>
                ) : (
                  <li
                    key={t.id}
                    className="rounded-md border border-neutral-200 bg-white p-3 dark:border-neutral-800 dark:bg-neutral-950"
                  >
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <div className="flex flex-col gap-0.5">
                        <p className="text-sm font-medium text-neutral-900 dark:text-neutral-100">
                          {t.title}
                          <span className="ml-2 text-[11px] text-neutral-500">
                            v{t.version}
                          </span>
                        </p>
                        <p className="text-[11px] uppercase tracking-wider text-neutral-500">
                          {FORM_TYPE_LABELS[t.form_type]}
                          {" · "}
                          {STATUS_LABELS[t.status]}
                          {" · "}
                          <LiveBadge isLive={t.is_live} />
                        </p>
                        {t.description && (
                          <p className="text-xs text-neutral-600 dark:text-neutral-400">
                            {t.description}
                          </p>
                        )}
                        <p className="text-[11px] text-neutral-500">
                          Updated <FormattedDateTime iso={t.updated_at} />
                        </p>
                      </div>
                      <div className="flex flex-wrap items-center gap-2 text-[11px]">
                        <button
                          type="button"
                          onClick={() => {
                            setEditingId(t.id);
                            setError(null);
                          }}
                          disabled={pending}
                          className="rounded-md border border-neutral-300 px-2.5 py-1 font-medium text-neutral-700 hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-900"
                        >
                          Edit
                        </button>
                        {t.status === "active" && !t.is_live && (
                          <button
                            type="button"
                            onClick={() => handleLive(t.id, true)}
                            disabled={pending}
                            className="rounded-md border border-neutral-900 bg-neutral-900 px-2.5 py-1 font-medium text-white hover:bg-neutral-800 disabled:opacity-50 dark:border-white dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-100"
                          >
                            Make live in client portal
                          </button>
                        )}
                        {t.is_live && (
                          <button
                            type="button"
                            onClick={() => handleLive(t.id, false)}
                            disabled={pending}
                            className="rounded-md border border-neutral-300 px-2.5 py-1 font-medium text-neutral-700 hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-900"
                          >
                            Hide from client portal
                          </button>
                        )}
                        {t.status !== "active" && (
                          <button
                            type="button"
                            onClick={() => handleStatus(t.id, "active")}
                            disabled={pending}
                            className="rounded-md border border-neutral-300 px-2.5 py-1 font-medium text-neutral-700 hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-900"
                          >
                            Make active
                          </button>
                        )}
                        {t.status !== "archived" && (
                          <button
                            type="button"
                            onClick={() => handleStatus(t.id, "archived")}
                            disabled={pending}
                            className="rounded-md border border-neutral-300 px-2.5 py-1 font-medium text-neutral-500 hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-400 dark:hover:bg-neutral-900"
                          >
                            Archive
                          </button>
                        )}
                      </div>
                    </div>
                  </li>
                ),
              )}
            </ul>
          </section>
        ))}
    </div>
  );
}

// Small badge that names the consequence in client terms. PR #167.
// "Live" -> clients see it in the portal. "Draft" -> clients do not
// see it. The badge sits next to the form-type label so a glance
// at any row makes the visibility unambiguous.
function LiveBadge({ isLive }: { isLive: boolean }) {
  if (isLive) {
    return (
      <span
        className="inline-flex items-center rounded-full bg-green-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-green-900 dark:bg-green-900 dark:text-green-100"
        aria-label="Live in client portal"
      >
        Live
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-center rounded-full bg-neutral-200 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300"
      aria-label="Draft, not shown to clients"
    >
      Draft
    </span>
  );
}

function TemplateForm({
  mode,
  initial,
  onCancel,
  onSubmit,
}: {
  mode: "create" | "edit";
  initial: ConsentFormTemplate | null;
  onCancel: () => void;
  onSubmit: (formData: FormData) => Promise<boolean>;
}) {
  const [title, setTitle] = useState(initial?.title ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [body, setBody] = useState(initial?.body ?? "");
  const [formType, setFormType] = useState<ConsentTemplateFormType>(
    initial?.form_type ?? "treatment_consent",
  );
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function submit() {
    const t = title.trim();
    const b = body.trim();
    if (!t) {
      setError("Title is required.");
      return;
    }
    if (t.length > TITLE_MAX) {
      setError(`Title must be ${TITLE_MAX} characters or fewer.`);
      return;
    }
    if (!b) {
      setError("Body is required.");
      return;
    }
    if (b.length > BODY_MAX) {
      setError(`Body must be ${BODY_MAX} characters or fewer.`);
      return;
    }
    setError(null);
    const fd = new FormData();
    fd.set("title", t);
    fd.set("description", description.trim());
    fd.set("body", b);
    fd.set("form_type", formType);
    // PR #167. Create no longer accepts a status field; the
    // server forces status='draft' + is_live=false on insert so
    // a new template cannot land in the client portal by accident.
    startTransition(async () => {
      const ok = await onSubmit(fd);
      if (!ok) return;
    });
  }

  return (
    <div className="flex flex-col gap-3 rounded-md border border-neutral-200 bg-neutral-50 p-3 dark:border-neutral-700 dark:bg-neutral-900">
      <p className="text-sm font-medium">
        {mode === "create" ? "New consent form" : "Edit consent form"}
        {mode === "edit" && initial && (
          <span className="ml-2 text-[11px] text-neutral-500">
            currently v{initial.version} (saving bumps to v{initial.version + 1})
          </span>
        )}
      </p>
      {mode === "create" && (
        <p className="text-[11px] text-neutral-600 dark:text-neutral-400">
          New forms are saved as Draft. They are not shown to clients until
          you mark them Active and then Live in client portal.
        </p>
      )}

      <label className="flex flex-col gap-1">
        <span className="text-[11px] uppercase tracking-wider text-neutral-500">
          Title
        </span>
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          maxLength={TITLE_MAX}
          placeholder="e.g. Treatment consent"
          className="rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950"
        />
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-[11px] uppercase tracking-wider text-neutral-500">
          Form type
        </span>
        <select
          value={formType}
          onChange={(e) =>
            setFormType(e.target.value as ConsentTemplateFormType)
          }
          className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950"
        >
          {(
            [
              "treatment_consent",
              "policy_acknowledgement",
              "photo_consent",
              "general",
              "card_authorization",
            ] as ConsentTemplateFormType[]
          ).map((t) => (
            <option key={t} value={t}>
              {FORM_TYPE_LABELS[t]}
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-[11px] uppercase tracking-wider text-neutral-500">
          Description (optional)
        </span>
        <input
          type="text"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Shown under the title in the portal"
          className="rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950"
        />
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-[11px] uppercase tracking-wider text-neutral-500">
          Body
        </span>
        <textarea
          rows={10}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          maxLength={BODY_MAX}
          placeholder="Paste the full consent text. This is what clients will see and sign."
          className="rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950"
        />
        <span className="text-[11px] text-neutral-500 tabular-nums">
          {body.length} / {BODY_MAX}
        </span>
      </label>

      {error && (
        <p className="text-xs text-red-700 dark:text-red-400" role="alert">
          {error}
        </p>
      )}

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={submit}
          disabled={pending}
          className="rounded-md bg-neutral-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-neutral-800 disabled:opacity-50 dark:bg-white dark:text-neutral-900"
        >
          {pending
            ? "Saving..."
            : mode === "create"
              ? "Create form"
              : "Save changes"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={pending}
          className="rounded-md border border-neutral-300 px-3 py-1.5 text-xs text-neutral-700 hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-900"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
