/** Returns the array now stored under `key`. */
export function pushTo<T>(map: Map<string, T[]>, key: string, value: T): T[] {
  const values = map.get(key) ?? [];
  values.push(value);
  map.set(key, values);
  return values;
}

export function increment(counts: Record<string, number>, key: string, by = 1): void {
  counts[key] = (counts[key] ?? 0) + by;
}

export function incrementIn(counts: Map<string, number>, key: string, by = 1): void {
  counts.set(key, (counts.get(key) ?? 0) + by);
}
