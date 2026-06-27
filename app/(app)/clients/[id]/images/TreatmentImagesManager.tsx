"use client";

import { useState, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { FormattedDateTime } from "@/components/formatted-date-time";
import {
  uploadTreatmentImageAction,
  getTreatmentImageSignedUrlAction,
  archiveTreatmentImageAction,
} from "./actions";

// PR #271. Practitioner-only treatment images UI. Upload goes to a private
// bucket via a server action; viewing mints a short-TTL signed URL on demand
// (no persisted/public URL). Soft-delete only (archive).

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
    <section className="flex flex-col gap-4 rounded-lg border border-neutral-200 p-5 dark:border-neutral-800">
      <form onSubmit={onUpload} className="flex flex-wrap items-center gap-3">
        <input
          type="file"
          name="file"
          accept="image/jpeg,image/png,image/webp"
          className="text-sm text-neutral-700 dark:text-neutral-300"
        />
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700 disabled:opacity-60 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
        >
          {pending ? "Uploading…" : "Attach image"}
        </button>
      </form>
      <p className="text-xs text-neutral-500">
        Stored privately. Visible to practitioners in this studio. JPEG, PNG, or
        WebP, up to 15 MB.
      </p>
      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

      {images.length === 0 ? (
        <p className="text-sm text-neutral-500">No treatment images yet.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {images.map((img) => (
            <li
              key={img.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-neutral-200 px-3 py-2 dark:border-neutral-800"
            >
              <div className="flex flex-col">
                <span className="text-sm font-medium">
                  {img.filename ?? "Image"}
                </span>
                <span className="text-xs text-neutral-500">
                  Uploaded <FormattedDateTime iso={img.createdAt} />
                </span>
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
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
