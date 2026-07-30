import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import {
  MarketStatusSchema,
  PlaceOrderSchema,
  ProposeResolutionSchema,
  type ApiEnvelope,
  type ApiErrorBody,
  type RealtimeEvent,
} from '@kynorix/contracts';
import { externalRef } from '@kynorix/core';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { ApiConfig } from './config.js';
import { SandboxStore, type DomainError } from './store.js';

export async function buildServer(config: ApiConfig) {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
      redact: ['req.headers.authorization', 'req.headers.cookie'],
    },
    requestIdHeader: 'x-request-id',
    genReqId: () => externalRef('req'),
    bodyLimit: 1024 * 1024,
  });
  const store = new SandboxStore();

  await app.register(cors, {
    origin(origin, callback) {
      if (!origin || config.webOrigins.includes(origin)) callback(null, true);
      else callback(new Error('Origin denied'), false);
    },
    credentials: false,
    allowedHeaders: ['content-type', 'x-kynorix-user', 'x-kynorix-admin', 'x-request-id'],
  });
  await app.register(websocket);

  app.setErrorHandler((error, request, reply) => {
    const domain = error as Partial<DomainError>;
    const zod = error instanceof z.ZodError;
    const invariantCode =
      error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message) ? error.message : undefined;
    const statusCode = zod ? 400 : (domain.statusCode ?? (invariantCode ? 400 : 500));
    const code = zod ? 'VALIDATION_ERROR' : (domain.code ?? invariantCode ?? 'INTERNAL_ERROR');
    if (statusCode >= 500) request.log.error(error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    const body: ApiErrorBody = {
      error: {
        code,
        message:
          statusCode >= 500
            ? 'Unexpected server error'
            : invariantCode
              ? invariantCode.toLowerCase().replaceAll('_', ' ')
              : errorMessage,
        requestRef: request.id,
        ...(zod ? { details: z.flattenError(error) } : {}),
      },
    };
    void reply.status(statusCode).send(body);
  });

  app.get('/health', async (request) =>
    envelope(request, { status: 'ok', service: 'kynorix-api', sandbox: true }),
  );
  app.get('/v1/system/capabilities', async (request) => envelope(request, store.capabilities()));
  app.get('/v1/sandbox/users', async (request) => envelope(request, store.listUsers()));

  app.get('/v1/markets', async (request) => envelope(request, store.listMarkets()));
  app.get('/v1/markets/:marketRef', async (request) => {
    const { marketRef } = z.object({ marketRef: z.string() }).parse(request.params);
    return envelope(request, store.getMarket(marketRef));
  });
  app.get('/v1/markets/:marketRef/orderbook', async (request) => {
    const { marketRef } = z.object({ marketRef: z.string() }).parse(request.params);
    const { outcomeRef } = z.object({ outcomeRef: z.string().optional() }).parse(request.query);
    return envelope(request, store.getOrderbook(marketRef, outcomeRef));
  });
  app.get('/v1/markets/:marketRef/trades', async (request) => {
    const { marketRef } = z.object({ marketRef: z.string() }).parse(request.params);
    const { limit } = z
      .object({ limit: z.coerce.number().int().positive().max(500).default(100) })
      .parse(request.query);
    return envelope(request, store.listTrades(marketRef, limit));
  });

  app.post('/v1/orders', async (request, reply) => {
    const userRef = requireUser(request);
    const input = PlaceOrderSchema.parse(request.body);
    return reply.status(201).send(envelope(request, store.placeOrder(userRef, input)));
  });
  app.get('/v1/orders', async (request) =>
    envelope(request, store.listOrders(requireUser(request))),
  );
  app.delete('/v1/orders/:orderRef', async (request) => {
    const { orderRef } = z.object({ orderRef: z.string() }).parse(request.params);
    return envelope(request, store.cancelOrder(requireUser(request), orderRef));
  });
  app.get('/v1/positions', async (request) =>
    envelope(request, store.listPositions(requireUser(request))),
  );
  app.get('/v1/balances', async (request) =>
    envelope(request, store.listBalances(requireUser(request))),
  );
  app.get('/v1/ledger', async (request) =>
    envelope(request, store.listLedger(requireUser(request))),
  );

  app.post('/v1/admin/markets/:marketRef/transition', async (request) => {
    requireAdmin(request);
    const { marketRef } = z.object({ marketRef: z.string() }).parse(request.params);
    const { status } = z.object({ status: MarketStatusSchema }).parse(request.body);
    return envelope(request, store.transitionMarket(marketRef, status));
  });
  app.post('/v1/admin/markets/:marketRef/close-for-resolution', async (request) => {
    requireAdmin(request);
    const { marketRef } = z.object({ marketRef: z.string() }).parse(request.params);
    return envelope(request, store.closeForResolution(marketRef));
  });
  app.post('/v1/admin/markets/:marketRef/resolutions', async (request, reply) => {
    const officerRef = requireAdmin(request);
    const { marketRef } = z.object({ marketRef: z.string() }).parse(request.params);
    const input = ProposeResolutionSchema.parse(request.body);
    return reply
      .status(201)
      .send(envelope(request, store.proposeResolution(marketRef, officerRef, input)));
  });
  app.post('/v1/admin/resolutions/:proposalRef/approve', async (request) => {
    const officerRef = requireAdmin(request);
    const { proposalRef } = z.object({ proposalRef: z.string() }).parse(request.params);
    return envelope(request, store.approveResolution(proposalRef, officerRef));
  });

  app.get('/v1/ws', { websocket: true }, (socket, request) => {
    const raw = new URL(request.url, 'http://localhost').searchParams.get('channels') ?? '';
    const subscriptions = new Set(raw.split(',').filter(validChannel));
    const onEvent = (event: RealtimeEvent) => {
      if (subscriptions.has(event.channel) && socket.readyState === socket.OPEN) {
        socket.send(JSON.stringify(event));
      }
    };
    store.events.on('event', onEvent);
    socket.send(
      JSON.stringify({
        type: 'subscribed',
        channels: [...subscriptions],
        serverTime: new Date().toISOString(),
      }),
    );
    socket.on('close', () => store.events.off('event', onEvent));
  });

  return app;
}

function envelope<T>(request: FastifyRequest, data: T): ApiEnvelope<T> {
  return {
    data,
    meta: {
      requestRef: request.id,
      serverTime: new Date().toISOString(),
      sandbox: true,
    },
  };
}

function requireUser(request: FastifyRequest): string {
  const value = request.headers['x-kynorix-user'];
  if (typeof value !== 'string' || value.length < 3) {
    throw Object.assign(new Error('x-kynorix-user header is required'), {
      code: 'AUTHENTICATION_REQUIRED',
      statusCode: 401,
    });
  }
  return value;
}

function requireAdmin(request: FastifyRequest): string {
  const value = request.headers['x-kynorix-admin'];
  if (typeof value !== 'string' || value.length < 3) {
    throw Object.assign(new Error('x-kynorix-admin header is required'), {
      code: 'ADMIN_AUTHENTICATION_REQUIRED',
      statusCode: 401,
    });
  }
  return value;
}

function validChannel(channel: string): boolean {
  return /^(market|user)\.[a-zA-Z0-9_-]+\.(book|trades|ticker|orders|fills|balances|notifications)$/.test(
    channel,
  );
}
