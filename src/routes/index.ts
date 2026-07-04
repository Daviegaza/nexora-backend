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
import { registerPayrollRoutes } from '../modules/payroll/routes.js';
import { registerBranchRoutes } from '../modules/branches/routes.js';
import { registerSupplierRoutes } from '../modules/suppliers/routes.js';
import { registerNotificationRoutes } from '../modules/notifications/routes.js';
import { registerLeadRoutes } from '../modules/leads/routes.js';
import { registerInvoiceRoutes } from '../modules/invoices/routes.js';
import { registerInventoryRoutes } from '../modules/inventory/routes.js';
import { registerHrRoutes } from '../modules/hr/routes.js';

export async function registerRoutes(app: FastifyInstance) {
  await app.register(registerAuthRoutes, { prefix: '/api/auth' });
  await app.register(registerUserRoutes, { prefix: '/api/users' });
  await app.register(registerProductRoutes, { prefix: '/api/products' });
  await app.register(registerCustomerRoutes, { prefix: '/api/customers' });
  await app.register(registerTransactionRoutes, { prefix: '/api/transactions' });
  await app.register(registerEtimsRoutes, { prefix: '/api/etims' });
  await app.register(registerMpesaRoutes, { prefix: '/api/mpesa' });
  await app.register(registerChamaRoutes, { prefix: '/api/chama' });
  await app.register(registerAiRoutes, { prefix: '/api/ai' });
  await app.register(registerPayrollRoutes, { prefix: '/api/payroll' });
  await app.register(registerBranchRoutes, { prefix: '/api/branches' });
  await app.register(registerSupplierRoutes, { prefix: '/api/suppliers' });
  await app.register(registerNotificationRoutes, { prefix: '/api/notifications' });
  await app.register(registerLeadRoutes, { prefix: '/api/leads' });
  await app.register(registerInvoiceRoutes, { prefix: '/api/invoices' });
  await app.register(registerInventoryRoutes, { prefix: '/api/inventory' });
  await app.register(registerHrRoutes, { prefix: '/api/hr' });
}
