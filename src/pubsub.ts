import { GraphQLResolveInfo } from 'graphql';
import { PubSubAsyncIterableIterator, wrapWithReplay } from './pubsub-async-iterable-iterator';
import { PubSubEngine } from './pubsub-engine';
import type { PubSubConfig, PubSubOptions } from './types';
import { getConfig } from './utils/getConfig';
import { MessageTracker } from './utils/messageTracker';
import type { RedisClient } from './utils/redis';
import { map } from 'bluebird';
import { getLastMessageId } from './utils/lastMessageId';

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
      const { channel, payload } = JSON.parse(message) as {channel: string, payload: any };
      this.messageTracker.add(channel, message_id);
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

  public iteratorWithLast<T>(triggers: string | readonly string[], info: GraphQLResolveInfo, options: LastIteratorOptions = {}): PubSubAsyncIterableIterator<T> {
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
    }
    return iterator;
  }
}

export interface LastIteratorOptions {
  sendLatestOnNew?: boolean
  replayMessages?: boolean
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