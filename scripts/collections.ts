/** Map and Record helpers the pipeline scripts share. */

/** Append `value` to the array under `key`, creating it on first use; returns that array. */
export function pushTo<T>(map: Map<string, T[]>, key: string, value: T): T[] {
  const values = map.get(key) ?? [];
  values.push(value);
  map.set(key, values);
  return values;
}
