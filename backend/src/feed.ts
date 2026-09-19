import type { FeedItem } from "@swarmup/shared";

/** FeedItem without the log stamp: `seq` and `ts` are assigned by the feed on publish */
type Unstamped<T> = T extends unknown ? Omit<T, "seq" | "ts"> : never;
export type FeedPublication = Unstamped<FeedItem>;

export interface Feed {
  publish(item: FeedPublication): void;
  /** items with `seq > since` (CONTRACT.md: no `since` → full feed) */
  since(since: number): FeedItem[];
  lastSeq(): number;
  /** Clears the previous run's items; the counter stays monotonic so the client-side accumulator keyed by `seq` does not break */
  reset(): void;
}

/**
 * Retention keeps the whole demo in memory: 4-5 min of script is ~15 items, so
 * trimming the queue would break the `since` polling with no upside.
 */
export function createFeed(): Feed {
  const items: FeedItem[] = [];
  let last = 0;
  return {
    publish(item) {
      last += 1;
      items.push({ ...item, seq: last, ts: new Date().toISOString() });
    },
    since(since) {
      return items.filter((item) => item.seq > since);
    },
    lastSeq() {
      return last;
    },
    reset() {
      items.length = 0;
    },
  };
}

/** missing `since` → 0 (whole feed); invalid → null (the route answers 400) */
export function parseSince(raw: unknown): number | null {
  if (raw === undefined) return 0;
  if (typeof raw !== "string" || !/^\d+$/.test(raw)) return null;
  return Number(raw);
}
