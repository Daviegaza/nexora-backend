import type { FastifyInstance } from 'fastify';
import { registerAuthRoutes } from '../modules/auth/routes.js';
import { registerUserRoutes } from '../modules/users/routes.js';
import { registerProductRoutes } from '../modules/products/routes.js';
import { registerCustomerRoutes } from '../modules/customers/routes.js';
import { registerTransactionRoutes } from '../modules/transactions/routes.js';
import { registerEtimsRoutes } from '../modules/etims/routes.js';
import { registerMpesaRoutes } from '../modules/mpesa/routes.js';
import { registerChamaRoutes } from '../modules/chama/routes.js';
import { registerAiRoutes } from '../modules/ai/routes.js';

export async function registerRoutes(app: FastifyInstance) {
  await app.register(registerAuthRoutes,        { prefix: '/api/auth' });
  await app.register(registerUserRoutes,        { prefix: '/api/users' });
  await app.register(registerProductRoutes,     { prefix: '/api/products' });
  await app.register(registerCustomerRoutes,    { prefix: '/api/customers' });
  await app.register(registerTransactionRoutes, { prefix: '/api/transactions' });
  await app.register(registerEtimsRoutes,       { prefix: '/api/etims' });
  await app.register(registerMpesaRoutes,       { prefix: '/api/mpesa' });
  await app.register(registerChamaRoutes,       { prefix: '/api/chama' });
  await app.register(registerAiRoutes,          { prefix: '/api/ai' });
}
