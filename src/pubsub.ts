import { GraphQLResolveInfo } from 'graphql';
import { PubSubAsyncIterableIterator, wrapWithReplay } from './pubsub-async-iterable-iterator';
import { PubSubEngine } from './pubsub-engine';
import type { DeepPartial, PatchOptions, PubSubConfig, PubSubOptions } from './types';
import { getConfig } from './utils/getConfig';
import { MessageTracker } from './utils/messageTracker';
import type { JSONValue, RedisClient } from './utils/redis';
import { map } from 'bluebird';
import { getLastMessageId } from './utils/lastMessageId';
import { mergeDeep } from './utils/mergeDeep';

export type SubscriptionHandler = (...args: any[]) => void;

export interface BasePayload {
  extensions: { [k: string]: unknown }
}

export class PubSub<
  Events extends { [event: string]: unknown } = Record<string, never>
> extends PubSubEngine {

  private subscriptions: Map<string, Map<number, SubscriptionHandler>> = new Map();
  private subToChannelMap: Map<number, string> = new Map();
  private subIdCounter: number;
  private primeChannelResolvers: Map<string, (value: void | PromiseLike<void>) => void> = new Map();

  private config: PubSubConfig;
  private redis: RedisClient;

  private messageTracker: MessageTracker

  constructor(options?: PubSubOptions) {
    super();

    this.config = getConfig(options);
    this.redis = this.config.redis;
    
    this.subIdCounter = 0;
    
    this.messageTracker = new MessageTracker(this.redis);
    this.messageTracker.loadMessages(this.config.stream_channel);
    this.redis.listen(
      this.config.stream_channel,
      this.onMessage.bind(this)
    );
  }

  getNextId(): number {
    let id = this.subIdCounter;
    let attempts = 0;
    do {
      if (id === Number.MAX_SAFE_INTEGER) {
        id = 0;
      }
      id++; attempts++;
    } while (this.subToChannelMap.has(id) && attempts < 500);

    if (this.subToChannelMap.has(id)) {
      throw new Error('Unable to get an unused subscription id');
    }

    return this.subIdCounter = id;
  }

  async onMessage(message_id: string, message: string) {
    try {
      const { channel, payload, silent } = JSON.parse(message) as {channel: string, payload: any, silent?: boolean };
      this.messageTracker.add(channel, message_id);
      if (silent) {
        // If the message is silent, we don't want to notify subscribers
        const resolver = this.primeChannelResolvers.get(channel);
        if (resolver) {
          resolver();
          this.primeChannelResolvers.delete(channel);
        }
        return;
      }
      this.publish(channel, Object.assign(payload, {
        extensions: { message_id }
      }), false);
    }
    catch { /* noop */ }
  }

  async publish<K extends keyof Events>(
    triggerName: K & string,
    payload: Events[K] extends never ? any : Events[K],
    global: boolean = true,
  ): Promise<void> {
    if (global) {
      await this.redis.broadcast(
        this.config.stream_channel,
        JSON.stringify({ channel: triggerName, payload })
      );
    }
    else {
      const handlers = this.subscriptions.get(triggerName)?.values();
      if (handlers) {
        await map(handlers, handler => handler.call(this, payload), { concurrency: this.config.concurrency });
      }
    }
  }

  /**
   * @deprecated Use `iteratorWithLast` instead, with the `sendLatestOnNew` callback option to get the latest message if needed.
   */
  async primeChannelData<K extends keyof Events>(
    triggerName: K & string,
    initializer: () => Promise<Events[K] extends never ? any : Events[K]>
  ): Promise<void> {
    process.emitWarning(
      'PubSub.primeChannelData is deprecated. Use PubSub.iteratorWithLast with the sendLatestOnNew callback option instead.',
      'DeprecationWarning',
      'DEPRECATION_PUBSUB_PRIME_CHANNEL_DATA'
    );
    if (!!this.messageTracker.getLastId([triggerName])) {
      return Promise.resolve();
    }

    const primeCompleted = new Promise<void>((resolver) => { this.primeChannelResolvers.set(triggerName, resolver); });
    const payload = await initializer();
    await this.redis.broadcast(
      this.config.stream_channel,
      JSON.stringify({ channel: triggerName, payload, silent: true })
    );
    await primeCompleted;
  }

  /**
   * Patches the most recently published data sent to a trigger.
   * 
   * By necessesity of using the last data, "global" is required
   */
  async patch<K extends keyof Events>(
    triggerName: K & string,
    payload: Events[K] extends never ? any : DeepPartial<Events[K]>,
    getFirstData: (
      triggerName: K & string,
      payload: Events[K] extends never ? any : DeepPartial<Events[K]>
    ) => Promise<Events[K] extends never ? any : Events[K]>,
    options?: PatchOptions<Events, K>
  ): Promise<void> {
    let lastId = this.messageTracker.getLastId([triggerName]);
    let lastData, foundRedisData = false;

    if (lastId) {
      const message = await this.redis.query(this.config.stream_channel, lastId);
      if (message) {
        const { payload } = JSON.parse(message) as { payload: any };
        lastData = payload;
        foundRedisData = true;
      }
    }

    if (!lastData) {
      lastData = await getFirstData(triggerName, payload);
    }

    let newData = typeof options?.customPatch === 'function'
      ? options.customPatch(lastData, payload)
      : mergeDeep(lastData, payload);

    if (lastId && foundRedisData && !options?.preserveLastMessage) {
      const removed = this.messageTracker.remove(triggerName, lastId);
      try {
        await this.redis.replaceBroadcast(
          this.config.stream_channel,
          lastId,
          JSON.stringify({ channel: triggerName, payload: newData })
        );
      }
      catch (err) {
        if (removed) {
          this.messageTracker.restore(removed);
        }
        throw err;
      }
    } else {
      await this.redis.broadcast(
        this.config.stream_channel,
        JSON.stringify({ channel: triggerName, payload: newData })
      );
    }
  }

  async subscribe<K extends keyof Events>(triggerName: K & string, onMessage: SubscriptionHandler): Promise<number> {
    const channelSubcriptions = this.subscriptions.get(triggerName) ?? new Map<number, SubscriptionHandler>();
    const existing = getMapKey(channelSubcriptions, onMessage);
    if (!!existing) {
      return existing;
    }

    const id = this.getNextId();
    channelSubcriptions.set(id, onMessage);
    if (!this.subscriptions.has(triggerName)) {
      this.subscriptions.set(triggerName, channelSubcriptions);
    }
    this.subToChannelMap.set(id, triggerName);
    return id;
  }

  async unsubscribe(id: number): Promise<void> {
    const channel = this.subToChannelMap.get(id);
    if (!channel) {
      return;
    }

    const subscribers = this.subscriptions.get(channel);
    if (subscribers) {
      subscribers.delete(id);
      if (!subscribers.size) {
        this.subscriptions.delete(channel);
      }
    }
    this.subToChannelMap.delete(id);
  }

  public iteratorWithLast<T extends JSONValue>(triggers: string | readonly string[], info: GraphQLResolveInfo, options: LastIteratorOptions<T> = {}): PubSubAsyncIterableIterator<T> {
    const iterator = new PubSubAsyncIterableIterator<T>(this, triggers);
    const lastMessageId = getLastMessageId(info);
    if (lastMessageId || options.sendLatestOnNew) {
      const allTriggers = typeof triggers === 'string' ? [triggers] : triggers;
      const maybeNewerId = this.messageTracker.getLastId(allTriggers);
      if (!!maybeNewerId && ((!lastMessageId && options.sendLatestOnNew) || (!!lastMessageId && maybeNewerId > lastMessageId))) {
        let replay_ids: string[] | undefined = undefined;
        if (!!lastMessageId && options.replayMessages) {
          replay_ids = this.messageTracker.getIdsAfter(allTriggers, lastMessageId);
        }
        return wrapWithReplay(iterator, {
          redis: this.redis,
          stream_channel: this.config.stream_channel,
          replay_ids: replay_ids?.length ? replay_ids : [maybeNewerId],
        });
      }
      else if (!maybeNewerId && typeof options.sendLatestOnNew === 'object' && typeof options.sendLatestOnNew.callback === 'function') {
        const triggerName = options.sendLatestOnNew.triggerName ?? (typeof triggers === 'string' ? triggers : triggers[0]);
        this.redis.joinInFlight({
          key: `pubsub:sendLatestOnNew:${triggerName}`,
          timeout: options.sendLatestOnNew.timeout ?? 30_000, // 30s default timeout
          callback: options.sendLatestOnNew.callback
        })
        .then(result => {
          if (result.wasFirst) {
            // prime the channel with the latest message, so that any other subscribers will get it as well
            this.redis.broadcast(
              this.config.stream_channel,
              JSON.stringify({ channel: triggerName, payload: result.result, silent: true })
            );
          }
          // also push the latest message to this iterator, so that the subscriber will get it immediately
          iterator.pushValue(result.result);
        })
        .catch(err => {
          console.error('Error in sendLatestOnNew callback:', err);
        });
      }
    }
    return iterator;
  }

  public async getLastMessage(triggers: string | readonly string[]) {
    const allTriggers = typeof triggers === 'string' ? [triggers] : triggers;
    const lastMessageId = this.messageTracker.getLastId(allTriggers);
    if (!lastMessageId) {
      return undefined;
    }

    try {
      const message = await this.redis.query(this.config.stream_channel, lastMessageId);
      if (message) {
        const { payload } = JSON.parse(message) as { payload: any };
        return Object.assign(payload, {
          extensions: { message_id: lastMessageId }
        });
      }
    }
    catch {
      // either errored because the message couldn't be retrieved, or unable to parse
      // in either case, just handle it silently and return undefined
      return undefined;
    }
  }
}

export interface LastIteratorOptions<T extends JSONValue> {
  sendLatestOnNew?: boolean | LatestMessageOptions<T>
  replayMessages?: boolean
}

interface LatestMessageOptions<T extends JSONValue> {
  callback: (signal: AbortSignal) => T | Promise<T> // considered ability to extend timeout, but other waiting subscribers will also be waiting, and wouldn't be able to extend their timeout
  timeout?: number
  triggerName?: string
}

type MapKey<T> = T extends Map<infer K, unknown> ? K : never;
type MapValue<T> = T extends Map<unknown, infer V> ? V : never;

function getMapKey<T extends Map<unknown, unknown>>(jsMap: T, search: MapValue<T>): undefined | MapKey<T> {
  for (const [key, value] of jsMap) {
    if (value === search) {
      return key as MapKey<T>;
    }
  }
  return undefined;
}