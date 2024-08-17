import type { GraphQLResolveInfo } from "graphql";
import { getProxyMethod } from "./utils/getProxyMethod";

export type FilterFn<TSource, TArgs, TContext> = (rootValue: TSource, args: TArgs, context: TContext, info: GraphQLResolveInfo) => boolean | Promise<boolean>;
export type ResolverFn<TResult, TSource, TArgs, TContext> = (rootValue: TSource, args: TArgs, context: TContext, info: GraphQLResolveInfo) => AsyncIterable<TResult> | Promise<AsyncIterable<TResult>>;

export type WithFilter<TResult, TSource, TArgs, TContext> = (
  asyncIteratorFn: ResolverFn<TResult, TSource, TArgs, TContext>,
  filterFn: FilterFn<TSource, TArgs, TContext>
) => ResolverFn<TResult, TSource, TArgs, TContext>;

export function withFilter<TResult, TSource, TArgs, TContext>(
  asyncIteratorFn: ResolverFn<TResult, TSource, TArgs, TContext>,
  filterFn: FilterFn<TResult, TArgs, TContext>
): ResolverFn<TResult, TSource, TArgs, TContext> {
  return async (rootValue: TSource, args: TArgs, context: TContext, info: GraphQLResolveInfo): Promise<AsyncIterable<TResult>> => {
    const asyncIterator = await asyncIteratorFn(rootValue, args, context, info);
    return wrapIterator(asyncIterator, filterFn, args, context, info);
  };
};


function wrapIterator<TResult, TArgs, TContext>(iterator: AsyncIterable<TResult>, filterFn: FilterFn<TResult, TArgs, TContext>, args: TArgs, context: TContext, info: GraphQLResolveInfo) {
  return new Proxy(iterator, {
    get(target, prop, receiver) {
      const existingValue = Reflect.get(target, prop, receiver);
      if (Symbol.asyncIterator === prop) {
        return function iteratorFactory() {
          const nextIterator: AsyncIterable<TResult> = Reflect.apply(existingValue, target, []);
          return wrapIterator(nextIterator, filterFn, args, context, info);
        };
      }
      else if (prop === 'next') {
        return function wrappedNext() {
          return new Promise<IteratorResult<any>>(async (resolve, reject) => {
            const inner = async () => {
              try {
                const payload: IteratorResult<any> = await Reflect.apply(existingValue, target, []);
                if (payload.done) {
                  resolve(payload);
                  return;
                }
  
                try {
                  const filterResult = await filterFn(payload.value, args, context, info);
                  if (filterResult) {
                    resolve(payload);
                    return;
                  }
                }
                catch {} // We ignore errors from filter function, but
                inner();
              }
              catch (err) {
                reject(err);
              }
            };
            inner();
          });
        }
      }
      else if (typeof existingValue === 'function') {
        return getProxyMethod(target, existingValue);
      }
      return existingValue;
    },
  });
}