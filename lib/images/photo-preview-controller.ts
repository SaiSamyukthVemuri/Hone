// One preview's current image/request identity. Server actions cannot be
// aborted, so superseded completions are ignored, including re-opening the
// SAME image after close. No signed URL may cross a preview generation.
export type PhotoPreviewState = {
  imageId: string;
  generation: number;
  status: "loading" | "ready" | "error";
  url: string | null;
};

type SignedPreview = { ok: true; url: string } | { ok: false; error?: string };

export function createPhotoPreviewController(deps: {
  request: (imageId: string) => Promise<SignedPreview>;
  write: (state: PhotoPreviewState | null) => void;
}) {
  let generation = 0;
  let currentImage: string | null = null;

  const current = (imageId: string, requestGeneration: number) =>
    imageId === currentImage && requestGeneration === generation;

  return {
    async open(imageId: string): Promise<void> {
      const requestGeneration = ++generation;
      currentImage = imageId;
      deps.write({ imageId, generation: requestGeneration, status: "loading", url: null });
      try {
        const result = await deps.request(imageId);
        if (!current(imageId, requestGeneration)) return;
        deps.write({
          imageId,
          generation: requestGeneration,
          status: result.ok ? "ready" : "error",
          url: result.ok ? result.url : null,
        });
      } catch {
        if (!current(imageId, requestGeneration)) return;
        deps.write({ imageId, generation: requestGeneration, status: "error", url: null });
      }
    },
    close() {
      ++generation;
      currentImage = null;
      deps.write(null);
    },
    onImageError(imageId: string, requestGeneration: number) {
      if (!current(imageId, requestGeneration)) return;
      deps.write({ imageId, generation: requestGeneration, status: "error", url: null });
    },
    dispose() {
      ++generation;
      currentImage = null;
    },
  };
}
