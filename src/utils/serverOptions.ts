import type { Extra } from 'graphql-ws/lib/use/ws';
import type { ServerOptions, Context } from 'graphql-ws/lib/server';
import { MessageType, stringifyMessage, type ConnectionInitMessage, type ErrorMessage, type SubscribeMessage } from 'graphql-ws';
import { createSourceEventStream, DefinitionNode, DocumentNode, type ExecutionArgs, GraphQLError, execute as graphqlExecute, parse as graphqlParse, validate as graphqlValidate, Kind } from 'graphql';
import { getProxyMethod } from './getProxyMethod';
import { isAsyncIterable } from './isAsyncIterable';
import { mapAsyncIterator } from 'graphql/execution/mapAsyncIterator';
import { OperationMessageSymbol } from './lastMessageId';
import { areGraphQLErrors } from './areGraphqlErrors';

let subscribeWarned: boolean = false;

function documentProxy(document: DocumentNode, message: SubscribeMessage) {
  return new Proxy(document, {
    get(target, prop, receiver) {
      const existingValue = Reflect.get(target, prop, receiver);
      if (prop === 'definitions') {
        const definitions = existingValue as readonly DefinitionNode[];
        return definitions.map(d => {
          if (d.kind == Kind.OPERATION_DEFINITION) {
            return new Proxy(d, {
              has(opTarget, p) {
                if (p === OperationMessageSymbol) {
                  return true;
                }
                return Reflect.has(opTarget, p);
              },
              get(opTarget, p, receiver) {
                if (p === OperationMessageSymbol) {
                  return message;
                }
                return Reflect.get(opTarget, p, receiver);
              },
            });
          }
          return d;
        });
      }
      return existingValue;
    }
  });
}

export function serverOptions<P extends ConnectionInitMessage['payload'] = ConnectionInitMessage['payload'], E extends Record<PropertyKey, unknown> = {[x: string]: unknown}>(options: ServerOptions<P, Extra & Partial<E>>): ServerOptions<P, Extra & Partial<E>> {
  return new Proxy(options, {
    has(target, prop) {
      if (prop === 'onSubscribe' || prop === 'subscribe') {
        return true;
      }
      return Reflect.has(target, prop);
    },
    get(target, prop, receiver) {
      const existingValue = Reflect.get(target, prop, receiver);
      if (prop === 'onSubscribe') {
        return async function onSubscribe(ctx: Context<P, Extra & Partial<E>>, message: SubscribeMessage) {
          const onError = Reflect.get(target, 'onError', receiver);
          const replacer = Reflect.get(target, 'jsonMessageReplacer', receiver);

          let onSubscribeResult = existingValue;
          if (typeof existingValue === 'function') {
            onSubscribeResult = await Reflect.apply(existingValue, target, arguments);
          }

          async function sendError(errors: readonly GraphQLError[]) {
            let errorMessage: ErrorMessage = {
              id: message.id,
              type: MessageType.Error,
              payload: errors,
            };
            const maybeErrors = await onError?.(ctx, errorMessage, errors);
            if (maybeErrors) {
              errorMessage = {
                ...errorMessage,
                payload: maybeErrors,
              };
            }
            await ctx.extra.socket.send(stringifyMessage<MessageType.Error>(errorMessage, replacer));
          }

          if (onSubscribeResult) {
            if (areGraphQLErrors(onSubscribeResult)) {
              return message.id in ctx.subscriptions ? await sendError(onSubscribeResult) : void 0;
            }
            else if (Array.isArray(onSubscribeResult)) {
              throw new Error(
                'Invalid return value from onSubscribe hook, expected an array of GraphQLError objects',
              );
            }
          }
          else {
            const schema = Reflect.get(target, 'schema', receiver);
            const validate = Reflect.get(target, 'validate', receiver);

            const args = {
              operationName: message.payload.operationName ,
              document: graphqlParse(message.payload.query),
              variableValues: message.payload.variables,
            }
            onSubscribeResult = {
              ...args,
              schema: typeof schema === 'function' ? await schema(ctx, message, args) : schema,
            };

            const validationErrors = (validate ?? graphqlValidate)(onSubscribeResult.schema, onSubscribeResult.document);
            if (validationErrors.length > 0) {
              return message.id in ctx.subscriptions ? await sendError(validationErrors) : void 0;
            }
          }

          onSubscribeResult = {
            ...onSubscribeResult,
            document: documentProxy(onSubscribeResult.document, message),
          }
          return onSubscribeResult;
        }
      }
      else if (prop === 'subscribe') {
        if (typeof existingValue === 'function' && !subscribeWarned) {
          console.warn(`In order to decorate the subscription payload with extensions, it's necessary to replace the default graphql "subscribe"`);
          console.warn(`To avoid accidental double-execution and properly map responses - extensions are NOT applying`);
          subscribeWarned = true;
          return existingValue;
        }

        return async function subscribe(args: ExecutionArgs) {
          const resultOrStream = await createSourceEventStream(args);
          if (!isAsyncIterable(resultOrStream)) {
            // handles subscribe errors??
            return resultOrStream;
          }

          const mapSourceToResponse = async (payload: unknown) => {
            let srcResult = await graphqlExecute({ ...args, rootValue: payload });
            if (payload && typeof payload === 'object' && 'extensions' in payload && typeof payload.extensions === 'object') {
              srcResult.extensions = payload.extensions as any;
            }
            return srcResult;
          }

          return mapAsyncIterator(resultOrStream, mapSourceToResponse);
        }
      }
      else if (typeof existingValue === 'function') {
        return getProxyMethod(target, existingValue);
      }
      return existingValue;
    },
  });
}