// Valid buffer presets. The /settings/booking form exposes this fixed
// set as a dropdown; the server action rejects anything else so a
// tampered form post cannot smuggle a custom buffer through.
export const BUFFER_PRESET_MINUTES: ReadonlyArray<number> = [
  0, 5, 10, 15, 20, 30,
];
