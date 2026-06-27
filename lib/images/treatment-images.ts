// PR #271. Pure helpers for secure treatment image storage. NO I/O, NO secrets,
// NO server-only import — safe to unit test. The server-side storage plane
// (service-role upload + signed URLs) lives in the route's server actions; this
// module only validates uploads and builds SERVER-DERIVED storage paths.

export const TREATMENT_IMAGES_BUCKET = "treatment-images";

// Short-lived signed URLs: minted per view, never persisted, never public.
export const TREATMENT_IMAGE_SIGNED_URL_TTL_SECONDS = 60;

export const TREATMENT_IMAGE_MAX_BYTES = 15 * 1024 * 1024; // 15 MB

// MIME allowlist. SVG (scriptable vector) and PDFs/docs/videos are rejected.
export const TREATMENT_IMAGE_ALLOWED_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
] as const;
export type TreatmentImageContentType =
  (typeof TREATMENT_IMAGE_ALLOWED_TYPES)[number];

const EXT_BY_TYPE: Record<TreatmentImageContentType, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

export type UploadValidationResult =
  | { ok: true; contentType: TreatmentImageContentType }
  | { ok: false; error: string };

// Server-authoritative validation. The client `accept` attribute is only a
// hint; this is the real gate.
export function validateTreatmentImageUpload(input: {
  contentType: string;
  sizeBytes: number;
}): UploadValidationResult {
  const ct = (input.contentType || "").toLowerCase().trim();
  if (!TREATMENT_IMAGE_ALLOWED_TYPES.includes(ct as TreatmentImageContentType)) {
    return { ok: false, error: "Only JPEG, PNG, or WebP images are allowed." };
  }
  if (!Number.isFinite(input.sizeBytes) || input.sizeBytes <= 0) {
    return { ok: false, error: "Image file is empty." };
  }
  if (input.sizeBytes > TREATMENT_IMAGE_MAX_BYTES) {
    return { ok: false, error: "Image is larger than the 15 MB limit." };
  }
  return { ok: true, contentType: ct as TreatmentImageContentType };
}

// Display-only sanitization of the client-provided filename. NEVER used to
// build the storage path. Allowlist [A-Za-z0-9._ -]; anything else (including
// directory separators and control chars) becomes "_". Caps length; falls back
// to a safe default.
export function sanitizeFilename(name: string | null | undefined): string {
  const base = (name ?? "").split(/[\\/]/).pop() ?? "";
  const cleaned = base
    .replace(/[^A-Za-z0-9._ -]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  return cleaned.length > 0 ? cleaned : "image";
}

// Server-derived object key: <studio_id>/<client_id>/<id>.<ext>. The first
// segment (studio_id) is the storage RLS scoping key. `id` is a server-side
// uuid; NEVER derived from client input.
export function buildTreatmentImagePath(input: {
  studioId: string;
  clientId: string;
  id: string;
  contentType: TreatmentImageContentType;
}): string {
  const ext = EXT_BY_TYPE[input.contentType];
  return `${input.studioId}/${input.clientId}/${input.id}.${ext}`;
}
