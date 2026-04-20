import { EnterpriseChatError } from './service.js';

function ok(body, statusCode = 200) {
  return { handled: true, statusCode, body };
}

export function createEnterpriseChatRoutes(service) {
  return {
    async dispatch({ pathname, method, body = {}, userId, orgId }) {
      if (!service) return null;

      if (pathname === '/api/enterprise/chat/save_chat_new' && method === 'POST') {
        try {
          const result = await service.saveChatNew(body, { userId, orgId });
          return ok(result, 201);
        } catch (error) {
          if (error instanceof EnterpriseChatError) {
            return ok({ error: error.message }, error.statusCode);
          }
          return ok({ error: 'Failed to create enterprise chat', message: error.message }, 500);
        }
      }

      if (pathname === '/api/enterprise/chat/save_chat_old' && method === 'POST') {
        try {
          const result = await service.saveChatOld(body, { userId, orgId });
          return ok(result, 200);
        } catch (error) {
          if (error instanceof EnterpriseChatError) {
            return ok({ error: error.message }, error.statusCode);
          }
          return ok({ error: 'Failed to append enterprise chat', message: error.message }, 500);
        }
      }

      return null;
    },
  };
}