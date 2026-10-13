/** Test guards that replace non-null assertions: they fail the test loudly instead of letting `undefined` flow on. */
export function assertDefined<T>(value: T): asserts value is NonNullable<T> {
  if (value == null) throw new Error(`Expected a defined value, got ${String(value)}`);
}

export function defined<T>(value: T): NonNullable<T> {
  assertDefined(value);
  return value;
}
