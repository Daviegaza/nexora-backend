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
import type { FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from 'fastify-type-provider-zod';
import { prisma } from './lib/prisma.js';
import { env } from './lib/env.js';
import { logger } from './lib/logger.js';
import { registerRoutes } from './routes/index.js';

const bootTs = new Date();

async function bootstrap() {
  const app = Fastify({
    loggerInstance: logger,
    trustProxy: true,
  }).withTypeProvider<ZodTypeProvider>();
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

  await registerRoutes(app as unknown as FastifyInstance);

  // Legacy /health preserved for backward compat; prefer split endpoints below.
  app.get('/health', async () => ({
    ok: true,
    db: await prisma.$queryRaw`SELECT 1`.then(() => 'up').catch(() => 'down'),
    ts: new Date().toISOString(),
  }));

  // Kubernetes-style split:
  //  - /health/live: process is up (never touch DB — that would false-negative the pod)
  //  - /health/ready: dependencies are healthy enough to serve traffic
  app.get('/health/live', async () => ({
    ok: true,
    uptimeSec: Math.round((Date.now() - bootTs.getTime()) / 1000),
    pid: process.pid,
  }));

  app.get('/health/ready', async (_req, reply) => {
    const dbOk = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);
    const status = dbOk ? 200 : 503;
    return reply.code(status).send({
      ok: dbOk,
      db: dbOk ? 'up' : 'down',
      ts: new Date().toISOString(),
    });
  });

  app.setErrorHandler((err, req, reply) => {
    req.log.error({ err }, 'request failed');
    const e = err as { statusCode?: number; message?: string; code?: string };
    const status = e.statusCode ?? 500;
    reply.status(status).send({
      message: status >= 500 ? 'Internal server error' : (e.message ?? 'Error'),
      code: e.code,
    });
  });

  await app.listen({ host: env.HOST, port: env.PORT });
  logger.info({ port: env.PORT }, 'NEXORA backend listening');

  // Graceful shutdown — drain requests, close DB, then exit.
  // K8s sends SIGTERM before SIGKILL (30s default grace); PM2 uses SIGINT.
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutdown initiated');
    const timer = setTimeout(() => {
      logger.error('shutdown timeout — forcing exit');
      process.exit(1);
    }, 25_000).unref();
    try {
      await app.close();
      await prisma.$disconnect();
      clearTimeout(timer);
      logger.info('shutdown complete');
      process.exit(0);
    } catch (err) {
      logger.error({ err }, 'shutdown error');
      process.exit(1);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    logger.error({ reason }, 'unhandled rejection');
  });
}

bootstrap().catch((e) => {
  console.error('Fatal boot error', e);
  process.exit(1);
});
