// The core decision: given a fair win chance and Kalshi's prices, bet now, place a waiting order, or skip.

import { evPerDollar, floorCent, kalshiFee, maxMakerPrice, sizeBet, validPrice } from "./pricing.ts";
import type { FeeInfo } from "./pricing.ts";
import { HARD } from "./rules.ts";
import type { Settings } from "./rules.ts";

export interface MarketQuote {
  yesBid: number;   // NaN if none
  yesAsk: number;   // NaN if none
  askSize: number;  // contracts available at the ask (NaN if unknown)
}

export interface Bankroll {
  equity: number;        // cash + money riding on open bets
  cash: number;          // spendable now
  openExposure: number;  // money riding on open bets (incl. resting orders)
}

export type Decision =
  | { action: "taker"; price: number; contracts: number; fee: number; ev: number; reason: string }
  | { action: "rest"; price: number; contracts: number; fee: number; ev: number; reason: string }
  | { action: "skip"; reason: string; ev?: number; price?: number; fee?: number };

export function decide(p: number, q: MarketQuote, s: Settings, bank: Bankroll, fee: FeeInfo): Decision {
  if (!(p > 0 && p < 1)) return { action: "skip", reason: "no fair price" };
  if (p < s.min_prob) return { action: "skip", reason: `long shot (${(p * 100).toFixed(0)}%)` };
  if (p > s.max_prob) return { action: "skip", reason: `heavy favorite (${(p * 100).toFixed(0)}%)` };

  const sizingBase = {
    p,
    bankroll: bank.equity,
    cashAvailable: bank.cash,
    openExposure: bank.openExposure,
    kellyFraction: s.kelly_fraction,
    maxStakePct: s.max_stake_pct,
    maxStakeUsd: HARD.MAX_STAKE_USD,
    maxOpenExposurePct: s.max_open_exposure_pct,
  };

  // 1) Take the current ask if it's good enough after the taker fee.
  if (validPrice(q.yesAsk)) {
    const size = sizeBet({ ...sizingBase, price: q.yesAsk, availableSize: Number.isFinite(q.askSize) ? q.askSize : undefined });
    if (size.contracts >= 1) {
      const f = kalshiFee(q.yesAsk, size.contracts, "taker", fee);
      const ev = evPerDollar(p, q.yesAsk, size.contracts, f);
      if (ev >= s.min_edge) {
        return { action: "taker", price: q.yesAsk, contracts: size.contracts, fee: f, ev, reason: `ask ${cents(q.yesAsk)} vs fair ${pct(p)}` };
      }
    }
  }

  if (s.order_style !== "smart") {
    return evSkip(p, q, fee, "price not good enough to take");
  }

  // 2) Otherwise post a waiting order at the highest price that still clears the edge as a maker.
  // Size first at a rough price, then find the price for that size, then re-check.
  const rough = maxMakerPrice(p, 1, s.min_edge, fee);
  if (rough === null) return evSkip(p, q, fee, "no maker price clears the edge");
  const size = sizeBet({ ...sizingBase, price: rough });
  if (size.contracts < 1) return { action: "skip", reason: size.reason };
  let limit = maxMakerPrice(p, size.contracts, s.min_edge, fee);
  if (limit === null) return evSkip(p, q, fee, "no maker price clears the edge");
  // Never post at or above the ask (that would just take liquidity at a worse price).
  if (validPrice(q.yesAsk) && limit >= q.yesAsk) limit = floorCent(q.yesAsk - 0.01);
  if (!validPrice(limit)) return evSkip(p, q, fee, "no room below the ask");
  // Don't bother posting far below the current bid; it will almost never fill.
  if (validPrice(q.yesBid) && limit < q.yesBid - 0.05) {
    return evSkip(p, q, fee, `our max ${cents(limit)} is far below the bid ${cents(q.yesBid)}`);
  }
  const f = kalshiFee(limit, size.contracts, "maker", fee);
  const ev = evPerDollar(p, limit, size.contracts, f);
  if (ev < s.min_edge) return evSkip(p, q, fee, "edge too small");
  return { action: "rest", price: limit, contracts: size.contracts, fee: f, ev, reason: `wait at ${cents(limit)} (fair ${pct(p)})` };
}

function evSkip(p: number, q: MarketQuote, fee: FeeInfo, reason: string): Decision {
  if (validPrice(q.yesAsk)) {
    const f = kalshiFee(q.yesAsk, 1, "taker", fee);
    return { action: "skip", reason, ev: evPerDollar(p, q.yesAsk, 1, f), price: q.yesAsk, fee: f };
  }
  return { action: "skip", reason };
}

const cents = (x: number) => `${Math.round(x * 100)}¢`;
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
