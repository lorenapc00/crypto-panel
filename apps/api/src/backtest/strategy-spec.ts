import { InputError, object } from '../research/validation.js';

export const PORTFOLIO_STRATEGY_METHOD = 'portfolio-strategy:v1';
export const REGIME_LABELS = ['bullish', 'transitional', 'bearish'] as const;

export type Op = 'gte' | 'lte';
export type Condition =
  | { type: 'none' }
  | { type: 'regime-in'; regimes: string[] }
  | { type: 'regime-leave'; regimes: string[] }
  | { type: 'new-ath' }
  | { type: 'drawdown-from-ath'; op: Op; pct: number }
  | { type: 'mayer'; op: Op; value: number }
  | { type: 'price-vs-sma200'; side: 'above' | 'below' }
  | { type: 'weekly-rsi'; op: Op; value: number }
  | { type: 'mvrv'; op: Op; value: number };

export type BuySize = { type: 'all-cash' } | { type: 'fixed'; value: number } | { type: 'pct-cash'; value: number };
export type SellSize = { type: 'all' } | { type: 'pct'; value: number };

export type StrategySpec = {
  startCapitalUsd: number;
  contribution: { amountUsd: number; cadence: 'monthly' | 'weekly'; day: number };
  entry: {
    trigger: 'on-contribution' | 'monthly' | 'weekly';
    day: number;
    guard: Condition;
    size: BuySize;
    redeploy: 'immediate' | 'scheduled';
  };
  exit: { trigger: Condition; size: SellSize };
  costBps: number;
  from: string | null;
  to: string | null;
  holdoutPct: number;
};

function enumValue<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value))
    throw new InputError(`${field} must be one of: ${allowed.join(', ')}`);
  return value as T;
}
function number_(value: unknown, field: string, min: number, max: number, fallback?: number): number {
  if (value === undefined || value === null) {
    if (fallback !== undefined) return fallback;
    throw new InputError(`${field} is required`);
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max)
    throw new InputError(`${field} must be a number between ${min} and ${max}`);
  return value;
}
function integer(value: unknown, field: string, min: number, max: number, fallback?: number): number {
  const n = number_(value, field, min, max, fallback);
  if (!Number.isInteger(n)) throw new InputError(`${field} must be a whole number`);
  return n;
}
function calendarDate(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === '') return null;
  const parsed = typeof value === 'string' ? Date.parse(`${value}T00:00:00.000Z`) : NaN;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(parsed)
      || new Date(parsed).toISOString().slice(0, 10) !== value)
    throw new InputError(`${field} must be a calendar date (YYYY-MM-DD)`);
  return value;
}
function regimeSet(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || !value.length || value.length > REGIME_LABELS.length)
    throw new InputError(`${field} must be a non-empty list of regime labels`);
  const set = [...new Set(value)];
  for (const label of set) if (!REGIME_LABELS.includes(label as never)) throw new InputError(`${field}: unknown regime "${label}"`);
  return set;
}

function parseCondition(input: unknown, field: string): Condition {
  const row = object(input);
  const type = enumValue(row.type, ['none', 'regime-in', 'regime-leave', 'new-ath', 'drawdown-from-ath', 'mayer', 'price-vs-sma200', 'weekly-rsi', 'mvrv'] as const, `${field}.type`);
  const only = (keys: string[]) => {
    for (const key of Object.keys(row)) if (key !== 'type' && !keys.includes(key)) throw new InputError(`${field}: unsupported field "${key}"`);
  };
  switch (type) {
    case 'none': only([]); return { type };
    case 'new-ath': only([]); return { type };
    case 'regime-in': case 'regime-leave': only(['regimes']); return { type, regimes: regimeSet(row.regimes, `${field}.regimes`) };
    case 'price-vs-sma200': only(['side']); return { type, side: enumValue(row.side, ['above', 'below'] as const, `${field}.side`) };
    case 'drawdown-from-ath': only(['op', 'pct']); return { type, op: enumValue(row.op, ['gte', 'lte'] as const, `${field}.op`), pct: number_(row.pct, `${field}.pct`, 0, 100) };
    case 'mayer': only(['op', 'value']); return { type, op: enumValue(row.op, ['gte', 'lte'] as const, `${field}.op`), value: number_(row.value, `${field}.value`, 0, 100) };
    case 'weekly-rsi': only(['op', 'value']); return { type, op: enumValue(row.op, ['gte', 'lte'] as const, `${field}.op`), value: number_(row.value, `${field}.value`, 0, 100) };
    case 'mvrv': only(['op', 'value']); return { type, op: enumValue(row.op, ['gte', 'lte'] as const, `${field}.op`), value: number_(row.value, `${field}.value`, 0, 100) };
  }
}

function parseBuySize(input: unknown): BuySize {
  const row = object(input);
  const type = enumValue(row.type, ['all-cash', 'fixed', 'pct-cash'] as const, 'entry.size.type');
  if (type === 'all-cash') { if (Object.keys(row).length > 1) throw new InputError('entry.size: all-cash takes no value'); return { type }; }
  return { type, value: number_(row.value, 'entry.size.value', type === 'fixed' ? 1 : 0.01, type === 'fixed' ? 1e9 : 100) };
}
function parseSellSize(input: unknown): SellSize {
  const row = object(input);
  const type = enumValue(row.type, ['all', 'pct'] as const, 'exit.size.type');
  if (type === 'all') { if (Object.keys(row).length > 1) throw new InputError('exit.size: all takes no value'); return { type }; }
  return { type, value: number_(row.value, 'exit.size.value', 0.01, 100) };
}

/** Parse and fully validate a custom strategy specification. Every level whitelists its
 *  keys so a typo widens nothing silently. */
export function parseStrategySpec(input: unknown): StrategySpec {
  const row = object(input ?? {});
  const allowed = ['startCapitalUsd', 'contribution', 'entry', 'exit', 'costBps', 'from', 'to', 'holdoutPct'];
  for (const key of Object.keys(row)) if (!allowed.includes(key)) throw new InputError(`Unsupported strategy field "${key}"`);

  const contributionRow = row.contribution === undefined ? {} : object(row.contribution);
  for (const key of Object.keys(contributionRow)) if (!['amountUsd', 'cadence', 'day'].includes(key)) throw new InputError(`contribution: unsupported field "${key}"`);
  const cadence = contributionRow.cadence === undefined ? 'monthly' : enumValue(contributionRow.cadence, ['monthly', 'weekly'] as const, 'contribution.cadence');
  const contribution = {
    amountUsd: number_(contributionRow.amountUsd, 'contribution.amountUsd', 0, 1e9, 0),
    cadence,
    day: integer(contributionRow.day, 'contribution.day', cadence === 'monthly' ? 1 : 0, cadence === 'monthly' ? 28 : 6, cadence === 'monthly' ? 1 : 1),
  };

  const entryRow = object(row.entry ?? {});
  for (const key of Object.keys(entryRow)) if (!['trigger', 'day', 'guard', 'size', 'redeploy'].includes(key)) throw new InputError(`entry: unsupported field "${key}"`);
  const entryTrigger = entryRow.trigger === undefined ? 'on-contribution' : enumValue(entryRow.trigger, ['on-contribution', 'monthly', 'weekly'] as const, 'entry.trigger');
  const entry = {
    trigger: entryTrigger,
    day: integer(entryRow.day, 'entry.day', entryTrigger === 'weekly' ? 0 : 1, entryTrigger === 'weekly' ? 6 : 28, 1),
    guard: entryRow.guard === undefined ? { type: 'none' as const } : parseCondition(entryRow.guard, 'entry.guard'),
    size: entryRow.size === undefined ? { type: 'all-cash' as const } : parseBuySize(entryRow.size),
    redeploy: entryRow.redeploy === undefined ? 'immediate' : enumValue(entryRow.redeploy, ['immediate', 'scheduled'] as const, 'entry.redeploy'),
  };

  const exitRow = object(row.exit ?? {});
  for (const key of Object.keys(exitRow)) if (!['trigger', 'size'].includes(key)) throw new InputError(`exit: unsupported field "${key}"`);
  const exit = {
    trigger: exitRow.trigger === undefined ? { type: 'none' as const } : parseCondition(exitRow.trigger, 'exit.trigger'),
    size: exitRow.size === undefined ? { type: 'all' as const } : parseSellSize(exitRow.size),
  };

  const startCapitalUsd = number_(row.startCapitalUsd, 'startCapitalUsd', 0, 1e9, 0);
  if (startCapitalUsd === 0 && contribution.amountUsd === 0) throw new InputError('A strategy needs a starting capital or a recurring contribution');

  const from = calendarDate(row.from, 'from');
  const to = calendarDate(row.to, 'to');
  if (from && to && from > to) throw new InputError('The backtest start must precede its end');

  return {
    startCapitalUsd, contribution, entry, exit, from, to,
    costBps: integer(row.costBps, 'costBps', 0, 200, 25),
    holdoutPct: integer(row.holdoutPct, 'holdoutPct', 10, 50, 30),
  };
}
