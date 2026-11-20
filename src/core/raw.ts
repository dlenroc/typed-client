import type { RequestKindMap } from "./types.js";

// A registered symbol. A raw value from a second copy of the package has the
// same mark.
const rawMark: unique symbol = Symbol.for("@dlenroc/typed-client/raw") as never;

/**
 * A value with its body kind. The kind is `undefined` if the position has no
 * kind.
 */
export type RawPair = readonly [value: unknown, kind: string | undefined];

/** Each body kind of `Map`, other than `none`, paired with its value type. */
export type KindPairs<Map> = {
  [Kind in Exclude<keyof Map & string, "none">]: readonly [Map[Kind], Kind];
}[Exclude<keyof Map & string, "none">];

type CorePairs = KindPairs<RequestKindMap> | readonly [unknown, undefined];

type ValueOf<Pairs extends RawPair, Kind> =
  Pairs extends readonly [infer Value, Kind] ? Value : never;

// The position of a call infers `Pairs` through this type.
type PairOf<Pairs extends RawPair, Kind> = Extract<Pairs, readonly [unknown, Kind]>;

type KindOf<Pairs extends RawPair> = Pairs[1] & string;

// An invalid kind is an error on the argument. Then the result has no second
// error.
type Checked<Pairs extends RawPair, Kind, Type> =
  [KindOf<Pairs>] extends [Kind] ? any : Type;

/**
 * A call value that the client sends as given. The client does not
 * validate it with the schema of its part and does not encode it.
 */
export interface Raw<Pair extends RawPair = RawPair> {
  readonly [rawMark]: Pair;
}

export function isRaw(value: unknown): value is Raw {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as Partial<Raw>)[rawMark])
  );
}

/** The value and the kind of a raw part. */
export function rawParts(value: Raw): RawPair {
  return value[rawMark];
}

/**
 * Mark one part of a call as raw. The position of the call gives the
 * permitted values and kinds.
 */
export function raw<const Value>(value: Value): Raw<readonly [Value, undefined]>;
export function raw<
  Pairs extends RawPair = CorePairs,
  const Kind extends Pairs[1] & string = Pairs[1] & string,
>(
  value: ValueOf<Pairs, Kind>,
  kind: Kind,
): Raw<PairOf<Pairs, Checked<Pairs, Kind, Kind>>>;
export function raw(value: unknown, kind?: string): Raw {
  return Object.freeze({ [rawMark]: Object.freeze([value, kind] as const) });
}
