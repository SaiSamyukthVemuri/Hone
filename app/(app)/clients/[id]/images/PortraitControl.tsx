"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { setClientPortraitAction } from "./actions";

// FETT photos (HON-43), 0231: the identification-portrait action on a photo
// tile. Offered ONLY on client-scoped photos: the database refuses a session
// or treatment-area photo as a portrait, so the UI never offers one. Uses the
// shared Button, so it is on the 44px touch floor by construction.
export function PortraitControl({
  clientId,
  imageId,
  clientScope,
  isPortrait,
}: {
  clientId: string;
  imageId: string;
  clientScope: boolean;
  isPortrait: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  if (!clientScope) return null;

  function save(next: string | null) {
    setError(null);
    startTransition(async () => {
      const res = await setClientPortraitAction({ clientId, imageId: next });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col gap-1">
      {isPortrait ? (
        <div className="flex flex-wrap items-center gap-2">
          <span
            className="rounded-full bg-neutral-900 px-2 py-0.5 text-xs font-medium text-white dark:bg-white dark:text-neutral-900"
            data-testid="portrait-badge"
          >
            ID photo
          </span>
          <Button
            variant="quiet"
            size="sm"
            pending={pending}
            busyLabel="Removing…"
            onClick={() => save(null)}
          >
            Remove ID photo
          </Button>
        </div>
      ) : (
        <Button
          variant="secondary"
          size="sm"
          pending={pending}
          busyLabel="Saving…"
          onClick={() => save(imageId)}
        >
          Use as ID photo
        </Button>
      )}
      {error && (
        <p className="text-xs text-red-700" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
