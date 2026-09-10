export class InputError extends Error { constructor(message: string, public status = 400) { super(message); } }
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new InputError('Expected an object');
  return value as Record<string, unknown>;
}
export function text(value: unknown, name: string, max = 100): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) throw new InputError(`${name} must contain 1–${max} characters`);
  return value.trim();
}
export function id(value: unknown): string {
  const result = text(value, 'ID', 150);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(result)) throw new InputError('Invalid ID');
  return result;
}
export function uuid(value: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw new InputError('Invalid record ID');
  return value;
}
export function finite(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new InputError(`${name} must be a finite number`);
  return value;
}
export function version(value: unknown): number {
  const n = finite(value, 'Version');
  if (!Number.isSafeInteger(n) || n < 1) throw new InputError('Invalid version');
  return n;
}
export function filters(value: unknown) {
  const row = object(value);
  if (Object.keys(row).some(key => !['query','sort','minCap','maxCap'].includes(key))) throw new InputError('Unsupported screen filter');
  const query = row.query === undefined ? '' : typeof row.query === 'string' && row.query.length <= 150 ? row.query : null;
  const sort = row.sort ?? 'rank';
  if (query === null || !['rank','cap','change'].includes(String(sort))) throw new InputError('Invalid screen filters');
  const minCap = row.minCap == null ? null : finite(row.minCap, 'Minimum market cap');
  const maxCap = row.maxCap == null ? null : finite(row.maxCap, 'Maximum market cap');
  if ((minCap !== null && minCap < 0) || (maxCap !== null && maxCap < 0) || (minCap !== null && maxCap !== null && minCap > maxCap)) throw new InputError('Invalid market cap range');
  return { query, sort: sort as 'rank' | 'cap' | 'change', minCap, maxCap };
}
