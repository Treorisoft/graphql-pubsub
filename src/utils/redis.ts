import { Redis, RedisOptions } from 'ioredis';
import { map } from 'bluebird';
import { RedisClientOptions } from '../types';

type RedisHandler = (id: string, message: string) => void | Promise<void>;
interface StreamListener {
  id?: string
  channel: string
  handlers: Set<RedisHandler>
  listening: boolean
}

const QUERY_CACHE: Map<string, Promise<string | null>> = new Map();

export class RedisClient {
  private config: RedisClientOptions;
  private options: RedisOptions;
  private onStreamListenTimeout: NodeJS.Timeout | null = null;
  private disconnected: boolean = false;
  private clients: { stream?: Redis, publisher?: Redis } = {};
  private listeners: Map<string, StreamListener> = new Map();

  constructor(options: RedisOptions, config: RedisClientOptions) {
    this.config = structuredClone(config);
    this.options = structuredClone(options);
    if (this.options.keyPrefix) {
      // if keyprefix doesn't end with a `:` ensure that it does
      this.options.keyPrefix = this.options.keyPrefix.replace(/:$/g, '') + ':';
    }

    this.onStreamListenTimeout = setTimeout(this.streamListener.bind(this), this.config.stream_timeout);
  }

  get maxStreamLength() {
    return this.config.maxStreamLength;
  }
  
  get stream(): Redis {
    if (!this.clients.stream) {
      this.clients.stream = new Redis(this.options);
    }
    return this.clients.stream;
  }

  get publisher(): Redis {
    if (!this.clients.publisher) {
      this.clients.publisher = new Redis(this.options);
    }
    return this.clients.publisher;
  }

  private clearStreamListenerTimeout() {
    if (this.onStreamListenTimeout) {
      clearTimeout(this.onStreamListenTimeout);
      this.onStreamListenTimeout = null;
    }
  }

  private async streamListener() {
    try {
      this.clearStreamListenerTimeout();
      if (!this.listeners.size) {
        return;
      }

      const subscribers = Array.from(this.listeners.values());
      const channels = subscribers.map(s => s.channel);
      const ids = subscribers.map(s => s.id ?? '$');

      const results = await this.stream.xread('BLOCK', this.config.stream_timeout, 'STREAMS', ...channels, ...ids);
      subscribers.forEach(s => s.listening = true);

      for (const result of (results ?? [])) {
        const channel = result[0].slice(this.options.keyPrefix?.length ?? 0);
        const listener = this.listeners.get(channel);

        if (!listener) continue;
        for (const [id, [field, message]] of result[1]) {
          listener.id = id;
          if ((field === 'init' && message === 'listen') || field !== 'channel_msg') {
            continue;
          }

          await map(listener.handlers, handler => handler(id, message), { concurrency: this.config.concurrency });
        }
      }
    }
    finally {
      if (!this.disconnected) {
        this.onStreamListenTimeout = setTimeout(this.streamListener.bind(this), 50);
      }
    }
  }

  disconnect(reconnect?: boolean) {
    if (!reconnect) {
      this.clearStreamListenerTimeout();
      this.disconnected = true;
    }
    if (this.clients.stream) {
      this.clients.stream.disconnect(reconnect);
    }
    if (this.clients.publisher) {
      this.clients.publisher.disconnect(reconnect);
    }
  }

  async listen(channel: string, handler: RedisHandler): Promise<void> {
    const listener = this.listeners.get(channel) ?? { channel, handlers: new Set(), listening: false };
    listener.handlers.add(handler);

    if (!listener.listening) {
      listener.id = (await this.publisher.xadd(channel, /* id */ '*',  /* field */ 'init', /* value */ 'listen'))!;
    }
    this.listeners.set(channel, listener);
  }

  unlisten(channel: string, handler?: RedisHandler): void {
    const listener = this.listeners.get(channel);
    if (!listener) {
      return;
    }

    if (handler) {
      listener.handlers.delete(handler);
    } else {
      listener.handlers.clear();
    }

    if (!listener.handlers.size) {
      this.listeners.delete(channel);
    } else {
      this.listeners.set(channel, listener);
    }
  }

  async broadcast(channel: string, message: string) {
    const args = ['MAXLEN', '~', this.config.maxStreamLength];
    await this.publisher.xadd(channel, ...args, /* id */ '*', /* field */ 'channel_msg', /* value */ message);
  }

  async query(channel: string, id: string) {
    const cacheKey = `${channel}:${id}`;
    let result = QUERY_CACHE.get(cacheKey);
    if (typeof result !== 'undefined') {
      return result;
    }

    result = new Promise<string | null>(async (resolve, reject) => {
      try {
        let queryResult = await this._query(channel, id);
        resolve(queryResult);
      }
      catch(err) { reject(err); }
      finally { QUERY_CACHE.delete(cacheKey); }
    });

    QUERY_CACHE.set(cacheKey, result);
    return result;
  }

  private async _query(channel: string, id: string) {
    const result = await this.publisher.xrange(channel, id, id);

    if (result?.length) {
      const [_, [field, message]] = result[0];

      if (field === 'channel_msg') {
        return message;
      }
    }
    return null;
  }
}