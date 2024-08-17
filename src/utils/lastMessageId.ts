import type { GraphQLResolveInfo } from "graphql";
import type { SubscribeMessage } from "graphql-ws/lib/common";

export const OperationMessageSymbol = Symbol('graphql-pubsub-operation-message');

export function getLastMessageId(info: GraphQLResolveInfo) {
  const hasMessage = (OperationMessageSymbol in info.operation);
  if (!hasMessage) {
    return undefined;
  }

  let message = info.operation[OperationMessageSymbol] as SubscribeMessage;
  return message.payload.extensions?.last_subscribed_id as string | undefined;
}