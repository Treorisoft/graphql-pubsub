import { PubSubEngine } from './pubsub-engine';
import { getProxyMethod } from './utils/getProxyMethod';
import { RedisClient } from './utils/redis';

/**
 * A class for digesting PubSubEngine events via the new AsyncIterator interface.
 * This implementation is a generic version of the AsyncIterator, so any PubSubEngine may
 * be used.
 * @class
 *
 * @constructor
 *
 * @property pullQueue @type {Function[]}
 * A queue of resolve functions waiting for an incoming event which has not yet arrived.
 * This queue expands as next() calls are made without PubSubEngine events occurring in-between.
 *
 * @property pushQueue @type {T[]}
 * A queue of PubSubEngine events waiting for next() calls to be made, which returns the queued events
 * for handling. This queue expands as PubSubEngine events arrive without next() calls occurring in-between.
 *
 * @property eventsArray @type {readonly string[]}
 * An array of PubSubEngine event names that this PubSubAsyncIterator should watch.
 *
 * @property allSubscribed @type {Promise<number[]>}
 * undefined until next() called for the first time, afterwards is a promise of an array of all
 * subscription ids, where each subscription id identified a subscription on the PubSubEngine.
 * The undefined initialization ensures that subscriptions are not made to the PubSubEngine
 * before next() has ever been called.
 *
 * @property running @type {boolean}
 * Whether or not the PubSubAsyncIterator is in running mode (responding to incoming PubSubEngine events and next() calls).
 * running begins as true and turns to false once the return method is called.
 *
 * @property pubsub @type {PubSubEngine}
 * The PubSubEngine whose events will be observed.
 */
export class PubSubAsyncIterableIterator<T> implements AsyncIterableIterator<T> {

  private pullQueue: ((value: IteratorResult<T>) => void)[];
  private pushQueue: T[];
  private eventsArray: readonly string[];
  private allSubscribed: Promise<number[]> | null;
  private running: boolean;
  private pubsub: PubSubEngine;

  constructor(pubsub: PubSubEngine, eventNames: string | readonly string[]) {
    this.pubsub = pubsub;
    this.pullQueue = [];
    this.pushQueue = [];
    this.running = true;
    this.allSubscribed = null;
    this.eventsArray = typeof eventNames === 'string' ? [eventNames] : eventNames;
  }

  public clone() {
    return new PubSubAsyncIterableIterator(this.pubsub, this.eventsArray);
  }

  public uniqueKey(): string {
    return [...this.eventsArray].sort().join('|');
  }

  public async next(): Promise<IteratorResult<T>> {
    if (!this.allSubscribed) { await (this.allSubscribed = this.subscribeAll()); }
    return this.pullValue();
  }

  public async return(value?: T): Promise<IteratorResult<T>> {
    await this.emptyQueue();
    return { value, done: true };
  }

  public async throw(error?: any) {
    await this.emptyQueue();
    return Promise.reject(error);
  }

  public [Symbol.asyncIterator]() {
    return this;
  }

  public async pushValue(event: T) {
    await this.allSubscribed;
    if (this.pullQueue.length !== 0) {
      this.pullQueue.shift()!(this.running
        ? { value: event, done: false }
        : { value: undefined, done: true },
      );
    } else {
      this.pushQueue.push(event);
    }
  }

  private pullValue(): Promise<IteratorResult<T>> {
    return new Promise(
      resolve => {
        if (this.pushQueue.length !== 0) {
          resolve(this.running
            ? { value: this.pushQueue.shift()!, done: false }
            : { value: undefined, done: true },
          );
        } else {
          this.pullQueue.push(resolve);
        }
      },
    );
  }

  private async emptyQueue() {
    if (this.running) {
      this.running = false;
      this.pullQueue.forEach(resolve => resolve({ value: undefined, done: true }));
      this.pullQueue.length = 0;
      this.pushQueue.length = 0;
      const subscriptionIds = await this.allSubscribed;
      if (subscriptionIds) { this.unsubscribeAll(subscriptionIds); }
    }
  }

  private subscribeAll() {
    return Promise.all(this.eventsArray.map(
      eventName => this.pubsub.subscribe(eventName, this.pushValue.bind(this), {}),
    ));
  }

  private unsubscribeAll(subscriptionIds: number[]) {
    for (const subscriptionId of subscriptionIds) {
      this.pubsub.unsubscribe(subscriptionId);
    }
  }
}

interface ReplayOptions {
  redis: RedisClient
  last_id: string | null
  stream_channel: string
}

export function wrapWithReplay<T>(iterator: PubSubAsyncIterableIterator<T>, options: ReplayOptions) {
  return new Proxy(iterator, {
    has(target, p) {
      if (p === 'next') {
        return true;
      }
      return Reflect.has(target, p);
    },
    get(target, p, receiver) {
      const existingValue = Reflect.get(target, p, receiver);
      if (Symbol.asyncIterator === p) {
        return function iteratorFactory() {
          const theIterator: PubSubAsyncIterableIterator<T> = Reflect.apply(existingValue, target, []);
          return wrapWithReplay(theIterator, options);
        }
      }
      else if (p === 'next' && options.last_id) {
        return async function replayNext(): Promise<IteratorResult<T>> {
          let result: IteratorResult<T> | undefined;
          const message = await options.redis.query(options.stream_channel, options.last_id!);
          if (message) {
            const { payload } = JSON.parse(message) as { payload: any };
            result = {
              done: false,
              value: Object.assign(payload, {
                extensions: { message_id: options.last_id }
              })
            };
          }
          options.last_id = null;
          if (result) {
            return result;
          }
          return Reflect.apply(existingValue, target, []);
        }
      }
      else if (typeof existingValue === 'function') {
        return getProxyMethod(target, existingValue);
      }
      return existingValue;
    },
  });
}