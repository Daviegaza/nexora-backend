import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import cookie from '@fastify/cookie';
import jwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import swagger from '@fastify/swagger';
import swaggerUI from '@fastify/swagger-ui';
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from 'fastify-type-provider-zod';
import { prisma } from './lib/prisma.js';
import { env } from './lib/env.js';
import { logger } from './lib/logger.js';
import { registerRoutes } from './routes/index.js';

async function bootstrap() {
  const app = Fastify({ loggerInstance: logger, trustProxy: true }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors, {
    origin: env.CORS_ORIGIN.split(',').map((s) => s.trim()),
    credentials: true,
  });
  await app.register(cookie, { hook: 'onRequest' });
  await app.register(jwt, {
    secret: { private: env.JWT_ACCESS_SECRET, public: env.JWT_ACCESS_SECRET },
    sign: { algorithm: 'HS256', expiresIn: env.JWT_ACCESS_TTL },
  });
  await app.register(rateLimit, { max: 200, timeWindow: '1 minute' });
  await app.register(websocket);
  await app.register(swagger, {
    openapi: {
      info: { title: 'NEXORA AI', version: '1.0.0', description: 'Kenya-first business OS API' },
      servers: [{ url: '/' }],
      components: {
        securitySchemes: {
          bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
        },
      },
    },
  });
  await app.register(swaggerUI, { routePrefix: '/docs' });

  await registerRoutes(app);

  app.get('/health', async () => ({
    ok: true,
    db: await prisma.$queryRaw`SELECT 1`.then(() => 'up').catch(() => 'down'),
    ts: new Date().toISOString(),
  }));

  app.setErrorHandler((err, req, reply) => {
    req.log.error({ err }, 'request failed');
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    reply.status(status).send({
      message: status >= 500 ? 'Internal server error' : err.message,
      code: (err as { code?: string }).code,
    });
  });

  await app.listen({ host: env.HOST, port: env.PORT });
  logger.info({ port: env.PORT }, 'NEXORA backend listening');
}

bootstrap().catch((e) => {
  console.error('Fatal boot error', e);
  process.exit(1);
});
