import { Redis, RedisOptions } from 'ioredis';
import { map } from 'bluebird';
import { RedisClientOptions } from '../types';
import { randomUUID } from 'node:crypto';

type RedisHandler = (id: string, message: string) => void | Promise<void>;
interface StreamListener<T = unknown> {
  id?: string
  channel: string
  handlers: Set<RedisHandler>
  listening: boolean
  promiseFor?: Promise<T | string>
  promiseListeners: number
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

      const subscribers = Array.from(this.listeners.values()).filter(l => !!l.handlers.size);
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
    catch (err) {
      console.error('Error in stream listener:', err);
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

  async listenFor<T = unknown>(channel: string, timeout: number): Promise<T>;
  async listenFor<T = unknown>(channel: string, timeout: number, parseResult: false): Promise<string>;
  async listenFor<T = unknown>(channel: string, timeout: number, parseResult: true): Promise<T>;
  async listenFor<T = unknown>(channel: string, timeout: number, parseResult: boolean = true): Promise<T> {
    // by default no id means only listen for _new_ messages, since this stream is likely only ever to receive
    // 1 message - initialize the `id` to 0 to start reading the stream from the beginning, so that we can get the last message if it exists
    const listener = (this.listeners.get(channel) ?? { id: 0, channel, handlers: new Set(), listening: false, promiseListeners: 0 }) as StreamListener<T>;

    listener.promiseListeners++;
    if (!listener.promiseFor) {
      listener.promiseFor = new Promise<T | string>((resolve, reject) => {
        const onMsg = async (_id: string, message: string) => {
          if (!parseResult) {
            resolve(message);
          }
          else {
            try {
              const parsed = JSON.parse(message) as ({ok: true, value: T} | {ok: false, error: string});
              if (parsed.ok) {
                resolve(parsed.value);
              }
              else {
                reject(new Error(parsed.error));
              }
            }
            catch (err) {
              reject(err);
            }
          }
          listener.handlers.delete(onMsg);
          listener.promiseFor = undefined;
          this.listeners.delete(channel);
        };
        listener.handlers.add(onMsg);
      });
      this.listeners.set(channel, listener);
    }

    let timeoutTimer: NodeJS.Timeout | null = null;
    try {
      const result = await Promise.race([
        listener.promiseFor,
        new Promise((_, reject) => {
          timeoutTimer = setTimeout(() => reject(new Error(`Timeout waiting for message on channel ${channel}`)), timeout)
        })
      ]);
      return result as T;
    }
    finally {
      if (timeoutTimer != null) {
        clearTimeout(timeoutTimer);
      }
      listener.promiseListeners--;
      if (!listener.promiseListeners) {
        listener.promiseFor = undefined;
        listener.handlers.clear();
        this.listeners.delete(channel);
      }
    }
  }

  async listen(channel: string, handler: RedisHandler): Promise<void> {
    const listener = this.listeners.get(channel) ?? { channel, handlers: new Set(), listening: false, promiseListeners: 0 };
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

  async broadcast(channel: string, message: string): Promise<string> {
    const args = ['MAXLEN', '~', this.config.maxStreamLength];
    const id = await this.publisher.xadd(channel, ...args, /* id */ '*', /* field */ 'channel_msg', /* value */ message) as string;
    return id;
  }

  async replaceBroadcast(channel: string, message_id: string, message: string) {
    const args = ['MAXLEN', '~', this.config.maxStreamLength];
    return new Promise<void>((resolve, reject) => {
      this.publisher.multi()
        .xdel(channel, message_id)
        .xadd(channel, ...args, /* id */ '*', /* field */ 'channel_msg', /* value */ message)
        .exec((err, _results) => {
          if (err) {
            return reject(err);
          }
          resolve();
        });
    });
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

  async joinInFlight<T extends JSONValue>({ key, callback, timeout, firstRunnerCallback }: JoinInFlightOptions<T>): Promise<InFlightResponse<T>> {
    const cacheKey = `inflight:${key}`;
    const instanceId = randomUUID();
    let result: T | null = null;
    try {
      const abortSignal = AbortSignal.timeout(timeout);
      const runnerId = (await this.publisher.set(cacheKey, instanceId, 'PX', timeout, 'NX', 'GET')) ?? instanceId;
      const streamKey = `${cacheKey}:${runnerId}:result`;
      if (runnerId === instanceId) {
        // we are the first to set the value, so we can run the callback and set the result
        try {
          let callbackResult = await callback(abortSignal);
          if (typeof firstRunnerCallback === 'function') {
            callbackResult = await firstRunnerCallback(callbackResult);
          }
          const serializedResult = JSON.stringify({ ok: true, value: callbackResult });
          const parsedResult = JSON.parse(serializedResult) as { ok: true, value: T };
          result = parsedResult.value;
          await this.broadcast(streamKey, serializedResult);
        }
        catch (err) {
          await this.broadcast(streamKey, JSON.stringify({ok: false, error: err instanceof Error ? err.message : String(err)}));
          throw err;
        }
        finally {
          await this.publisher.pexpire(streamKey, timeout * 2); // double the timeout for the result stream to ensure that all listeners can get the result
        }
      }
      else {
        // wait for the existing value to be set and return it
        result = await this.listenFor<T>(streamKey, timeout * 2, true);
      }

      return { result: result as T, wasFirst: runnerId === instanceId };
    }
    catch (err) {
      throw err;
    }
  }
}

export type InFlightCallback<T extends JSONValue> = (signal: AbortSignal) => T | Promise<T>;
type JSONPrimitive = string | number | boolean | null | undefined;
export type JSONValue = JSONPrimitive | JSONValue[] | { toJSON: () => any } | { [key: string]: JSONValue };
export type JSONObject = { toJSON: () => any } | { [key: string]: JSONValue };
export interface JoinInFlightOptions<T extends JSONValue> {
  key: string
  callback: InFlightCallback<T>
  timeout: number // in milliseconds
  firstRunnerCallback?: (result: T) => Promise<T>
}

export interface InFlightResponse<T extends JSONValue> {
  result: T
  wasFirst: boolean
}