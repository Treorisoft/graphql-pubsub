# @treorisoft/graphql-pubsub

This library started off as mostly a clone of https://github.com/apollographql/graphql-subscriptions.

The underlying iterable wasn't able to be modified for the necessary features this library was trying to make available.

This re-implements the `withFilter`, while also providing some additional features, like a `withCancel` (an unsubscribe event), a `withInterval` to periodically repeat the last message sent over a subscription (in case of missed messages), and an `iteratorWithLast` feature to allow the client to supply the last id received, and for the server to respond to reconnects with missed messages.

This uses `ioredis` for scalability, and uses redis streams and the message ids that redis generates for streams in order to work.

## Setup

### Client Setup

Client setup is only necessary if you want to use the `iteratorWithLast` reconnect feature.

You simply need to create a new `ApolloLink` to add to the subscription websocket chain.

```ts
import { LastMessageLink } from '@treorisoft/graphql-pubsub/lib/client';
import { from } from '@apollo/client';

const subscriptionIdLink = new ApolloLink(LastMessageLink);
const wsChain = from([
  subscriptionIdLink,
  wsLink // a GraphQLWsLink instance
]);
```

### Server Setup

Setup has two parts - decorating the websocket server, and setting up the `PubSub`.

First in the spot you would use `useServer` from `graphq-ws/lib/use/ws` instead of this:

```ts
useServer({ schema }, wsServer);
```

You would wrap the options in a call to `serverOptions`:

```ts
import { serverOptions } from '@treorisoft/graphql-pubsub';
useServer(serverOptions({
  schema,
}), wsServer);
```

Next you need to setup your `PubSub` instance you would attach all the subscriptions and publishes to.

```ts
import { PubSub } from '@treorisoft/graphql-pubsub';

export const pubsub = new PubSub({
  redis: {
    port: 6379,
    host: '127.0.0.1',
    username: 'default',
    password: 'super-secret-pwd',
    db: 0,
  }
});
```

## Usage

### publish

Publishes data to the redis stream to be distributed to all listener and all subscribers.

It takes 2 parameters with an optional 3rd.  The first the trigger/channel to publish to. The second parameter is the payload to send.  The third alters the behavior.  When `false` it skips sending the payload to redis, and just immediately publish the payload to the connected subscribes of the single instance.  `true` is the default.

Example:
```ts
const SOMETHING_CHANGED_TOPIC = 'something_changed';
const pubsub = new PubSub({
  redis: { /* your redis config */ }
});

pubsub.publish(SOMETHING_CHANGED_TOPIC, {
  somethingChanged: { /* match your schema */ }
});
```

### patch

Publishes data to the redis stream - but patches the last data sent.  Since it relies on the redis stream, patching is always considered a global publish.

It takes 3 parameters with an optional 4th.  The first the trigger/channel to publish to.  The second is a partial payload to be merged with the most recent data.  The third is a generator function.  In the abscense initial data, the generator function is called, and the payload will be merged with the result. The fourth parameter is extra options.

By default, the merge is a deep merge - which merges same indexed elements of an array.

Options:
- `customPatch`: An optional function that can be used to provide custom patching when the default is not enough.  It receives both the inital data and the payload.
- `preserveLastMessage`: By default a patch will remove the old message while adding the new message. This `boolean` allows you to preserve the original message in the redis stream.

Example:
```ts
const SOMETHING_CHANGED_TOPIC = 'something_changed';
const pubsub = new PubSub({
  redis: { /* your redis config */ }
});

pubsub.patch(SOMETHING_CHANGED_TOPIC, {
  somethingChanged: { /* match your schema */ }
}, async (triggerName, payload) => {
  const data = await db.query('SELECT DATA');
  return data;
});
```

### withFilter

Returns a graphql field resolver function that will filter data to be sent over the subscription.

It takes 2 parameters, the first the iterator function that receives the resolver parameters and should return the iterator.  The second parameter is a filter function that also receives the resolver parameters, but with the payload to be sent as the `root` value.

Example:
```ts
import { withFilter } from '@treorisoft/graphql-pubsub';

const SOMETHING_CHANGED_TOPIC = 'something_changed';

export const resolvers = {
  Subscription: {
    somethingChanged: {
      subscribe: withFilter(() => pubsub.asyncIterator(SOMETHING_CHANGED_TOPIC), (payload, variables) => {
        return payload.somethingChanged.id === variables.relevantId;
      }),
    },
  },
}
```

### withCancel

Returns the iterator given to it giving it a callback function for when the subscription ends to be called.  Takes 2 parameters, the iterator - and the callback function.

Example:
```ts
import { withCancel } from '@treorisoft/graphql-pubsub';
const TimeResolver = {
  Subscription: {
    time: {
      subscribe: (_, {}, context, info) => {
        return withCancel(pubsub.asyncIterableIterator('ON_TIME'), () => {
          console.log('Unsubscribed...!');
        });
      }
    }
  }
};
```

### withInterval

This helps repeat messages in case a flaky websocket connection misses a message. It takes 2 parameters, the iterator and an options object.

Options are:
- `interval`: Optional number in milliseconds - default is `10,000`
- `onCancel`: Optional callback function - shortcut to provide `withCancel` functionality without multiple wrappers
- `perIterator`: Optional - default `false`. Defines how the interval should behave. When `false` a common interval is used for ALL socket connections on the same interator channel. When `true` each socket iterator has it's own interval and may come at a performance cost (depending on how many connections there are).

Example:
```ts
import { withInterval } from '@treorisoft/graphql-pubsub';
const UserResolver = {
  Subscription: {
    userUpdated: {
      subscribe: (_, { user_id }, ctx, info) => {
        return withInterval(pubsub.asyncIterableIterator('USER_UPDATED:' + user_id), {
          interval: 60000,
          onCancel: () => { console.log('Unsubscribed...!'); },
          // perIterator: true
        });
      }
    }
  }
}
```

### iteratorWithLast

This works with the client setup and helps provide the latest data to the client upon reconnect.

The basic concept is that a `message_id` is sent with every publish and the client side will keep track of the last id it received. When the connection is interrupted and it reconnects and re-establishes the subscription it passes that id back to the server. This function will read that and compare with the latest id actually available, and immediately send back to the client any messages it might have missed while disconnected.

This function takes 3 parameters, first the channel(s) to subscribe to, second the `info` object provided by the graphql resolver, and third an optional `options` parameter the defines how the send on resubscribe works.

Options are:
- `sendLatestOnNew`: Optional boolean | object, defaults to `false`. When `true` during the subscribe, if no last id was past up (new subscription) then just immediately send the latest message.
- `replayMessages`: Optional boolean, defaults to `false`. When `true` upon re-subscribe, it will replay all messages between the last id passed and the latest one. This good for scenarios where the messages are compounded on each other - like chat messages.

Example:
```ts
const UserResolver = {
  Subscription: {
    userUpdated: {
      subscribe: (_, { user_id }, ctx, info) => {
        return pubsub.iteratorWithLast('USER_UPDATED:' + user_id, info, {
          sendLatestOnNew: true,
          replayMessages: true,
        });
      }
    }
  }
}
```

When `sendLatestOnNew` options is an `object` it is meant for priming the channel data so there is always a something new to send. It takes a `callback` and optional `timeout` (default `30s`) and `triggerName` (defaults to first channel to susbscribe to).

The callback uses redis to ensure the same channel only has 1 in-flight priming callback running at a time.

Once the channel has been primed from the callback the next subscriptions won't have to prime and callback won't be fired.

```ts
const UserResolver = {
  Subscription: {
    userUpdated: {
      subscribe: (_, { user_id }, ctx, info) => {
        return pubsub.iteratorWithLast('USER_UPDATED:' + user_id, info, {
          sendLatestOnNew: {
            // signal is AbortSignal.timeout(theTimeout)
            callback: (signal) => {

              // query language is NOT real
              const dbUser = db.query('get user from db user table where user_id = ?', user_id);
              return { userUpdated: dbUser };
            },
            timeout: 60_000,
            triggerName: 'USER_UPDATED:' + user_id
          },
          replayMessages: true,
        });
      }
    }
  }
}
```

### primeChannelData

> [!WARNING]
> **DEPRECATED**: The `primeChannelData` feature has been deprecated in favor of adding the ability to the `iteratorWithLast` options - which allows quicker subscription establishment.

This function help to prime a trigger/channel with data.  It takes 2 parameters, the channel and an initializer function to get the data. Only if there is not data already on the channel is the initializer called and then silently - without publishing to _everyone_ puts data onto the channel (because likely no-one has been listening to the channel).

Once primed when subscribed with `iteratorWithLast` using `sendLatestOnNew`, this data will be sent to the person subscribing - and be ready for the next subscribers too.

Example:
```ts
const UserResolver = {
  Subscription: {
    userUpdated: {
      subscribe: async (_, { user_id }, ctx, info) => {
        const CHANNEL_KEY = 'USER_UPDATED:' + user_id;
        await pubsub.primeChannelData(CHANNEL_KEY, async () => {
          // run database call, and other logic
          return {
            userUpdated: {
              first_name: 'John',
              last_name: 'Doe',
              email: 'john@doe.test',
            }
          }
        });

        return pubsub.iteratorWithLast(CHANNEL_KEY, info, { sendLatestOnNew: true });
      }
    }
  }
}
```