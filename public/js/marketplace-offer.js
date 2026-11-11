// Offer amounts only. Listing prices and saved-search filters stay nonnegative.
export function offerCents(value) {
  const s = String(value ?? '').replace(/[$,\s]/g, '');
  if (!s) return null;
  if (!/^-?\d+(\.\d{1,2})?$/.test(s)) return NaN;
  const cents = Math.round(Number(s) * 100);
  return Number.isSafeInteger(cents) && Math.abs(cents) <= 1_000_000_000 ? cents : NaN;
}
