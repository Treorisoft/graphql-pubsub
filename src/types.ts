import type { RedisOptions } from 'ioredis';
import type { RedisClient } from './utils/redis';

export interface PubSubOptions {
  redis: RedisOptions
  stream_channel?: string
  stream_timeout?: number
  concurrency?: number
  maxStreamLength?: number
}

export interface PubSubConfig {
  redis: RedisClient
  stream_channel: string
  concurrency: number
}

export interface RedisClientOptions {
  stream_timeout: number
  concurrency: number
  maxStreamLength: number
}

export type CancelFn<T> = (value?: T) => void | Promise<void>