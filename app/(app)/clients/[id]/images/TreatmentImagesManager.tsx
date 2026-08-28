"use client";

import {
  useEffect,
  useState,
  useTransition,
  type ChangeEvent,
  type FormEvent,
} from "react";
import { useRouter } from "next/navigation";
import { FormattedDateTime } from "@/components/formatted-date-time";
import {
  uploadTreatmentImageAction,
  getTreatmentImageSignedUrlAction,
  archiveTreatmentImageAction,
  updateTreatmentImageNoteAction,
} from "./actions";
import { TREATMENT_NOTE_MAX_LENGTH } from "./note-constants";
import {
  validateTreatmentImageUpload,
  selectGridImageSource,
} from "@/lib/images/treatment-images";

// Per-file upload status (PR: multi-file upload). Each selected file is
// processed independently so one failure never blocks the others.
type UploadFileStatus = "pending" | "uploading" | "uploaded" | "failed";
type UploadFileResult = {
  name: string;
  status: UploadFileStatus;
  error?: string;
};

// PR #271 / #272 / #273. Practitioner-only "Treatment Photos" UI.
// PR #273 adds INLINE gallery previews: the server pre-signs a short-TTL
// preview URL per image (page.tsx, after the studio-scoped RLS load); each card
// renders it as an <img>, and clicking opens an in-app modal that lazily mints a
// fresh signed URL via the existing server action (no new browser tab as the
// primary path). Security model unchanged: private bucket, signed-URL-only,
// short TTL, never public, never stored in the DB. Soft-delete only (archive).

type Row = {
  id: string;
  // Session date of the attached session (null for client-scope photos). Shown
  // as the human card title instead of the raw .jpg filename (Chloe feedback).
  sessionDate: string | null;
  createdAt: string;
  // Short-lived server-signed preview URL (null if signing failed). This is the
  // ORIGINAL, and it stays the authority: the modal uses it, and the grid falls
  // back to it whenever the derivative is missing or fails to load.
  previewUrl: string | null;
  // PERF-IMG-03. Short-lived signed URL for the bounded grid derivative, or null
  // when there is none (every row uploaded before that change). Never a
  // substitute for previewUrl — only a smaller stand-in for the grid cell.
  thumbUrl: string | null;
  // PR #274: display-only context tags, computed server-side from existing
  // metadata + session-block area fields (never raw IDs/paths).
  scopeLabel: string;
  areaLabel: string | null;
  // PR #307: practitioner note/caption (null = none). Edited inline via
  // updateTreatmentImageNoteAction; never affects storage/security.
  note: string | null;
};

// PR #284: recent sessions (+ their blocks' area labels) for the attach-at-
// upload context selector. The option VALUE carries the id (submitted +
// re-validated server-side); only the area label text is shown.
export type SessionAttachOption = {
  id: string;
  startedAt: string;
  blocks: { id: string; areaLabel: string }[];
};

type PhotoContextKind = "client" | "session" | "block";

// Treatment-context tags shown on each card and in the larger preview. Labels
// only, no UUIDs, storage paths, bucket names, or signed-URL text.
function ContextTags({
  scopeLabel,
  areaLabel,
}: {
  scopeLabel: string;
  areaLabel: string | null;
}) {
  const badge =
    "rounded-full bg-neutral-100 px-2 py-0.5 text-[11px] font-medium text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300";
  return (
    <div className="flex flex-wrap gap-1">
      <span className={badge}>{scopeLabel}</span>
      {areaLabel && <span className={badge}>{areaLabel}</span>}
      <span className="rounded-full px-2 py-0.5 text-[11px] font-medium text-neutral-400">
        Clinical reference
      </span>
    </div>
  );
}

// PR #307: per-photo practitioner note/caption. Inline: shows the note (when
// present) + an "Edit note" / "Add note" control; opens a small textarea with
// Save / Cancel that calls updateTreatmentImageNoteAction (RLS-scoped, capped).
// Display-only over the photo, never touches upload/storage/security.
function PhotoNoteEditor({
  imageId,
  clientId,
  note,
}: {
  imageId: string;
  clientId: string;
  note: string | null;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(note ?? "");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function startEdit() {
    setValue(note ?? "");
    setError(null);
    setEditing(true);
  }
  function cancel() {
    setValue(note ?? "");
    setError(null);
    setEditing(false);
  }
  function save() {
    setError(null);
    startTransition(async () => {
      const res = await updateTreatmentImageNoteAction({
        imageId,
        clientId,
        note: value,
      });
      if (!res.ok) {
        // Generic message, never surface a raw provider/DB detail.
        setError(res.error);
        return;
      }
      setEditing(false);
      router.refresh();
    });
  }

  if (!editing) {
    return (
      <div className="mt-2">
        {note ? (
          <p className="whitespace-pre-wrap break-words text-xs text-neutral-700 dark:text-neutral-300">
            {note}
          </p>
        ) : null}
        <button
          type="button"
          onClick={startEdit}
          className="mt-1 text-xs font-medium text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100"
        >
          {note ? "Edit note" : "Add note"}
        </button>
      </div>
    );
  }

  return (
    <div className="mt-2">
      <textarea
        value={value}
        onChange={(e) => setValue(e.target.value)}
        maxLength={TREATMENT_NOTE_MAX_LENGTH}
        rows={2}
        placeholder="Add a note for this photo…"
        className="w-full rounded-md border border-neutral-300 bg-white px-2 py-1 text-xs text-neutral-800 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100"
      />
      <div className="mt-1 flex items-center gap-2">
        <button
          type="button"
          onClick={save}
          disabled={pending}
          className="rounded-md bg-neutral-900 px-3 py-1 text-xs font-medium text-white hover:bg-neutral-800 disabled:opacity-50 dark:bg-white dark:text-neutral-900"
        >
          {pending ? "Saving…" : "Save"}
        </button>
        <button
          type="button"
          onClick={cancel}
          disabled={pending}
          className="rounded-md border border-neutral-300 px-3 py-1 text-xs text-neutral-700 hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-200"
        >
          Cancel
        </button>
      </div>
      {error && (
        <p className="mt-1 text-xs text-red-700" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

export function TreatmentImagesManager({
  clientId,
  images,
  sessionOptions = [],
}: {
  clientId: string;
  images: Row[];
  sessionOptions?: SessionAttachOption[];
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  // Multi-file upload: the files chosen for the next batch + per-file results.
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [uploading, setUploading] = useState(false);
  const [fileResults, setFileResults] = useState<UploadFileResult[]>([]);
  const [broken, setBroken] = useState<Record<string, boolean>>({});
  // PERF-IMG-03. Tracks derivatives that failed to LOAD (as opposed to failing
  // to sign, which the server already handles by sending thumbUrl=null). A
  // failure here demotes that one cell to the original; it never hides it.
  const [thumbFailed, setThumbFailed] = useState<Record<string, boolean>>({});

  // PR #284: attach-at-upload context. Default "client" (no session/block).
  const hasSessions = sessionOptions.length > 0;
  const [contextKind, setContextKind] = useState<PhotoContextKind>("client");
  const [ctxSessionId, setCtxSessionId] = useState<string>("");
  const [ctxBlockId, setCtxBlockId] = useState<string>("");
  const ctxSession = sessionOptions.find((s) => s.id === ctxSessionId) ?? null;
  const ctxBlocks = ctxSession?.blocks ?? [];
  const sessionDateLabel = (iso: string): string => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? "session" : d.toLocaleDateString();
  };

  // In-app larger preview modal.
  const [modal, setModal] = useState<Row | null>(null);
  const [modalUrl, setModalUrl] = useState<string | null>(null);
  const [modalLoading, setModalLoading] = useState(false);
  const [modalError, setModalError] = useState(false);

  useEffect(() => {
    if (!modal) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setModal(null);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [modal]);

  function onPick(e: ChangeEvent<HTMLInputElement>) {
    setError(null);
    setFileResults([]);
    setSelectedFiles(Array.from(e.target.files ?? []));
  }

  // Multi-file upload. Each selected file is uploaded on its OWN call to the
  // (unchanged) server action, so every file is independently validated,
  // EXIF-stripped, and studio/client/context scoped. One file failing never
  // blocks the others, and nothing is silently dropped: every file shows a
  // per-file status. All files in a batch share the ONE context (client /
  // session / treatment area) the practitioner selected above.
  async function onUpload(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const files = selectedFiles;
    if (files.length === 0) {
      setError("Choose one or more images first.");
      return;
    }

    // Resolve + validate the shared context ONCE (same scope for the batch).
    const context: Record<string, string> = { clientId };
    if (contextKind === "session") {
      if (!ctxSessionId) {
        setError("Choose a session, or switch to Client photo.");
        return;
      }
      context.sessionId = ctxSessionId;
    } else if (contextKind === "block") {
      if (!ctxSessionId || !ctxBlockId) {
        setError("Choose a treatment area, or switch to Client photo.");
        return;
      }
      context.sessionId = ctxSessionId;
      context.sessionBlockId = ctxBlockId;
    }

    const results: UploadFileResult[] = files.map((f) => ({
      name: f.name,
      status: "pending",
    }));
    setFileResults([...results]);
    setUploading(true);
    const update = (i: number, status: UploadFileStatus, err?: string) => {
      results[i] = { ...results[i], status, error: err };
      setFileResults([...results]);
    };

    let anyOk = false;
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      // Per-file client-side validation: the same rules the server enforces
      // (defense-in-depth: the server re-validates every file). An invalid file
      // fails on its own and never blocks the valid ones.
      const v = validateTreatmentImageUpload({
        contentType: file.type,
        sizeBytes: file.size,
      });
      if (!v.ok) {
        update(i, "failed", v.error);
        continue;
      }
      update(i, "uploading");
      try {
        const fd = new FormData();
        for (const [k, val] of Object.entries(context)) fd.set(k, val);
        fd.set("file", file);
        const res = await uploadTreatmentImageAction(fd);
        if (res.ok) {
          update(i, "uploaded");
          anyOk = true;
        } else {
          update(i, "failed", res.error);
        }
      } catch {
        update(i, "failed", "Upload failed. Please try again.");
      }
    }
    setUploading(false);
    // Clear the pending selection so a stray re-submit can't re-upload a file
    // that already succeeded; the per-file results stay visible below. Reset
    // the context only when the whole batch succeeded.
    setSelectedFiles([]);
    if (results.every((r) => r.status === "uploaded")) {
      setContextKind("client");
      setCtxSessionId("");
      setCtxBlockId("");
    }
    if (anyOk) router.refresh();
  }

  // Open the larger in-app preview. Lazily mints a FRESH signed URL via the
  // existing server action (which re-checks practitioner/studio ownership), so
  // the larger view works even if the grid's pre-signed URL has expired.
  async function openPreview(img: Row) {
    setModal(img);
    setModalUrl(null);
    setModalError(false);
    setModalLoading(true);
    const res = await getTreatmentImageSignedUrlAction({ imageId: img.id });
    setModalLoading(false);
    if (!res.ok) {
      setModalError(true);
      return;
    }
    setModalUrl(res.url);
  }

  async function onArchive(id: string) {
    setError(null);
    setBusyId(id);
    const res = await archiveTreatmentImageAction({ imageId: id, clientId });
    setBusyId(null);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-6">
      {/* Upload card: styled "Choose image" affordance over the native input. */}
      <section className="rounded-lg border border-neutral-200 p-5 dark:border-neutral-800">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-neutral-700 dark:text-neutral-300">
          Treatment Photos
        </h2>
        <p className="mt-1 text-xs text-neutral-500">
          Stored privately. Visible to practitioners in this studio. JPEG, PNG,
          or WebP, up to 15 MB.
        </p>
        <form onSubmit={onUpload} className="mt-3 flex flex-col gap-3">
          {/* PR #284: Photo context selector. Mobile-friendly: stacked, full-
              width controls. Only shown when this client has sessions; otherwise
              every photo attaches to the client. */}
          {hasSessions ? (
            <fieldset className="flex flex-col gap-2 rounded-md border border-neutral-200 p-3 dark:border-neutral-800">
              <legend className="px-1 text-xs font-medium text-neutral-500">
                Photo context
              </legend>
              <div className="flex flex-col gap-1.5 sm:flex-row sm:flex-wrap sm:gap-4">
                {(
                  [
                    ["client", "Client photo"],
                    ["session", "Session photo"],
                    ["block", "Treatment area photo"],
                  ] as const
                ).map(([value, label]) => (
                  <label
                    key={value}
                    className="flex items-center gap-2 text-sm text-neutral-700 dark:text-neutral-200"
                  >
                    <input
                      type="radio"
                      name="contextKind"
                      value={value}
                      checked={contextKind === value}
                      onChange={() => {
                        setContextKind(value);
                        setError(null);
                      }}
                    />
                    {label}
                  </label>
                ))}
              </div>

              {(contextKind === "session" || contextKind === "block") && (
                <label className="flex flex-col gap-1 text-xs text-neutral-500">
                  Session
                  <select
                    value={ctxSessionId}
                    onChange={(e) => {
                      setCtxSessionId(e.target.value);
                      setCtxBlockId("");
                    }}
                    className="w-full rounded-md border border-neutral-300 px-2 py-2 text-sm text-neutral-900 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
                  >
                    <option value="">Select a session…</option>
                    {sessionOptions.map((s) => (
                      <option key={s.id} value={s.id}>
                        Session on {sessionDateLabel(s.startedAt)}
                      </option>
                    ))}
                  </select>
                </label>
              )}

              {contextKind === "block" &&
                ctxSessionId &&
                (ctxBlocks.length > 0 ? (
                  <label className="flex flex-col gap-1 text-xs text-neutral-500">
                    Treatment area
                    <select
                      value={ctxBlockId}
                      onChange={(e) => setCtxBlockId(e.target.value)}
                      className="w-full rounded-md border border-neutral-300 px-2 py-2 text-sm text-neutral-900 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
                    >
                      <option value="">Select a treatment area…</option>
                      {ctxBlocks.map((b) => (
                        <option key={b.id} value={b.id}>
                          {b.areaLabel}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : (
                  <p className="text-xs text-neutral-500">
                    No treatment areas recorded for this session.
                  </p>
                ))}

              <p className="text-xs text-neutral-400">
                {contextKind === "client"
                  ? "Will attach as: Client photo."
                  : contextKind === "session"
                    ? ctxSession
                      ? `Will attach as: Session photo: Session on ${sessionDateLabel(ctxSession.startedAt)}.`
                      : "Will attach as: Session photo: choose a session."
                    : ctxBlockId && ctxSession
                      ? `Will attach as: Treatment area photo, ${ctxBlocks.find((b) => b.id === ctxBlockId)?.areaLabel ?? ""}, Session on ${sessionDateLabel(ctxSession.startedAt)}.`
                      : "Will attach as: Treatment area photo: choose a session and area."}
              </p>
            </fieldset>
          ) : (
            <p className="text-xs text-neutral-500">
              No sessions yet for this client: photos attach to the client.
            </p>
          )}

          <div className="flex flex-wrap items-center gap-3">
          <label className="cursor-pointer rounded-md border border-neutral-300 px-4 py-2 text-sm font-medium text-neutral-800 hover:bg-neutral-50 dark:border-neutral-700 dark:text-neutral-100 dark:hover:bg-neutral-900">
            Choose images
            <input
              type="file"
              name="file"
              multiple
              accept="image/jpeg,image/png,image/webp"
              onChange={onPick}
              className="sr-only"
            />
          </label>
          <span className="text-sm text-neutral-600 dark:text-neutral-300">
            {selectedFiles.length > 0 ? (
              <span className="font-medium">
                {selectedFiles.length} image
                {selectedFiles.length === 1 ? "" : "s"} selected
              </span>
            ) : (
              "No images chosen yet."
            )}
          </span>
          <button
            type="submit"
            disabled={uploading || selectedFiles.length === 0}
            className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
          >
            {uploading
              ? "Uploading…"
              : selectedFiles.length > 1
                ? `Attach ${selectedFiles.length} images`
                : "Attach image"}
          </button>
          </div>
          {fileResults.length > 0 && (
            <ul className="mt-3 flex flex-col gap-1">
              {fileResults.map((f, i) => (
                <li
                  key={`${f.name}-${i}`}
                  className="flex items-center justify-between gap-3 text-xs"
                >
                  <span className="truncate text-neutral-600 dark:text-neutral-300">
                    {f.name}
                  </span>
                  <span
                    className={
                      f.status === "uploaded"
                        ? "shrink-0 text-green-600 dark:text-green-400"
                        : f.status === "failed"
                          ? "shrink-0 text-red-600 dark:text-red-400"
                          : "shrink-0 text-neutral-500"
                    }
                  >
                    {f.status === "pending" && "Waiting"}
                    {f.status === "uploading" && "Uploading…"}
                    {f.status === "uploaded" && "✓ Uploaded"}
                    {f.status === "failed" && `✗ ${f.error ?? "Failed"}`}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </form>
        {error && (
          <p className="mt-2 text-sm text-red-600 dark:text-red-400">{error}</p>
        )}
      </section>

      {/* Gallery: inline previews. Clicking opens the in-app modal (no new tab
          as the primary path). Thumbnail pipeline and dual-photo review are
          deferred. */}
      {images.length === 0 ? (
        <div className="rounded-lg border border-dashed border-neutral-300 p-8 text-center dark:border-neutral-700">
          <p className="text-sm font-medium">No treatment photos yet</p>
          <p className="mt-1 text-sm text-neutral-500">
            Attach a photo to keep visual treatment references with this client.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {images.map((img) => {
            // Availability is decided by the ORIGINAL alone, exactly as before
            // this change: a derivative can never be the reason a clinical
            // image is withheld. The rule itself lives in a pure helper so all
            // four states are unit-tested rather than argued about here.
            const {
              src: gridSrc,
              showPreview,
              usingThumb: useThumb,
            } = selectGridImageSource({
              previewUrl: img.previewUrl,
              thumbUrl: img.thumbUrl,
              thumbFailed: !!thumbFailed[img.id],
              broken: !!broken[img.id],
            });
            return (
              <div
                key={img.id}
                className="flex flex-col gap-2 rounded-lg border border-neutral-200 p-3 dark:border-neutral-800"
              >
                {showPreview ? (
                  <button
                    type="button"
                    onClick={() => openPreview(img)}
                    className="block overflow-hidden rounded-md"
                    aria-label="View larger treatment photo"
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={gridSrc ?? ""}
                      alt="Treatment photo"
                      loading="lazy"
                      onError={() => {
                        // A derivative that will not load demotes to the
                        // original and re-renders; only the ORIGINAL failing
                        // marks the cell broken. Without this branch a missing
                        // thumbnail would read as a missing clinical image.
                        if (useThumb) {
                          setThumbFailed((t) => ({ ...t, [img.id]: true }));
                        } else {
                          setBroken((b) => ({ ...b, [img.id]: true }));
                        }
                      }}
                      className="aspect-square w-full object-cover transition hover:opacity-90"
                    />
                  </button>
                ) : (
                  <div className="grid aspect-square w-full place-items-center rounded-md bg-neutral-100 text-xs text-neutral-400 dark:bg-neutral-900">
                    Image not available
                  </div>
                )}
                <div>
                  {/* Human title, never the raw .jpg filename: the SESSION
                      date when the photo is attached to a session, else the
                      upload date as a fallback. */}
                  {img.sessionDate ? (
                    <>
                      <p
                        className="truncate text-sm font-medium"
                        title={`Session ${sessionDateLabel(img.sessionDate)}`}
                      >
                        Session {sessionDateLabel(img.sessionDate)}
                      </p>
                      <p className="mt-0.5 text-xs text-neutral-500">
                        Uploaded <FormattedDateTime iso={img.createdAt} />
                      </p>
                    </>
                  ) : (
                    <p className="text-sm font-medium">
                      Uploaded <FormattedDateTime iso={img.createdAt} />
                    </p>
                  )}
                </div>
                <ContextTags
                  scopeLabel={img.scopeLabel}
                  areaLabel={img.areaLabel}
                />
                <PhotoNoteEditor
                  imageId={img.id}
                  clientId={clientId}
                  note={img.note}
                />
                <div className="flex gap-3 text-xs">
                  <button
                    type="button"
                    onClick={() => openPreview(img)}
                    className="underline hover:text-neutral-900 dark:hover:text-neutral-100"
                  >
                    View larger
                  </button>
                  <button
                    type="button"
                    onClick={() => onArchive(img.id)}
                    disabled={busyId === img.id}
                    className="text-neutral-500 underline hover:text-neutral-900 disabled:opacity-60 dark:hover:text-neutral-100"
                  >
                    Archive
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
      <p className="text-xs text-neutral-500">
        Stored privately. Visible to practitioners in this studio.
      </p>

      {modal && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Treatment photo preview"
          onClick={() => setModal(null)}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="flex max-h-full w-full max-w-2xl flex-col overflow-auto rounded-lg bg-white p-4 dark:bg-neutral-900"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                {/* Human title (never the raw .jpg filename): session date
                    when attached to a session, else the upload date. */}
                {modal.sessionDate ? (
                  <>
                    <p
                      className="truncate text-sm font-medium"
                      title={`Session ${sessionDateLabel(modal.sessionDate)}`}
                    >
                      Session {sessionDateLabel(modal.sessionDate)}
                    </p>
                    <p className="text-xs text-neutral-500">
                      Uploaded <FormattedDateTime iso={modal.createdAt} />
                    </p>
                  </>
                ) : (
                  <p className="text-sm font-medium">
                    Uploaded <FormattedDateTime iso={modal.createdAt} />
                  </p>
                )}
                <div className="mt-1">
                  <ContextTags
                    scopeLabel={modal.scopeLabel}
                    areaLabel={modal.areaLabel}
                  />
                </div>
                <PhotoNoteEditor
                  imageId={modal.id}
                  clientId={clientId}
                  note={modal.note}
                />
              </div>
              <button
                type="button"
                onClick={() => setModal(null)}
                aria-label="Close preview"
                className="shrink-0 rounded-md border border-neutral-300 px-3 py-1 text-sm hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-800"
              >
                Close
              </button>
            </div>
            <div className="mt-3 flex min-h-[200px] items-center justify-center">
              {modalLoading ? (
                <p className="text-sm text-neutral-500">Loading preview…</p>
              ) : modalUrl && !modalError ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={modalUrl}
                  alt="Treatment photo"
                  onError={() => setModalError(true)}
                  className="max-h-[70vh] w-auto rounded-md object-contain"
                />
              ) : (
                <p className="text-sm text-neutral-400">Image not available</p>
              )}
            </div>
            <p className="mt-3 text-xs text-neutral-500">
              Stored privately. Visible to practitioners in this studio.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
