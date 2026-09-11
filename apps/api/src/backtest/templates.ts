import { InputError, object } from '../research/validation.js';
import { ACTIVE_REGIME_SETS, BACKTEST_STRATEGY_METHOD, type ActiveRegimeSet, type RegimeStrategyParams } from './calculations.js';
import { PORTFOLIO_STRATEGY_METHOD, parseStrategySpec } from './strategy-spec.js';

export type TemplateStatus = 'available' | 'deferred';
export type BacktestTemplate = {
  key: string;
  label: string;
  summary: string;
  methodologyVersion: string;
  status: TemplateStatus;
  gate: string | null;
  parse?: (input: unknown) => Record<string, unknown>;
};

const calendarDate = (value: unknown, field: string): string | null => {
  if (value === undefined || value === null || value === '') return null;
  const parsed = typeof value === 'string' ? Date.parse(`${value}T00:00:00.000Z`) : NaN;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(parsed)
      || new Date(parsed).toISOString().slice(0, 10) !== value)
    throw new InputError(`${field} must be a calendar date (YYYY-MM-DD)`);
  return value;
};
const intInRange = (value: unknown, field: string, min: number, max: number, fallback: number): number => {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max)
    throw new InputError(`${field} must be an integer between ${min} and ${max}`);
  return value;
};

function parseRegimeStrategy(input: unknown): RegimeStrategyParams & Record<string, unknown> {
  const row = object(input ?? {});
  if (Object.keys(row).some(key => !['activeRegimes', 'from', 'to', 'holdoutPct', 'costBps'].includes(key)))
    throw new InputError('Unsupported regime backtest option');
  const activeRegimes = (row.activeRegimes ?? 'bullish') as ActiveRegimeSet;
  if (!Object.keys(ACTIVE_REGIME_SETS).includes(String(activeRegimes)))
    throw new InputError('activeRegimes must be "bullish" or "bullish+transitional"');
  const from = calendarDate(row.from, 'from');
  const to = calendarDate(row.to, 'to');
  if (from && to && from > to) throw new InputError('The backtest start must precede its end');
  return {
    activeRegimes,
    from,
    to,
    holdoutPct: intInRange(row.holdoutPct, 'holdoutPct', 10, 50, 30),
    costBps: intInRange(row.costBps, 'costBps', 0, 200, 25),
  };
}

const deferred = (key: string, label: string, summary: string, methodologyVersion: string): BacktestTemplate => ({
  key, label, summary, methodologyVersion, status: 'deferred',
  gate: 'Deferred: this study needs point-in-time replay coverage this archive has not yet accumulated. Only BTC price history is backfillable; every altcoin, perp and launch dataset began archiving in stage 1 and is still measured in days.',
});

export const BACKTEST_TEMPLATES: BacktestTemplate[] = [
  {
    key: 'btc-regime-filter',
    label: 'BTC regime filter vs BTC buy-and-hold',
    summary: 'Hold BTC only while the confirmed daily regime is bullish (optionally also transitional); otherwise sit flat. Compared against always-invested BTC with a per-side execution-cost assumption and a chronological holdout.',
    methodologyVersion: BACKTEST_STRATEGY_METHOD,
    status: 'available',
    gate: null,
    parse: parseRegimeStrategy,
  },
  {
    key: 'custom-strategy',
    label: 'Custom strategy (portfolio engine)',
    summary: 'Compose a starting capital and recurring contribution with your own entry rule (trigger + optional indicator guard + size) and exit rule (indicator trigger + size). Compared against buy-every-dollar DCA and a hindsight lump sum, with a money-weighted return, a trade ledger and a chronological holdout.',
    methodologyVersion: PORTFOLIO_STRATEGY_METHOD,
    status: 'available',
    gate: null,
    parse: parseStrategySpec,
  },
  deferred('emerging-attention-basket', 'Weekly top-10 Emerging Projects attention basket', 'Equal-weight the ten highest-Attention eligible assets each week; compare with BTC and an equal-weight eligible-universe benchmark.', 'emerging-attention-basket:v0'),
  deferred('early-launch-event-study', 'Early spot-launch signal study', 'Forward 1D/7D/30D returns after a token first clears the launch shortlist.', 'early-launch-event-study:v0'),
  deferred('perp-project-study', 'Perp DEX project adoption study', 'Forward 30D/90D adoption, market share and revenue after a protocol milestone.', 'perp-project-study:v0'),
  deferred('perp-listing-event-study', 'New perp listing event study', 'Underlying spot returns versus BTC at 1D/7D/30D around a venue-new listing, kept separate from funded perpetual P&L.', 'perp-listing-event-study:v0'),
];

export function findTemplate(key: unknown): BacktestTemplate {
  const template = BACKTEST_TEMPLATES.find(entry => entry.key === key);
  if (!template) throw new InputError('Unknown backtest template', 404);
  return template;
}
