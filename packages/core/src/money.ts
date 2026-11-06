// Money is stored and computed in integer minor units (cents) to avoid floating-point drift.
// PayPal takes decimal strings ("12.30"); conversion happens only at the API boundary.

export const toMinor = (major: number): number => Math.round(major * 100);
export const toMajorString = (minor: number): string => {
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(minor);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
};
export const fromMajorString = (value: string): number => {
  if (!/^-?\d+(\.\d{1,2})?$/.test(value)) throw new Error(`Invalid amount "${value}"`);
  return toMinor(Number(value));
};

/**
 * Splits a total across percentages so the parts always add up exactly to the total. Rounding
 * leftovers go to the last part (largest-remainder would also work; last-part is easier to explain).
 */
export function splitByPercent(totalMinor: number, percents: number[]): number[] {
  const parts = percents.map((p) => Math.floor((totalMinor * p) / 100));
  const used = parts.reduce((a, b) => a + b, 0);
  if (parts.length) parts[parts.length - 1] += totalMinor - used;
  return parts;
}

export const formatMoney = (minor: number, currency: string): string =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(minor / 100);
