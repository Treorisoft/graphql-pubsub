import type { PubSubAsyncIterableIterator } from "../pubsub-async-iterable-iterator";
import type { CancelFn } from "../types";
import { getProxyMethod } from "./getProxyMethod";
import { defaultIteratorReturn } from "./iteratorDefaults";
import { getIteratorCancel } from "./withCancel";

interface IntervalOptions<T> {
  interval?: number // ms
  onCancel?: CancelFn<T>
  perIterator?: boolean
}

const INTERVAL_MAP: Map<string, {
  last_message?: IteratorResult<unknown>,
  id?: NodeJS.Timeout,
  main?: PubSubAsyncIterableIterator<unknown>,
  listeners: Set<PubSubAsyncIterableIterator<any>>
}> = new Map();

function getValueCollector<T>(asyncIterator: PubSubAsyncIterableIterator<T>, cb: (value: IteratorResult<T>) => void) {
  return new Proxy(asyncIterator, {
    has(target, prop) {
      if (prop === 'next') {
        return true;
      }
      return Reflect.has(target, prop);
    },
    get(target, prop, receiver) {
      const existingValue = Reflect.get(target, prop, receiver);
      if (prop === 'next') {
        return async function collectNextValue(): Promise<IteratorResult<T>> {
          let msg: IteratorResult<T> = await Reflect.apply(existingValue, target, []);
          cb(msg);
          return msg;
        }
      }
      else if (typeof existingValue === 'function') {
        return getProxyMethod(target, existingValue);
      }
      return existingValue;
    },
  })
}

function getIteratorInterval<T>(asyncIterator: PubSubAsyncIterableIterator<T>, { interval = 10000, onCancel, perIterator }: IntervalOptions<T> = {}) {
  if (!!perIterator) {
    let intervalId: NodeJS.Timeout;
    let lastResult: IteratorResult<T>;
    const sendNonSharedMessage = () => {
      if (lastResult) {
        asyncIterator.pushValue(lastResult.value);
      }
      intervalId = setTimeout(sendNonSharedMessage, interval);
    };
    intervalId = setTimeout(sendNonSharedMessage, interval);

    return new Proxy(asyncIterator, {
      has(target, prop) {
        if (prop === 'return' || prop === 'next') {
          return true;
        }
        return Reflect.has(target, prop);
      },
      get(target, prop, receiver) {
        const existingValue = Reflect.get(target, prop, receiver);
        if (prop === 'return') {
          const existingReturn = existingValue || defaultIteratorReturn;
          return async function returnWithCancel(value?: T) {
            clearTimeout(intervalId);
            await onCancel?.(value);
            return Reflect.apply(existingReturn, target, [value]);
          }
        }
        else if (prop === 'next') {
          return async function collectNextValue(): Promise<IteratorResult<T>> {
            lastResult = await Reflect.apply(existingValue, target, []);
            return lastResult;
          }
        }
        else if (typeof existingValue === 'function') {
          return getProxyMethod(target, existingValue)
        }
        return existingValue;
      },
    });
  }
  const triggerKey = asyncIterator.uniqueKey();

  // TODO: Make the map key take into account the interval??
  if (!INTERVAL_MAP.has(triggerKey)) {
    INTERVAL_MAP.set(triggerKey, { listeners: new Set() });
  }
  const data = INTERVAL_MAP.get(triggerKey)!;
  data.listeners.add(asyncIterator);

  if (!data.id) {
    data.main = getValueCollector(asyncIterator.clone(), (value) => {
      data.last_message = value;
    });

    (function sendLastMessage() {
      if (data.last_message) {
        data.listeners.forEach(listener => {
          listener.pushValue(data.last_message!.value);
        });
      }
      if (data.main) {
        data.id = setTimeout(sendLastMessage, interval);
      }
    })();

    (async function collectNextValue() {
      do {
        await data.main?.next();
      } while(!!data.main);
    })();
  }

  return getIteratorCancel(asyncIterator, async (value) => {
    data.listeners.delete(asyncIterator);
    if (data.id && !data.listeners.size) {
      // last one was removed... stop the interval
      const collector = data.main;
      data.main = undefined;
      clearTimeout(data.id);
      collector?.return();
      INTERVAL_MAP.delete(triggerKey);
    }
    await onCancel?.(value);
  });
}

export function withInterval<T>(asyncIterator: PubSubAsyncIterableIterator<T>, options: IntervalOptions<T> = {}) {
  return new Proxy(asyncIterator, {
    get(target, prop, receiver) {
      const existingValue = Reflect.get(target, prop, receiver);
      if (Symbol.asyncIterator === prop) {
        return function iteratorFactory() {
          const iterator: PubSubAsyncIterableIterator<T> = Reflect.apply(existingValue, target, []);
          return getIteratorInterval(iterator, options);
        };
      }
      else if (typeof existingValue === 'function') {
        return getProxyMethod(target, existingValue);
      }
      return existingValue;
    },
  });
}