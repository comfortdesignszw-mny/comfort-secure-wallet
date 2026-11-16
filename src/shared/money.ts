import { Currency, FeeRuleRecord } from './types.ts';

export const CURRENCY_DECIMALS: Record<Currency, number> = {
  [Currency.USD]: 2,
  [Currency.ZWG]: 2,
  [Currency.ZAR]: 2,
};

export const CURRENCY_SYMBOLS: Record<Currency, string> = {
  [Currency.USD]: '$',
  [Currency.ZWG]: 'ZiG ',
  [Currency.ZAR]: 'R',
};

/**
 * Assert an integer minor-unit quantity is safe, finite, and strictly positive when required.
 */
export function assertMinorUnits(amountMinor: number, options?: { allowZero?: boolean }): number {
  if (!Number.isSafeInteger(amountMinor)) {
    throw new Error(`Invalid monetary amount: must be safe integer minor units, received ${amountMinor}`);
  }
  if (options?.allowZero ? amountMinor < 0 : amountMinor <= 0) {
    throw new Error(`Monetary amount out of bounds: ${amountMinor}`);
  }
  return amountMinor;
}

/**
 * Convert a human decimal string (e.g. "20.50") to exact integer minor units without floating-point arithmetic.
 */
export function parseDecimalToMinorUnits(input: string, currency: Currency = Currency.USD): number {
  const cleaned = input.trim();
  const decimals = CURRENCY_DECIMALS[currency];
  const match = cleaned.match(/^(\d+)(?:\.(\d+))?$/);
  if (!match) {
    throw new Error('Invalid monetary format');
  }
  const whole = match[1];
  const frac = match[2] ?? '';
  if (frac.length > decimals) {
    throw new Error(`Maximum ${decimals} decimal places allowed for ${currency}`);
  }
  const paddedFrac = frac.padEnd(decimals, '0');
  const minor = Number(`${whole}${paddedFrac}`);
  return assertMinorUnits(minor);
}

/**
 * Format integer minor units (e.g. 2050) into exact currency string (e.g. "$20.50") using integer division.
 */
export function formatMinorUnits(amountMinor: number, currency: Currency = Currency.USD): string {
  const safe = Number.isSafeInteger(amountMinor) ? amountMinor : Math.trunc(amountMinor);
  const negative = safe < 0;
  const abs = Math.abs(safe);
  const decimals = CURRENCY_DECIMALS[currency];
  const factor = 10 ** decimals;
  const whole = Math.floor(abs / factor);
  const frac = String(abs % factor).padStart(decimals, '0');
  const formattedWhole = whole.toLocaleString('en-US');
  const sign = negative ? '-' : '';
  return `${sign}${CURRENCY_SYMBOLS[currency]}${formattedWhole}.${frac}`;
}

/**
 * Calculate transaction fee strictly in integer minor units (rounded half-up) bounded by min/max.
 */
export function calculateFeeMinor(amountMinor: number, rule: Pick<FeeRuleRecord, 'flatMinor' | 'percentBps' | 'minMinor' | 'maxMinor' | 'active'> | null): number {
  assertMinorUnits(amountMinor);
  if (!rule || !rule.active) return 0;

  // percentBps: 100 bps = 1% -> numerator = amountMinor * percentBps, denominator = 10_000
  const percentageFee = Math.floor((amountMinor * rule.percentBps + 5000) / 10000);
  let totalFee = rule.flatMinor + percentageFee;

  if (rule.minMinor > 0 && totalFee < rule.minMinor) {
    totalFee = rule.minMinor;
  }
  if (rule.maxMinor > 0 && totalFee > rule.maxMinor) {
    totalFee = rule.maxMinor;
  }
  return Math.max(0, totalFee);
}
