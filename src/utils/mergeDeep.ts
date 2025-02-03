function isObject(obj: unknown): obj is Record<string, unknown> {
  return !!obj && typeof obj === 'object';
}

export function mergeDeep<T, S>(target: T, source: S): DeepMerge<T, S> {
  const result: any = structuredClone(target);

  if (!isObject(target) || !isObject(source)) {
    return structuredClone(source) as DeepMerge<T, S>;
  }

  Object.keys(source).forEach(key => {
    const targetValue = target[key];
    const sourceValue = source[key];

    if (Array.isArray(targetValue) && Array.isArray(sourceValue)) {
      result[key] = targetValue.map((x, i) => {
        return sourceValue.length <= i ? structuredClone(x) : mergeDeep(x, sourceValue[i]);
      });

      if (sourceValue.length > targetValue.length) {
        result[key] = result[key].concat(structuredClone(sourceValue.slice(targetValue.length)));
      }
    }
    else if (isObject(targetValue) && isObject(sourceValue)) {
      result[key] = mergeDeep(targetValue, sourceValue);
    } else {
      result[key] = structuredClone(sourceValue);
    }
  });

  return result;
}

/**
 * Types from: https://dev.to/svehla/typescript-how-to-deep-merge-170c
 */
type Head<T> = T extends [infer I, ...infer _Rest] ? I : never
type Tail<T> = T extends [infer _I, ...infer Rest] ? Rest : never

type Zip_DeepMergeTwoTypes<T, U> = T extends []
  ? U
  : U extends []
  ? T
  : [
      DeepMerge<Head<T>, Head<U>>,
      ...Zip_DeepMergeTwoTypes<Tail<T>, Tail<U>>
  ]

type GetObjDifferentKeys<
  T,
  U,
  T0 = Omit<T, keyof U> & Omit<U, keyof T>,
  T1 = { [K in keyof T0]: T0[K] }
 > = T1

type GetObjSameKeys<T, U> = Omit<T | U, keyof GetObjDifferentKeys<T, U>>

type MergeTwoObjects<
  T,
  U, 
  T0 = Partial<GetObjDifferentKeys<T, U>>
  & {[K in keyof GetObjSameKeys<T, U>]: DeepMerge<T[K], U[K]>},
  T1 = { [K in keyof T0]: T0[K] }
> = T1

export type DeepMerge<T, U> =
  [T, U] extends [any[], any[]]
    ? Zip_DeepMergeTwoTypes<T, U>
    : [T, U] extends [{ [key: string]: unknown}, { [key: string]: unknown } ]
      ? MergeTwoObjects<T, U>
      : T | U