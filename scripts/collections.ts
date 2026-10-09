/** Map and Record helpers the pipeline scripts share. */

/** Append `value` to the array under `key`, creating it on first use; returns that array. */
export function pushTo<T>(map: Map<string, T[]>, key: string, value: T): T[] {
  const values = map.get(key) ?? [];
  values.push(value);
  map.set(key, values);
  return values;
}

/** Add `by` to the count under `key`, starting from zero. */
export function increment(counts: Record<string, number>, key: string, by = 1): void {
  counts[key] = (counts[key] ?? 0) + by;
}

/** {@link increment} for a `Map` of counts. */
export function incrementIn(counts: Map<string, number>, key: string, by = 1): void {
  counts.set(key, (counts.get(key) ?? 0) + by);
}
