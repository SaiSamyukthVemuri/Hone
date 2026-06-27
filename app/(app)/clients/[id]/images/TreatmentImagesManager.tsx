"use client";

import { useState, useTransition, type FormEvent, type ChangeEvent } from "react";
import { useRouter } from "next/navigation";
import { FormattedDateTime } from "@/components/formatted-date-time";
import {
  uploadTreatmentImageAction,
  getTreatmentImageSignedUrlAction,
  archiveTreatmentImageAction,
} from "./actions";

// PR #271 / #272. Practitioner-only "Treatment Photos" UI. Upload goes to a
// private bucket via a server action; viewing mints a short-TTL signed URL on
// demand (no persisted/public URL). Soft-delete only (archive).
// PR #272 is UI polish only: a styled upload card (the native file input stays,
// just visually hidden behind a "Choose image" label) + a gallery card grid +
// empty state. Storage / signed-URL / RLS / validation are unchanged.

type Row = { id: string; filename: string | null; createdAt: string };

export function TreatmentImagesManager({
  clientId,
  images,
}: {
  clientId: string;
  images: Row[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [selectedName, setSelectedName] = useState<string | null>(null);

  function onPick(e: ChangeEvent<HTMLInputElement>) {
    setError(null);
    setSelectedName(e.target.files?.[0]?.name ?? null);
  }

  function onUpload(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const form = e.currentTarget;
    const fd = new FormData(form);
    fd.set("clientId", clientId);
    const file = fd.get("file");
    if (!(file instanceof File) || file.size === 0) {
      setError("Choose an image first.");
      return;
    }
    startTransition(async () => {
      const res = await uploadTreatmentImageAction(fd);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      form.reset();
      setSelectedName(null);
      router.refresh();
    });
  }

  async function onView(id: string) {
    setError(null);
    setBusyId(id);
    const res = await getTreatmentImageSignedUrlAction({ imageId: id });
    setBusyId(null);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    window.open(res.url, "_blank", "noopener,noreferrer");
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
      {/* Upload card — styled "Choose image" affordance over the native input. */}
      <section className="rounded-lg border border-neutral-200 p-5 dark:border-neutral-800">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-neutral-700 dark:text-neutral-300">
          Treatment Photos
        </h2>
        <p className="mt-1 text-xs text-neutral-500">
          Stored privately. Visible to practitioners in this studio. JPEG, PNG,
          or WebP, up to 15 MB.
        </p>
        <form
          onSubmit={onUpload}
          className="mt-3 flex flex-wrap items-center gap-3"
        >
          <label className="cursor-pointer rounded-md border border-neutral-300 px-4 py-2 text-sm font-medium text-neutral-800 hover:bg-neutral-50 dark:border-neutral-700 dark:text-neutral-100 dark:hover:bg-neutral-900">
            Choose image
            {/* Native input kept (accessible) but visually hidden behind the
                styled label, so the rough "No file chosen" text is not the
                primary UI. */}
            <input
              type="file"
              name="file"
              accept="image/jpeg,image/png,image/webp"
              onChange={onPick}
              className="sr-only"
            />
          </label>
          <span className="text-sm text-neutral-600 dark:text-neutral-300">
            {selectedName ? (
              <>
                Selected image:{" "}
                <span className="font-medium">{selectedName}</span>
              </>
            ) : (
              "No image chosen yet."
            )}
          </span>
          <button
            type="submit"
            disabled={pending || !selectedName}
            className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
          >
            {pending ? "Uploading…" : "Attach image"}
          </button>
        </form>
        {error && (
          <p className="mt-2 text-sm text-red-600 dark:text-red-400">{error}</p>
        )}
      </section>

      {/* Gallery — card grid (filename + date + View/Archive). Thumbnails are
          deferred (would require eagerly signing every image, a signed-URL flow
          change); viewing stays on-demand. */}
      {images.length === 0 ? (
        <div className="rounded-lg border border-dashed border-neutral-300 p-8 text-center dark:border-neutral-700">
          <p className="text-sm font-medium">No treatment photos yet</p>
          <p className="mt-1 text-sm text-neutral-500">
            Attach a photo to keep visual treatment references with this client.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {images.map((img) => (
            <div
              key={img.id}
              className="flex flex-col justify-between gap-2 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800"
            >
              <div>
                <p className="truncate text-sm font-medium" title={img.filename ?? "Image"}>
                  {img.filename ?? "Image"}
                </p>
                <p className="mt-0.5 text-xs text-neutral-500">
                  Uploaded <FormattedDateTime iso={img.createdAt} />
                </p>
              </div>
              <div className="flex gap-3 text-xs">
                <button
                  type="button"
                  onClick={() => onView(img.id)}
                  disabled={busyId === img.id}
                  className="underline hover:text-neutral-900 disabled:opacity-60 dark:hover:text-neutral-100"
                >
                  {busyId === img.id ? "…" : "View"}
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
          ))}
        </div>
      )}
      <p className="text-xs text-neutral-500">
        Stored privately. Visible to practitioners in this studio.
      </p>
    </div>
  );
}
