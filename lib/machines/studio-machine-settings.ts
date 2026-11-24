/**
 * THE OWNER'S MACHINE SWITCHES, as the settings page needs them.
 *
 * Reads go through `get_studio_machine_choices()` (the signed-in user's own studios; EVERY model with its `enabled` switch; nothing while the
 * platform rollout is off for the studio). Writes go through the two owner commands. "Nothing enabled" is rows that are all off, and "not
 * available" is no rows (or a failed read), so the two are never confused.
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

/** The studio's enabled models and its default, from the choices rows. A failed or malformed read, or NO rows for the studio (rollout off), is null. All rows off is `enabled: []`, not null. */
export async function readStudioMachineSettings(studioId: string, rpc: Rpc): Promise<StudioMachineSettings | null> {
  try {
    const { data, error } = await rpc("get_studio_machine_choices");
    if (error || !Array.isArray(data)) return null;
    const mine = data.filter((r): r is { studio_id: string; profile_id: string; enabled?: unknown; is_default?: boolean | null } => !!r && typeof r === "object" && (r as { studio_id?: unknown }).studio_id === studioId);
    if (mine.length === 0) return null;
    const enabled = STUDIO_MACHINE_MODELS.map((m) => m.profileId).filter((id) => mine.some((r) => r.profile_id === id && r.enabled === true));
    const def = mine.find((r) => r.enabled === true && r.is_default === true && isModel(r.profile_id));
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
 * Null means "the switches do not apply here" (rollout off, a failed read): the picker is exactly what it was. An EMPTY `enabled` set means the
 * owner switched every model off: the chart then offers no machine and says so.
 */
export type StudioMachineChoices = { enabled: ReadonlySet<string>; defaultProfileId: string | null };

export async function readStudioMachineChoices(studioId: string, rpc: Rpc): Promise<StudioMachineChoices | null> {
  const s = await readStudioMachineSettings(studioId, rpc);
  if (!s) return null;
  return { enabled: new Set(s.enabled), defaultProfileId: s.defaultProfileId };
}
