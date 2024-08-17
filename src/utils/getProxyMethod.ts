function memoize<F extends (a1: any, a2: any) => any>(fn: F): F {
  const masterCache: WeakMap<
    Record<string, any>,
    WeakMap<Record<string, any>, any>
  > = new WeakMap();
  
  return function memoized(a1: any, a2: any): any {
    let cache = masterCache.get(a1);
    if (!cache) {
      cache = new WeakMap();
      masterCache.set(a1, cache);
    }

    let value = cache.get(a2);
    if (value === undefined) {
      value = fn(a1, a2);
      cache.set(a2, value);
    }
    return value;
  } as F;
}

export const getProxyMethod = memoize(function getProxyMethod<T, TMethod extends T[keyof T] & ((...args: any[]) => any)>(target: T, targetMethod: TMethod) {
  return function proxyMethod(...args: Parameters<TMethod>) {
    return Reflect.apply(targetMethod, target, args);
  };
});