export function pushTo<T>(map: Map<string, T[]>, key: string, value: T): T[] {
  const values = map.get(key) ?? [];
  values.push(value);
  map.set(key, values);
  return values;
}

export function getOrThrow<K, V>(map: ReadonlyMap<K, V>, key: K): V {
  const value = map.get(key);
  if (value === undefined) throw new Error(`No entry for key ${String(key)}`);
  return value;
}

export function increment(counts: Record<string, number>, key: string, by = 1): void {
  counts[key] = (counts[key] ?? 0) + by;
}

export function incrementIn(counts: Map<string, number>, key: string, by = 1): void {
  counts.set(key, (counts.get(key) ?? 0) + by);
}
