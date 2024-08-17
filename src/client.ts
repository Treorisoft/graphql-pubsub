import type { RequestHandler } from '@apollo/client';
export const LastMessageLink: RequestHandler = (operation, forward) => {
  return forward(operation).map((response) => {
    if (response.extensions?.message_id) {
      if (!operation.extensions) operation.extensions = {};
      operation.extensions.last_subscribed_id = response.extensions.message_id;
    }
    return response;
  });
}; 