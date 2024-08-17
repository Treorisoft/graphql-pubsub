import type { PubSubConfig, PubSubOptions } from '../types';
import { RedisClient } from './redis';

const DEFAULT_OPTIONS: Required<PubSubOptions> = {
  redis: {
    port: 6379,
    host: '127.0.0.1',
    db: 0,
  },
  stream_channel: 'gql_pubsub',
  stream_timeout: 1000, // 1s
  concurrency: 5,
  maxStreamLength: 5000,
};

export function getConfig(options?: PubSubOptions): PubSubConfig {
  const redisOpt = options?.redis || DEFAULT_OPTIONS.redis;

  const config: PubSubConfig = {
    ...DEFAULT_OPTIONS,
    ...options,
    redis: new RedisClient(
      redisOpt,
      {
        stream_timeout: options?.stream_timeout || DEFAULT_OPTIONS.stream_timeout,
        concurrency: options?.concurrency || DEFAULT_OPTIONS.concurrency,
        maxStreamLength: options?.maxStreamLength || DEFAULT_OPTIONS.maxStreamLength,
      }
    ),
  };
  
  return config;
}