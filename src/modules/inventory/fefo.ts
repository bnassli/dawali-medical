/**
 * I4 (ADR-042): first-expiry-first-out allocation of a quantity over the
 * batches of one product in one store. Pure (no database), so the visit screen
 * previews exactly what the server will take; the server runs it again on the
 * balances it has locked. Expired batches are never taken (PO decision).
 */
export interface FefoBatch {
  batchId: string;
  expiryDate: string | null;
  quantity: number;
}

export interface FefoTake {
  batchId: string;
  quantity: number;
}

/** At the point of use a batch this close to its expiry is flagged (PO decision: 30 days). */
export const USE_WARNING_DAYS = 30;

/** Whole days from `today` to `expiryDate` (both ISO yyyy-mm-dd); negative once expired. */
export function daysUntil(expiryDate: string, today: string): number {
  return Math.round((Date.parse(expiryDate) - Date.parse(today)) / 86_400_000);
}

const cents = (n: number) => Math.round(n * 100);

/** Earliest expiry first, batches without an expiry last; deterministic for equal dates. */
export function fefoOrder<T extends { batchId: string; expiryDate: string | null }>(batches: T[]): T[] {
  return [...batches].sort((a, b) => {
    if (a.expiryDate !== b.expiryDate) {
      if (a.expiryDate === null) return 1;
      if (b.expiryDate === null) return -1;
      return a.expiryDate < b.expiryDate ? -1 : 1;
    }
    return a.batchId < b.batchId ? -1 : a.batchId > b.batchId ? 1 : 0;
  });
}

/**
 * Takes `quantity` from the usable batches (expiry on or after `today`, ISO
 * yyyy-mm-dd), earliest expiry first. `short` is what could not be covered
 * (0 = enough stock).
 */
export function allocateFefo(batches: FefoBatch[], quantity: number, today: string): { takes: FefoTake[]; short: number } {
  let left = cents(quantity);
  const takes: FefoTake[] = [];
  for (const b of fefoOrder(batches)) {
    if (left <= 0) break;
    if (b.expiryDate !== null && b.expiryDate < today) continue;
    const take = Math.min(left, cents(b.quantity));
    if (take <= 0) continue;
    takes.push({ batchId: b.batchId, quantity: take / 100 });
    left -= take;
  }
  return { takes, short: Math.max(left, 0) / 100 };
}
