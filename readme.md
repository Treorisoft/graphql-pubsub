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

> [!NOTE]
> This is workable but incomplete - only part of the planned features are currently available.

This works with the client setup and helps provide the latest data to the client upon reconnect.

The basic concept is that a `message_id` is sent with every publish and the client side will keep track of the last id it received. When the connection is interrupted and it reconnects and re-establishes the subscription it passes that id back to the server. This function will read that and compare with the latest id actually available, and immediately send back to the client any messages it might have missed while disconnected.

There are 2 modes this is planned to work with:

- `Send most recent only` - Upon reconnection if there is a newer message, send the most recent one containing the newest data.
- `Replay` - Upon reconnection if there are newer message, send all the messages between the last id and up-to and including the newest.

> [!NOTE]
> `Replay` has NOT been implemented yet.

`Replay` will be good for scenarios where the messages are compounded on each other - like chat messages. Where-as `Send most recent only` is good for scenarios where you want to deal with updates to data already on the page.

Example:
```ts
const UserResolver = {
  Subscription: {
    userUpdated: {
      subscribe: (_, { user_id }, ctx, info) => {
        return pubsub.iteratorWithLast('USER_UPDATED:' + user_id, info);
      }
    }
  }
}
```