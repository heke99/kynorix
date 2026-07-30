import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import {
  CreateDepositSchema,
  CreateMarketSchema,
  CreateWithdrawalSchema,
  ConfirmWithdrawalSchema,
  MarketQuerySchema,
  MarketStatusSchema,
  MintCompleteSetSchema,
  OrderQuoteRequestSchema,
  PlaceOrderSchema,
  ProposeResolutionSchema,
  StartVerificationSchema,
  type ApiEnvelope,
  type ApiErrorBody,
  type RealtimeEvent,
} from '@zoryqon/contracts';
import { externalRef } from '@zoryqon/core';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import rawBody from 'fastify-raw-body';
import { z } from 'zod';
import { AuthService } from './auth.js';
import type { ApiConfig } from './config.js';
import { Database } from './database.js';
import { ProviderRegistry } from './providers.js';
import { DomainError, ZoryqonRepository } from './repository.js';

export async function buildServer(config: ApiConfig) {
  const app = Fastify({
    logger: {
      level: config.logLevel,
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'req.body.password',
          'req.body.refresh_token',
          'req.body.access_token',
          'res.headers.set-cookie',
        ],
        censor: '[REDACTED]',
      },
    },
    trustProxy: config.trustProxy,
    requestIdHeader: 'x-request-id',
    genReqId: () => externalRef('req'),
    bodyLimit: 1024 * 1024,
  });
  const database = new Database(config);
  const providers = new ProviderRegistry(config);
  const auth = new AuthService(config, database);
  const repository = new ZoryqonRepository(database, config, providers);

  await app.register(cookie);
  await app.register(rawBody, {
    field: 'rawBody',
    global: false,
    encoding: false,
    runFirst: true,
  });
  await app.register(cors, {
    origin(origin, callback) {
      if (!origin || config.webOrigins.includes(origin)) callback(null, true);
      else callback(new Error('Origin is not allowed.'), false);
    },
    credentials: true,
    allowedHeaders: [
      'authorization',
      'content-type',
      'idempotency-key',
      'x-csrf-token',
      'x-request-id',
      'x-provider-signature',
    ],
  });
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'none'"],
        frameAncestors: ["'none'"],
        formAction: ["'self'"],
      },
    },
    crossOriginResourcePolicy: { policy: 'same-site' },
  });
  await app.register(rateLimit, {
    max: 300,
    timeWindow: '1 minute',
    keyGenerator: (request) =>
      `${request.ip}:${request.headers.authorization ? 'token' : 'public'}`,
  });
  await app.register(websocket);

  app.setErrorHandler((error, request, reply) => {
    const zod = error instanceof z.ZodError;
    const domain = error as Partial<DomainError>;
    const invariantCode =
      error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message) ? error.message : undefined;
    const statusCode = zod ? 400 : (domain.statusCode ?? (invariantCode ? 400 : 500));
    const code = zod ? 'VALIDATION_ERROR' : (domain.code ?? invariantCode ?? 'INTERNAL_ERROR');
    if (statusCode >= 500) request.log.error({ err: error, code }, 'Request failed');
    else request.log.info({ code, statusCode }, 'Request rejected');
    const body: ApiErrorBody = {
      error: {
        code,
        message: zod
          ? 'The request is invalid.'
          : statusCode >= 500
            ? 'An unexpected server error occurred.'
            : friendlyMessage(code, error instanceof Error ? error.message : code),
        requestRef: request.id,
        ...(zod ? { details: z.flattenError(error) } : {}),
      },
    };
    void reply.status(statusCode).send(body);
  });

  app.addHook('onClose', async () => database.close());
  app.addHook('onRequest', async (request) => {
    const csrfExempt =
      request.url.startsWith('/v1/provider-webhooks/') ||
      request.url.startsWith('/v1/auth/sign-in') ||
      request.url.startsWith('/v1/auth/sign-up');
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method) && !csrfExempt) {
      auth.verifyCsrf(request);
    }
  });

  app.get('/health/live', async () => ({ status: 'alive' }));
  app.get('/health/ready', async (request, reply) => {
    const [db, providerHealth, supabaseAuth, supabaseStorage] = await Promise.all([
      database.health(),
      providers.readiness(),
      auth.providerHealth(),
      supabaseStorageHealth(config),
    ]);
    const ledger = db.ok
      ? await database
          .query<{ differences: string }>(
            `select count(*)::text as differences from (
               select journal_id from public.ledger_entries
               group by journal_id having sum(debit_atoms) <> sum(credit_atoms)
             ) value`,
          )
          .then((result) => result.rows[0]?.differences === '0')
          .catch(() => false)
      : false;
    const providerChecks = Object.fromEntries(
      Object.entries(providerHealth).map(([name, status]) => [
        `${name}Provider`,
        status.configured ? status.healthy : 'not-configured',
      ]),
    );
    const checks = {
      supabasePostgres: db.ok,
      migration: db.migrationVersion === '20260730223000',
      supabaseAuth,
      supabaseStorage,
      ledgerIntegrity: ledger,
      ...providerChecks,
    };
    const providersReady =
      config.environment !== 'production' ||
      Object.values(providerHealth).every((status) => status.configured && status.healthy);
    const ready = db.ok && checks.migration && supabaseAuth && supabaseStorage && ledger && providersReady;
    return reply.status(ready ? 200 : 503).send(envelope(request, { ready, checks }));
  });

  app.get('/v1/system/status', async (request) =>
    envelope(request, { status: 'operational', serverTime: new Date().toISOString() }),
  );

  app.get('/v1/auth/login', async (request, reply) => {
    const { returnTo } = z.object({ returnTo: z.string().default('/') }).parse(request.query);
    const safeReturnTo = returnTo.startsWith('/') ? returnTo : '/';
    const webOrigin = config.webOrigins[0];
    if (!webOrigin) throw new Error('No web origin is configured.');
    const loginUrl = new URL('/login', webOrigin);
    loginUrl.searchParams.set('returnTo', safeReturnTo);
    return reply.redirect(loginUrl.toString());
  });
  app.post('/v1/auth/sign-in', async (request, reply) => {
    const input = z
      .object({ email: z.string().email(), password: z.string().min(8).max(256) })
      .parse(request.body);
    return envelope(request, await auth.signIn(input.email, input.password, request, reply));
  });
  app.post('/v1/auth/sign-up', async (request, reply) => {
    const input = z
      .object({
        email: z.string().email(),
        password: z.string().min(8).max(256),
        displayName: z.string().min(2).max(100),
      })
      .parse(request.body);
    return envelope(
      request,
      await auth.signUp(input.email, input.password, input.displayName, request, reply),
    );
  });
  app.post('/v1/auth/logout', async (request, reply) => {
    await auth.principal(request);
    await auth.logout(request, reply);
    return envelope(request, { loggedOut: true });
  });
  app.post('/v1/auth/refresh', async (request, reply) =>
    envelope(request, await auth.refresh(request, reply)),
  );

  app.get('/v1/markets', async (request) =>
    envelope(request, await repository.listMarkets(MarketQuerySchema.parse(request.query))),
  );
  app.get('/v1/markets/:marketRef', async (request) => {
    const { marketRef } = refParams(request);
    return envelope(request, await repository.getMarket(marketRef));
  });
  app.get('/v1/markets/:marketRef/orderbook', async (request) => {
    const { marketRef } = refParams(request);
    const { outcomeRef } = z.object({ outcomeRef: z.string().optional() }).parse(request.query);
    return envelope(request, await repository.getOrderbook(marketRef, outcomeRef));
  });
  app.get('/v1/markets/:marketRef/trades', async (request) => {
    const { marketRef } = refParams(request);
    const { limit } = z
      .object({ limit: z.coerce.number().int().positive().max(500).default(100) })
      .parse(request.query);
    return envelope(request, await repository.listTrades(marketRef, limit));
  });
  app.get('/v1/markets/:marketRef/history', async (request) => {
    const { marketRef } = refParams(request);
    const { outcomeRef, range } = z
      .object({
        outcomeRef: z.string().min(1),
        range: z.enum(['1H', '6H', '1D', '1W', '1M', 'ALL']).default('1D'),
      })
      .parse(request.query);
    return envelope(request, await repository.marketHistory(marketRef, outcomeRef, range));
  });
  app.get('/v1/categories', async (request) =>
    envelope(request, await repository.listCategories()),
  );
  app.get('/v1/assets', async (request) => envelope(request, await repository.listAssets()));

  app.get('/v1/me', async (request) => {
    const principal = await auth.principal(request);
    return envelope(request, repository.me(principal));
  });
  app.get('/v1/me/permissions', async (request) => {
    const principal = await auth.principal(request);
    return envelope(request, { roles: principal.roles, permissions: principal.permissions });
  });
  app.get('/v1/balances', async (request) => {
    const principal = await auth.principal(request);
    return envelope(request, await repository.balances(principal));
  });
  app.get('/v1/positions', async (request) => {
    const principal = await auth.principal(request);
    return envelope(request, await repository.positions(principal));
  });
  app.post('/v1/markets/:marketRef/complete-sets', async (request, reply) => {
    const principal = await auth.principal(request);
    const { marketRef } = refParams(request);
    const mint = await repository.mintCompleteSet(
      principal,
      marketRef,
      MintCompleteSetSchema.parse(request.body),
    );
    return reply.status(201).send(envelope(request, mint));
  });
  app.get('/v1/orders', async (request) => {
    const principal = await auth.principal(request);
    return envelope(request, await repository.orders(principal));
  });
  app.get('/v1/trades', async (request) => {
    const principal = await auth.principal(request);
    return envelope(request, await repository.userTrades(principal));
  });
  app.get('/v1/ledger', async (request) => {
    const principal = await auth.principal(request);
    return envelope(request, await repository.ledger(principal));
  });
  app.post('/v1/orders/quote', async (request) => {
    const principal = await auth.principal(request);
    return envelope(
      request,
      await repository.quoteOrder(principal, OrderQuoteRequestSchema.parse(request.body)),
    );
  });
  app.post('/v1/orders', async (request, reply) => {
    const principal = await auth.principal(request);
    const order = await repository.placeOrder(principal, PlaceOrderSchema.parse(request.body));
    return reply.status(201).send(envelope(request, order));
  });
  app.delete('/v1/orders/:orderRef', async (request) => {
    const principal = await auth.principal(request);
    const { orderRef } = z.object({ orderRef: z.string().min(1) }).parse(request.params);
    return envelope(request, await repository.cancelOrder(principal, orderRef));
  });
  app.get('/v1/deposits', async (request) => {
    const principal = await auth.principal(request);
    return envelope(request, await repository.deposits(principal));
  });
  app.post('/v1/deposits', async (request, reply) => {
    const principal = await auth.principal(request);
    return reply
      .status(201)
      .send(
        envelope(
          request,
          await repository.createDeposit(principal, CreateDepositSchema.parse(request.body)),
        ),
      );
  });
  app.get('/v1/withdrawals', async (request) => {
    const principal = await auth.principal(request);
    return envelope(request, await repository.withdrawals(principal));
  });
  app.post('/v1/withdrawals', async (request, reply) => {
    const principal = await auth.principal(request);
    return reply
      .status(201)
      .send(
        envelope(
          request,
          await repository.createWithdrawal(principal, CreateWithdrawalSchema.parse(request.body)),
        ),
      );
  });
  app.post('/v1/withdrawals/:withdrawalRef/confirm', async (request) => {
    const principal = await auth.principal(request);
    const { withdrawalRef } = z.object({ withdrawalRef: z.string().min(1) }).parse(request.params);
    return envelope(
      request,
      await repository.confirmWithdrawal(
        principal,
        withdrawalRef,
        ConfirmWithdrawalSchema.parse(request.body),
      ),
    );
  });
  app.get('/v1/verification', async (request) => {
    const principal = await auth.principal(request);
    return envelope(request, await repository.verification(principal));
  });
  app.post('/v1/verification/start', async (request, reply) => {
    const principal = await auth.principal(request);
    return reply
      .status(201)
      .send(
        envelope(
          request,
          await repository.startVerification(
            principal,
            StartVerificationSchema.parse(request.body),
          ),
        ),
      );
  });
  app.get('/v1/sessions', async (request) => {
    const principal = await auth.principal(request);
    return envelope(request, await repository.sessions(principal));
  });
  app.delete('/v1/sessions/:sessionRef', async (request) => {
    const principal = await auth.principal(request);
    const { sessionRef } = z.object({ sessionRef: z.string().min(1) }).parse(request.params);
    return envelope(request, await repository.revokeSession(principal, sessionRef));
  });
  app.get('/v1/notification-preferences', async (request) => {
    const principal = await auth.principal(request);
    return envelope(request, await repository.notificationPreferences(principal));
  });
  app.put('/v1/notification-preferences', async (request) => {
    const principal = await auth.principal(request);
    const input = z
      .object({
        emailEnabled: z.boolean(),
        pushEnabled: z.boolean(),
        inAppEnabled: z.boolean(),
        securitySmsEnabled: z.boolean(),
        marketClosingEnabled: z.boolean(),
      })
      .parse(request.body);
    return envelope(request, await repository.updateNotificationPreferences(principal, input));
  });

  app.post(
    '/v1/provider-webhooks/payment',
    { config: { rawBody: true } },
    async (request, reply) => {
      const raw = (request as FastifyRequest & { rawBody?: Buffer }).rawBody;
      if (!raw) throw Object.assign(new Error('PROVIDER_RAW_BODY_REQUIRED'), { statusCode: 400 });
      const signature = request.headers['x-provider-signature'];
      const event = providers.verifyPaymentWebhook(
        raw,
        typeof signature === 'string' ? signature : undefined,
      );
      const result = await repository.processPaymentEvent(event);
      return reply.status(result.duplicate ? 200 : 202).send(envelope(request, result));
    },
  );

  app.get('/v1/admin/overview', async (request) => {
    const principal = await auth.principal(request);
    auth.requirePermission(principal, 'operations.read');
    return envelope(request, await repository.operationsOverview(principal));
  });
  app.get('/v1/admin/markets', async (request) => {
    const principal = await auth.principal(request);
    auth.requirePermission(principal, 'markets.read');
    return envelope(
      request,
      await repository.listMarkets(
        MarketQuerySchema.parse({ ...asObject(request.query), limit: 100 }),
        true,
      ),
    );
  });
  for (const [path, resource, permission] of [
    ['deposits', 'deposits', 'deposits.read'],
    ['withdrawals', 'withdrawals', 'withdrawals.read'],
    ['compliance/cases', 'compliance', 'compliance.read'],
    ['reconciliation', 'reconciliation', 'reconciliation.read'],
    ['audit', 'audit', 'audit.read'],
    ['price-feeds', 'price_feeds', 'pricing.read'],
    ['ledger', 'ledger', 'ledger.read'],
    ['resolutions', 'resolutions', 'resolutions.read'],
  ] as const) {
    app.get(`/v1/admin/${path}`, async (request) => {
      const principal = await auth.principal(request);
      auth.requirePermission(principal, permission);
      return envelope(request, await repository.operationsRecords(principal, resource));
    });
  }
  app.post('/v1/admin/markets', async (request, reply) => {
    const principal = await auth.principal(request);
    auth.requirePermission(principal, 'markets.create');
    return reply
      .status(201)
      .send(
        envelope(
          request,
          await repository.createMarket(principal, CreateMarketSchema.parse(request.body)),
        ),
      );
  });
  for (const [path, status, permission] of [
    ['submit', 'under_review', 'markets.submit'],
    ['approve', 'approved', 'markets.approve'],
    ['publish', 'scheduled', 'markets.publish'],
    ['suspend', 'suspended', 'markets.suspend'],
    ['resume', 'open', 'markets.resume'],
    ['close', 'closing', 'markets.close'],
    ['void', 'voided', 'markets.void'],
  ] as const) {
    app.post(`/v1/admin/markets/:marketRef/${path}`, async (request) => {
      const principal = await auth.principal(request);
      auth.requirePermission(principal, permission);
      const { marketRef } = refParams(request);
      const { reason } = z.object({ reason: z.string().min(10) }).parse(request.body);
      return envelope(
        request,
        await repository.transitionMarket(principal, marketRef, status, reason),
      );
    });
  }
  app.post('/v1/admin/markets/:marketRef/resolution', async (request, reply) => {
    const principal = await auth.principal(request);
    auth.requirePermission(principal, 'resolutions.propose');
    const { marketRef } = refParams(request);
    return reply
      .status(201)
      .send(
        envelope(
          request,
          await repository.proposeResolution(
            principal,
            marketRef,
            ProposeResolutionSchema.parse(request.body),
          ),
        ),
      );
  });
  app.post('/v1/admin/resolutions/:resolutionRef/approve', async (request) => {
    const principal = await auth.principal(request);
    auth.requirePermission(principal, 'resolutions.approve');
    const { resolutionRef } = z.object({ resolutionRef: z.string().min(1) }).parse(request.params);
    const { reason } = z.object({ reason: z.string().min(10) }).parse(request.body);
    return envelope(request, await repository.approveResolution(principal, resolutionRef, reason));
  });

  app.get('/v1/ws', { websocket: true }, async (socket, request) => {
    const params = new URL(request.url, 'http://internal').searchParams;
    const requestedChannels = params.get('channels')?.split(',').filter(Boolean) ?? [];
    let lastTimestamp = params.get('cursor') ?? '1970-01-01T00:00:00.000Z';
    if (Number.isNaN(Date.parse(lastTimestamp))) {
      socket.close(1008, 'Invalid replay cursor.');
      return;
    }
    const principal = requestedChannels.some((channel) => channel.startsWith('user.'))
      ? await auth.principal(request)
      : await auth.principal(request, false);
    const channels = requestedChannels.filter((channel) =>
      validChannel(channel, principal?.userRef),
    );
    if (channels.length !== requestedChannels.length) {
      socket.close(1008, 'Channel authorization failed.');
      return;
    }
    const sendEvents = async () => {
      if (socket.readyState !== socket.OPEN || channels.length === 0) return;
      const result = await database
        .query<{
          event_ref: string;
          channel: string;
          event_type: string;
          sequence: string;
          occurred_at: string;
          payload_version: string;
          payload: unknown;
        }>(
          `select event_ref, channel, event_type, sequence::text, occurred_at::text,
          payload_version, payload from public.event_stream
         where channel = any($1::text[]) and occurred_at > $2::timestamptz
         order by occurred_at, sequence limit 500`,
          [channels, lastTimestamp],
        )
        .catch(() => ({ rows: [] }));
      for (const row of result.rows) {
        const event: RealtimeEvent = {
          eventId: row.event_ref,
          channel: row.channel,
          eventType: row.event_type,
          sequence: row.sequence,
          serverTimestamp: new Date(row.occurred_at).toISOString(),
          payloadVersion: row.payload_version,
          payload: row.payload,
        };
        socket.send(JSON.stringify(event));
        lastTimestamp = new Date(row.occurred_at).toISOString();
      }
    };
    socket.send(
      JSON.stringify({
        eventType: 'Subscribed',
        channels,
        serverTimestamp: new Date().toISOString(),
      }),
    );
    await sendEvents();
    const timer = setInterval(() => void sendEvents(), 1_000);
    socket.on('close', () => clearInterval(timer));
  });

  return app;
}

function envelope<T>(request: FastifyRequest, data: T): ApiEnvelope<T> {
  return { data, meta: { requestRef: request.id, serverTime: new Date().toISOString() } };
}

function refParams(request: FastifyRequest): { marketRef: string } {
  return z.object({ marketRef: z.string().min(1) }).parse(request.params);
}

function validChannel(channel: string, userRef?: string): boolean {
  if (/^market\.[a-zA-Z0-9_-]+\.(book|trades|ticker|status)$/.test(channel)) return true;
  return Boolean(
    userRef &&
    new RegExp(
      `^user\\.${escapeRegExp(userRef)}\\.(orders|fills|balances|positions|deposits|withdrawals|notifications)$`,
    ).test(channel),
  );
}

function friendlyMessage(code: string, fallback: string): string {
  const messages: Record<string, string> = {
    AUTHENTICATION_REQUIRED: 'Please log in to continue.',
    INVALID_ACCESS_TOKEN: 'Your session is invalid or has expired.',
    INVALID_LOGIN_CREDENTIALS: 'The email or password is incorrect.',
    EMAIL_ALREADY_REGISTERED: 'An account already exists for this email address.',
    EMAIL_ALREADY_LINKED: 'This email address is already linked to another account.',
    PASSWORD_REQUIREMENTS_NOT_MET: 'The password does not meet the configured Supabase requirements.',
    SESSION_REFRESH_FAILED: 'Your session could not be refreshed. Please log in again.',
    PROVIDER_NOT_CONFIGURED: 'This feature is not configured yet.',
    PERMISSION_DENIED: 'You do not have permission to perform this action.',
    CSRF_VALIDATION_FAILED: 'The security token is invalid. Refresh the page and try again.',
    INTERNAL_ERROR: 'An unexpected server error occurred.',
  };
  return messages[code] ?? (fallback === code ? code.toLowerCase().replaceAll('_', ' ') : fallback);
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function looksLikeLegacyJwtKey(value: string): boolean {
  return value.split('.').length === 3 && !value.startsWith('sb_secret_');
}

async function supabaseStorageHealth(config: ApiConfig): Promise<boolean> {
  try {
    const headers: Record<string, string> = { apikey: config.supabase.secretKey };
    if (looksLikeLegacyJwtKey(config.supabase.secretKey)) {
      headers.authorization = `Bearer ${config.supabase.secretKey}`;
    }
    const response = await fetch(
      `${config.supabase.url}/storage/v1/bucket/${encodeURIComponent(config.supabase.storageBucket)}`,
      {
        headers,
        signal: AbortSignal.timeout(5_000),
      },
    );
    return response.ok;
  } catch {
    return false;
  }
}
