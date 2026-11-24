/**
 * THE OWNER'S MACHINE SWITCHES, as the settings page needs them.
 *
 * Reads go through `get_studio_machine_choices()` (the signed-in user's own studios; ONLY enabled models; nothing while the platform rollout is
 * off for the studio). Writes go through the two owner commands. A disabled model is therefore "not in the list", and the page decides whether
 * the rollout is on separately, so "nothing enabled" is never confused with "not available yet".
 */
export const STUDIO_MACHINE_MODELS = [
  { profileId: "dectro-apilus:xcell-pur", name: "Dectro xCell", description: "Thermolysis, Blend, Galvanic, MultiPlex" },
  { profileId: "dectro-apilus:senior-3g", name: "Apilus Senior 3G", description: "Thermo Flash, MicroFlash, MultiPlex, Blend and more" },
  { profileId: "dectro-apilus:junior-3g", name: "Apilus Junior 3G", description: "Thermolysis, Flash Thermo, Blend, OmniBlend, Electrolysis" },
] as const;

export type StudioMachineModelId = (typeof STUDIO_MACHINE_MODELS)[number]["profileId"];
export type StudioMachineSettings = { enabled: StudioMachineModelId[]; defaultProfileId: StudioMachineModelId | null };

type Rpc = (fn: string, args?: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message?: string; code?: string } | null }>;

const isModel = (v: unknown): v is StudioMachineModelId => STUDIO_MACHINE_MODELS.some((m) => m.profileId === v);

/** The studio's enabled models and its default, from the choices rows. A failed or malformed read is null (the page says it could not load). */
export async function readStudioMachineSettings(studioId: string, rpc: Rpc): Promise<StudioMachineSettings | null> {
  try {
    const { data, error } = await rpc("get_studio_machine_choices");
    if (error || !Array.isArray(data)) return null;
    const mine = data.filter((r): r is { studio_id: string; profile_id: string; is_default?: boolean | null } => !!r && typeof r === "object" && (r as { studio_id?: unknown }).studio_id === studioId);
    const enabled = STUDIO_MACHINE_MODELS.map((m) => m.profileId).filter((id) => mine.some((r) => r.profile_id === id));
    const def = mine.find((r) => r.is_default === true && isModel(r.profile_id));
    return { enabled, defaultProfileId: def && isModel(def.profile_id) ? def.profile_id : null };
  } catch {
    return null;
  }
}

export type SettingsWrite = { ok: true } | { ok: false; error: string };
const GENERIC = "Your machine settings could not be saved. Nothing was changed.";

export async function setStudioMachineModel(studioId: string, profileId: string, enabled: boolean, rpc: Rpc): Promise<SettingsWrite> {
  if (!isModel(profileId)) return { ok: false, error: GENERIC };
  try {
    const { error } = await rpc("set_studio_machine_model", { p_studio: studioId, p_profile: profileId, p_enabled: enabled });
    return error ? { ok: false, error: GENERIC } : { ok: true };
  } catch {
    return { ok: false, error: GENERIC };
  }
}

/** profileId null = "ask at each visit". */
export async function setStudioMachineDefault(studioId: string, profileId: string | null, rpc: Rpc): Promise<SettingsWrite> {
  if (profileId !== null && !isModel(profileId)) return { ok: false, error: GENERIC };
  try {
    const { error } = await rpc("set_studio_machine_default", { p_studio: studioId, p_profile: profileId, p_ask: profileId === null });
    return error ? { ok: false, error: GENERIC } : { ok: true };
  } catch {
    return { ok: false, error: GENERIC };
  }
}

/**
 * WHAT THE PICKER OFFERS A NEW AREA. From the same choices rows: the enabled models, the default model, and each enabled model's live unit.
 * Null means "the switches do not apply here" (rollout off, nothing enabled, a failed read): the picker is exactly what it was.
 */
export type StudioMachineChoices = { enabled: ReadonlySet<string>; defaultProfileId: string | null };

export async function readStudioMachineChoices(studioId: string, rpc: Rpc): Promise<StudioMachineChoices | null> {
  const s = await readStudioMachineSettings(studioId, rpc);
  if (!s || s.enabled.length === 0) return null;
  return { enabled: new Set(s.enabled), defaultProfileId: s.defaultProfileId };
}
