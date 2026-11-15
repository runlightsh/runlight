/**
 * Whether the tracker's opt-out flag still holds, read as the tracker reads it: "1", which the switch in Settings
 * keeps, has no end; the time the site's ?runlight=ignore link keeps is good for a year.
 */
export const ignoreHolds = (value: string | null, now: number): boolean => value !== null && (value === "1" || now - Number(value) < 365 * 86_400_000);
