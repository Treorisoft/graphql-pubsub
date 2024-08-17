import { RedisClient } from "./redis";

interface ChannelMessage {
  channel: string
  message_id: string
}

export class MessageTracker {
  private redis: RedisClient;
  maxSize: number
  masterList: ChannelMessage[] = [];
  channelList: Record<string, ChannelMessage[]> = {};

  constructor(redis: RedisClient) {
    this.redis = redis;
    this.maxSize = redis.maxStreamLength;
  }

  getLastId(channels: readonly string[]): string | undefined {
    let last_id: string | undefined = undefined;
    channels.forEach(channel => {
      const list = this.channelList[channel];
      if (!list?.length) {
        return;
      }
      
      const listid = list.at(list.length - 1)?.message_id;
      if (typeof listid !== 'string') {
        return;
      }

      if (!last_id || listid > last_id) {
        last_id = listid;
      }
    });
    return last_id;
  }

  async loadMessages(streamChannel: string) {
    const messageCount = await this.redis.publisher.xlen(streamChannel);
    if (!messageCount) {
      return;
    }

    const messages = await this.redis.publisher.xrevrange(streamChannel, '+', '-', 'COUNT', this.maxSize);

    // reverse the array so it's processed in the correct order
    let left = null, right = null, length = messages.length;
    for (left = 0, right = length - 1; left < right; left++, right--) {
      let tmp = messages[left];
      messages[left] = messages[right];
      messages[right] = tmp;
    }

    for (const [id, [field, message]] of (messages ?? [])) {
      if ((field === 'init' && message === 'listen') || field !== 'channel_msg') {
        continue;
      }

      try {
        const { channel } = JSON.parse(message) as { channel: string };
        this.add(channel, id);
      }
      catch {} // ignore errors
    }
  }

  add(channel: string, message_id: string) {
    while (this.masterList.length >= this.maxSize) {
      this.removeLast();
    }

    let msg: ChannelMessage = { channel, message_id };
    if (!this.channelList[channel]) {
      this.channelList[channel] = [];
    }
    this.channelList[channel].push(msg);
    this.masterList.push(msg);
  }

  removeLast() {
    const msg = this.masterList.shift(); // remove first element
    if (msg) {
      // message _should_ always be the first on in the channel list
      this.channelList[msg.channel].shift();
      if (!this.channelList[msg.channel].length) {
        delete this.channelList[msg.channel];
      }
    }
  }
}