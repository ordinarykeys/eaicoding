// Adapted from Harness ui-settings-account/formatBalance.ts (MIT); see THIRD_PARTY_NOTICES.md.
import { Big } from "big.js";

/** Preserve Platform decimal amounts and its positive/negative sub-cent display rules. */
export function formatBalance(amount: string, symbol: "¥" | "$"): string {
  const value = new Big(amount);
  if (value.eq(0)) return `${symbol}0.00`;
  if (value.lt(0)) return `-${symbol}${value.gt(-0.01) ? "0.01" : addCommas(value.abs().toFixed(2))}`;
  if (value.lt("0.01")) return `<${symbol}0.01`;
  return `${symbol}${addCommas(value.round(2, Big.roundDown).toFixed(2))}`;
}
function addCommas(value: string): string {
  const [integer, fraction] = value.split(".");
  return `${integer.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${fraction}`;
}
