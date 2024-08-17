import type { PubSubAsyncIterableIterator } from "../pubsub-async-iterable-iterator";
import type { CancelFn } from "../types";
import { getProxyMethod } from "./getProxyMethod";
import { defaultIteratorReturn } from "./iteratorDefaults";

export function getIteratorCancel<T>(asyncIterator: PubSubAsyncIterableIterator<T>, onCancel: CancelFn<T>) {
  return new Proxy(asyncIterator, {
    has(target, prop) {
      if (prop === 'return') {
        return true;
      }
      return Reflect.has(target, prop);
    },
    get(target, prop, receiver) {
      const existingValue = Reflect.get(target, prop, receiver);
      if (prop === 'return') {
        const existingReturn = existingValue || defaultIteratorReturn;
        return async function returnWithCancel(value?: T) {
          await onCancel?.(value);
          return Reflect.apply(existingReturn, target, [value]);
        }
      }
      else if (typeof existingValue === 'function') {
        return getProxyMethod(target, existingValue);
      }
      return existingValue;
    },
  });
}

export function withCancel<T>(asyncIterator: PubSubAsyncIterableIterator<T>, onCancel: CancelFn<T>): PubSubAsyncIterableIterator<T> {
  return new Proxy(asyncIterator, {
    get(target, prop, receiver) {
      const existingValue = Reflect.get(target, prop, receiver);
      if (Symbol.asyncIterator === prop) {
        return function iteratorFactory() {
          const iterator: PubSubAsyncIterableIterator<T> = Reflect.apply(existingValue, target, []);
          return getIteratorCancel(iterator, onCancel);
        };
      }
      else if (typeof existingValue === 'function') {
        return getProxyMethod(target, existingValue);
      }
      return existingValue;
    },
  })
}