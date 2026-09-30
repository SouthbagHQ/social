// Formatting helpers. Australian English, Southbag deadpan.

const rtf = new Intl.RelativeTimeFormat('en-AU', { numeric: 'auto' });

/** "3m", "2h", "5d", or a date for older things. */
export function timeAgo(ms) {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 45) return 'now';
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  if (s < 7 * 86400) return `${Math.round(s / 86400)}d`;
  const d = new Date(ms);
  return d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', ...(d.getFullYear() !== new Date().getFullYear() && { year: 'numeric' }) });
}

/** "3 minutes ago" style, for watch pages. */
export function relative(ms) {
  const s = (ms - Date.now()) / 1000;
  const units = [['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60]];
  for (const [unit, size] of units) if (Math.abs(s) >= size) return rtf.format(Math.round(s / size), unit);
  return 'just now';
}

export const fullDate = ms => new Date(ms).toLocaleString('en-AU', { dateStyle: 'medium', timeStyle: 'short' });

/** 1234 → "1.2K". */
export function count(n) {
  n = Number(n) || 0;
  if (n < 1000) return String(n);
  if (n < 1e6) return `${(n / 1e3).toFixed(n < 1e4 ? 1 : 0).replace(/\.0$/, '')}K`;
  return `${(n / 1e6).toFixed(1).replace(/\.0$/, '')}M`;
}

export const plural = (n, word, many = `${word}s`) => `${count(n)} ${n === 1 ? word : many}`;

/** 125.4 → "2:05". */
export function duration(seconds) {
  if (!seconds && seconds !== 0) return '';
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
}

export const bytes = n => n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`;

/** Cents → "$12.00". */
export const money = cents => (cents / 100).toLocaleString('en-AU', { style: 'currency', currency: 'AUD' });
