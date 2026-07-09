import Decimal from "decimal.js";

/**
 * A monetary amount. This module was migrated away from integer cents to an
 * exact Decimal representation so fractional pricing (percentages, tax, FX)
 * stays precise. Every money value in this codebase is now a Decimal.
 */
export type Money = Decimal;

/** Construct a Money value from a number, string, or existing Decimal. */
export const money = (value: Decimal.Value): Money => new Decimal(value);

/** The additive identity, as Money. */
export const ZERO: Money = new Decimal(0);
