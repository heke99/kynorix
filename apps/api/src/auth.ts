import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import type { AuthenticatedUser } from '@kynorix/contracts';
import { externalRef } from '@kynorix/core';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import type { ApiConfig } from './config.js';
import type { Database } from './database.js';

interface Discovery {
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  end_session_endpoint?: string;
}

export interface Principal extends AuthenticatedUser {
  userId: string;
  tenantId: string;
  tenantRef: string;
  subject: string;
}

export class AuthService {
  private discovery?: Discovery;
  private jwks?: ReturnType<typeof createRemoteJWKSet>;
  private readonly encryptionKey: Buffer;

  constructor(
    private readonly config: ApiConfig,
    private readonly database: Database,
  ) {
    this.encryptionKey = decodeEncryptionKey(config.sessionEncryptionKey);
  }

  async beginLogin(returnTo: string): Promise<{
    authorizationUrl: string;
    state: string;
  }> {
    const discovery = await this.getDiscovery();
    const state = randomBytes(32).toString('base64url');
    const nonce = randomBytes(32).toString('base64url');
    const verifier = randomBytes(64).toString('base64url');
    const challenge = sha256(verifier);
    const safeReturnTo = returnTo.startsWith('/') ? returnTo : '/';
    await this.database.query(
      `insert into public.auth_flows
       (state_hash, nonce_hash, verifier_ciphertext, return_to, expires_at)
       values ($1, $2, $3, $4, clock_timestamp() + interval '10 minutes')`,
      [sha256(state), sha256(nonce), encrypt(verifier, this.encryptionKey), safeReturnTo],
    );
    const url = new URL(discovery.authorization_endpoint);
    url.searchParams.set('client_id', this.config.oidc.clientId);
    url.searchParams.set('redirect_uri', this.config.oidc.redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', 'openid profile email offline_access');
    url.searchParams.set('state', state);
    url.searchParams.set('nonce', nonce);
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 'S256');
    return { authorizationUrl: url.toString(), state };
  }

  async completeLogin(
    code: string,
    state: string,
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<string> {
    const flow = await this.database.transaction({}, async (client) => {
      const result = await client.query<{
        nonce_hash: string;
        verifier_ciphertext: Buffer;
        return_to: string;
      }>(
        `select nonce_hash, verifier_ciphertext, return_to
         from public.auth_flows
         where state_hash = $1 and consumed_at is null and expires_at > clock_timestamp()
         for update`,
        [sha256(state)],
      );
      const record = result.rows[0];
      if (!record) throw authError('INVALID_AUTHORIZATION_STATE', 400);
      await client.query(
        'update public.auth_flows set consumed_at = clock_timestamp() where state_hash = $1',
        [sha256(state)],
      );
      return record;
    });

    const discovery = await this.getDiscovery();
    const tokenResponse = await fetch(discovery.token_endpoint, {
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from(
          `${this.config.oidc.clientId}:${this.config.oidc.clientSecret}`,
        ).toString('base64')}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: this.config.oidc.redirectUri,
        code_verifier: decrypt(flow.verifier_ciphertext, this.encryptionKey),
      }),
    });
    if (!tokenResponse.ok) throw authError('TOKEN_EXCHANGE_FAILED', 401);
    const tokens = (await tokenResponse.json()) as {
      access_token: string;
      id_token: string;
      refresh_token?: string;
      expires_in: number;
    };
    const identity = await this.verifyToken(tokens.id_token);
    const nonce = typeof identity.nonce === 'string' ? sha256(identity.nonce) : '';
    if (
      nonce.length !== flow.nonce_hash.length ||
      !timingSafeEqual(Buffer.from(nonce), Buffer.from(flow.nonce_hash))
    ) {
      throw authError('INVALID_IDENTITY_NONCE', 401);
    }
    const principal = await this.provisionOrLoadUser(identity);
    const sessionMfaVerified = hasStrongAuthentication(identity);
    const sessionRef = externalRef('ses');
    const refreshCiphertext = tokens.refresh_token
      ? encrypt(tokens.refresh_token, this.encryptionKey)
      : null;
    await this.database.query(
      `insert into public.user_sessions
       (user_id, session_ref, oidc_session_id, refresh_token_ciphertext, refresh_token_hash,
        ip, user_agent, mfa_verified, expires_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, clock_timestamp() + ($9 || ' seconds')::interval)`,
      [
        principal.userId,
        sessionRef,
        typeof identity.sid === 'string' ? identity.sid : null,
        refreshCiphertext,
        tokens.refresh_token ? sha256(tokens.refresh_token) : null,
        request.ip,
        request.headers['user-agent'] ?? null,
        sessionMfaVerified,
        Math.max(60, tokens.expires_in),
      ],
    );
    const secure = this.config.environment !== 'development';
    reply.setCookie('kynorix_access', tokens.access_token, {
      path: '/',
      httpOnly: true,
      secure,
      sameSite: 'lax',
      maxAge: Math.max(60, tokens.expires_in),
    });
    reply.setCookie('kynorix_session', sessionRef, {
      path: '/',
      httpOnly: true,
      secure,
      sameSite: 'lax',
      maxAge: Math.max(60, tokens.expires_in),
    });
    reply.setCookie('kynorix_csrf', randomBytes(24).toString('base64url'), {
      path: '/',
      httpOnly: false,
      secure,
      sameSite: 'lax',
      maxAge: Math.max(60, tokens.expires_in),
    });
    return flow.return_to;
  }

  async principal(request: FastifyRequest): Promise<Principal>;
  async principal(request: FastifyRequest, required: true): Promise<Principal>;
  async principal(request: FastifyRequest, required: false): Promise<Principal | null>;
  async principal(request: FastifyRequest, required = true): Promise<Principal | null> {
    const authorization = request.headers.authorization;
    const token = authorization?.startsWith('Bearer ')
      ? authorization.slice(7)
      : request.cookies.kynorix_access;
    if (!token) {
      if (required) throw authError('AUTHENTICATION_REQUIRED', 401);
      return null;
    }
    const claims = await this.verifyToken(token).catch(() => {
      throw authError('INVALID_ACCESS_TOKEN', 401);
    });
    const subject = claims.sub;
    if (!subject) throw authError('INVALID_ACCESS_TOKEN', 401);
    const sessionRef = request.cookies.kynorix_session;
    if (!authorization && sessionRef) {
      const session = await this.database.query<{ mfa_verified: boolean }>(
        `select s.mfa_verified from public.user_sessions s
         join public.users u on u.id = s.user_id
         where s.session_ref = $1 and u.oidc_subject = $2
           and s.revoked_at is null and s.expires_at > clock_timestamp()`,
        [sessionRef, subject],
      );
      if (!session.rows[0]) throw authError('SESSION_REVOKED', 401);
      const principal = await this.loadPrincipal(subject);
      return { ...principal, mfaVerified: session.rows[0].mfa_verified };
    }
    const principal = await this.loadPrincipal(subject);
    return { ...principal, mfaVerified: hasStrongAuthentication(claims) };
  }

  verifyCsrf(request: FastifyRequest): void {
    if (request.headers.authorization?.startsWith('Bearer ')) return;
    const cookie = request.cookies.kynorix_csrf;
    const header = request.headers['x-csrf-token'];
    if (
      !cookie ||
      typeof header !== 'string' ||
      cookie.length !== header.length ||
      !timingSafeEqual(Buffer.from(cookie), Buffer.from(header))
    ) {
      throw authError('CSRF_VALIDATION_FAILED', 403);
    }
  }

  requirePermission(principal: Principal, permission: string): void {
    if (!principal.permissions.includes(permission)) {
      throw authError('PERMISSION_DENIED', 403);
    }
  }

  async logout(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const sessionRef = request.cookies.kynorix_session;
    if (sessionRef) {
      await this.database.query(
        'update public.user_sessions set revoked_at = clock_timestamp() where session_ref = $1',
        [sessionRef],
      );
    }
    for (const cookie of ['kynorix_access', 'kynorix_session', 'kynorix_csrf']) {
      reply.clearCookie(cookie, { path: '/' });
    }
  }

  async refresh(request: FastifyRequest, reply: FastifyReply): Promise<{ expiresIn: number }> {
    const sessionRef = request.cookies.kynorix_session;
    if (!sessionRef) throw authError('AUTHENTICATION_REQUIRED', 401);
    return this.database.transaction({}, async (client) => {
      const result = await client.query<{
        refresh_token_ciphertext: Buffer;
        oidc_subject: string;
      }>(
        `select s.refresh_token_ciphertext, u.oidc_subject
         from public.user_sessions s join public.users u on u.id = s.user_id
         where s.session_ref = $1 and s.revoked_at is null
           and s.refresh_token_ciphertext is not null
         for update of s`,
        [sessionRef],
      );
      const session = result.rows[0];
      if (!session) throw authError('SESSION_REFRESH_UNAVAILABLE', 401);
      const discovery = await this.getDiscovery();
      const response = await fetch(discovery.token_endpoint, {
        method: 'POST',
        headers: {
          authorization: `Basic ${Buffer.from(
            `${this.config.oidc.clientId}:${this.config.oidc.clientSecret}`,
          ).toString('base64')}`,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: decrypt(session.refresh_token_ciphertext, this.encryptionKey),
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) {
        await client.query(
          'update public.user_sessions set revoked_at = clock_timestamp() where session_ref = $1',
          [sessionRef],
        );
        throw authError('SESSION_REFRESH_FAILED', 401);
      }
      const tokens = (await response.json()) as {
        access_token: string;
        refresh_token?: string;
        expires_in: number;
      };
      const claims = await this.verifyToken(tokens.access_token);
      if (claims.sub !== session.oidc_subject) {
        throw authError('SESSION_SUBJECT_MISMATCH', 401);
      }
      const rotatedRefresh = tokens.refresh_token;
      await client.query(
        `update public.user_sessions set
          refresh_token_ciphertext = coalesce($2, refresh_token_ciphertext),
          refresh_token_hash = coalesce($3, refresh_token_hash),
          mfa_verified = $4,
          expires_at = clock_timestamp() + ($5 || ' seconds')::interval,
          last_seen_at = clock_timestamp()
         where session_ref = $1`,
        [
          sessionRef,
          rotatedRefresh ? encrypt(rotatedRefresh, this.encryptionKey) : null,
          rotatedRefresh ? sha256(rotatedRefresh) : null,
          hasStrongAuthentication(claims),
          Math.max(60, tokens.expires_in),
        ],
      );
      const secure = this.config.environment !== 'development';
      reply.setCookie('kynorix_access', tokens.access_token, {
        path: '/',
        httpOnly: true,
        secure,
        sameSite: 'lax',
        maxAge: Math.max(60, tokens.expires_in),
      });
      return { expiresIn: Math.max(60, tokens.expires_in) };
    });
  }

  async providerHealth(): Promise<boolean> {
    try {
      const discovery = await this.getDiscovery();
      return Boolean(discovery.authorization_endpoint && discovery.token_endpoint);
    } catch {
      return false;
    }
  }

  private async verifyToken(token: string): Promise<JWTPayload> {
    const discovery = await this.getDiscovery();
    this.jwks ??= createRemoteJWKSet(new URL(discovery.jwks_uri));
    const result = await jwtVerify(token, this.jwks, {
      issuer: this.config.oidc.issuer.replace(/\/$/, ''),
      audience: this.config.oidc.audience,
      clockTolerance: 5,
    });
    return result.payload;
  }

  private async getDiscovery(): Promise<Discovery> {
    if (this.discovery) return this.discovery;
    const response = await fetch(
      `${this.config.oidc.issuer.replace(/\/$/, '')}/.well-known/openid-configuration`,
      { signal: AbortSignal.timeout(5_000) },
    );
    if (!response.ok) throw new Error('Identity provider discovery failed.');
    this.discovery = (await response.json()) as Discovery;
    return this.discovery;
  }

  private async provisionOrLoadUser(claims: JWTPayload): Promise<Principal> {
    if (!claims.sub) throw authError('IDENTITY_SUBJECT_REQUIRED', 401);
    const tenant = await this.database.query<{ id: string }>(
      `select id from public.tenants where tenant_ref = $1 and status = 'active'`,
      [this.config.tenantRef],
    );
    const tenantId = tenant.rows[0]?.id;
    if (!tenantId) throw authError('TENANT_NOT_ACTIVE', 503);
    const userRef = externalRef('usr');
    const email = typeof claims.email === 'string' ? claims.email.toLowerCase() : null;
    const displayName =
      typeof claims.name === 'string'
        ? claims.name
        : typeof claims.preferred_username === 'string'
          ? claims.preferred_username
          : (email ?? 'Kynorix customer');
    await this.database.transaction({ tenantId }, async (client) => {
      const user = await client.query<{ id: string }>(
        `insert into public.users
         (tenant_id, user_ref, oidc_subject, account_status)
         values ($1, $2, $3, 'email_pending')
         on conflict (tenant_id, oidc_subject)
         do update set updated_at = clock_timestamp()
         returning id`,
        [tenantId, userRef, claims.sub],
      );
      const userId = user.rows[0]!.id;
      await client.query(
        `insert into public.user_roles (user_id, role_key)
         select $1, 'customer' where exists (
           select 1 from public.roles where role_key = 'customer'
         )
         on conflict (user_id, role_key) do nothing`,
        [userId],
      );
      await client.query(
        `insert into public.ledger_accounts
         (tenant_id, account_ref, owner_user_id, asset_id, account_type, normal_side)
         select $1, 'acct:' || $2 || ':' || lower(a.symbol) || ':' || kind.account_type,
           $3, a.id, kind.account_type, 'credit'::public.ledger_normal_side
         from public.assets a
         cross join (values
           ('customer_available'),
           ('customer_locked'),
           ('customer_pending_deposit'),
           ('customer_pending_withdrawal'),
           ('customer_asset_available'),
           ('customer_asset_locked')
         ) as kind(account_type)
         where a.enabled
         on conflict (tenant_id, owner_user_id, asset_id, account_type) do nothing`,
        [tenantId, userRef, userId],
      );
      await client.query(
        `insert into public.user_profiles (user_id, display_name)
         values ($1, $2)
         on conflict (user_id) do update set display_name = excluded.display_name,
           updated_at = clock_timestamp()`,
        [userId, displayName],
      );
      if (email) {
        await client.query(
          `insert into public.user_emails (user_id, email, verified_at, is_primary)
           values ($1, $2, case when $3 then clock_timestamp() else null end, true)
           on conflict (lower(email)) do nothing`,
          [userId, email, claims.email_verified === true],
        );
        const emailOwner = await client.query<{ user_id: string }>(
          `select user_id from public.user_emails where lower(email) = lower($1) for update`,
          [email],
        );
        if (emailOwner.rows[0]?.user_id !== userId) {
          throw authError('EMAIL_ALREADY_LINKED', 409);
        }
        if (claims.email_verified === true) {
          await client.query(
            `update public.user_emails set verified_at = coalesce(verified_at, clock_timestamp())
             where user_id = $1 and lower(email) = lower($2)`,
            [userId, email],
          );
        }
        if (claims.email_verified === true) {
          await client.query(
            `update public.users set account_status =
             case when account_status = 'email_pending' then 'kyc_pending' else account_status end
             where id = $1`,
            [userId],
          );
        }
      }
    });
    return this.loadPrincipal(claims.sub);
  }

  private async loadPrincipal(subject: string): Promise<Principal> {
    const result = await this.database.query<{
      id: string;
      tenant_id: string;
      tenant_ref: string;
      user_ref: string;
      oidc_subject: string;
      account_status: string;
      kyc_level: string;
      display_name: string;
      email: string | null;
      mfa_verified: boolean;
      roles: string[];
      permissions: string[];
    }>(
      `select u.id, u.tenant_id, t.tenant_ref, u.user_ref, u.oidc_subject,
        u.account_status::text, u.kyc_level, p.display_name, e.email,
        (u.mfa_verified_at is not null) as mfa_verified,
        coalesce(array_agg(distinct ur.role_key) filter (where ur.role_key is not null), '{}') as roles,
        coalesce(array_agg(distinct rp.permission_key) filter (where rp.permission_key is not null), '{}') as permissions
       from public.users u
       join public.tenants t on t.id = u.tenant_id and t.status = 'active'
       join public.user_profiles p on p.user_id = u.id
       left join public.user_emails e on e.user_id = u.id and e.is_primary
       left join public.user_roles ur on ur.user_id = u.id and ur.revoked_at is null
       left join public.role_permissions rp on rp.role_key = ur.role_key
       where u.oidc_subject = $1 and u.tenant_id = (
         select id from public.tenants where tenant_ref = $2
       )
       group by u.id, t.tenant_ref, p.display_name, e.email`,
      [subject, this.config.tenantRef],
    );
    const row = result.rows[0];
    if (!row) throw authError('ACCOUNT_NOT_PROVISIONED', 403);
    if (['suspended', 'closed', 'deceased'].includes(row.account_status)) {
      throw authError('ACCOUNT_ACCESS_RESTRICTED', 403);
    }
    return {
      userId: row.id,
      tenantId: row.tenant_id,
      tenantRef: row.tenant_ref,
      subject: row.oidc_subject,
      userRef: row.user_ref,
      email: row.email ?? '',
      displayName: row.display_name,
      accountStatus: row.account_status,
      kycLevel: row.kyc_level,
      roles: row.roles,
      permissions: row.permissions,
      mfaVerified: row.mfa_verified,
    };
  }
}

export type AuthPrincipal = Principal;

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('base64url');
}

function decodeEncryptionKey(value: string): Buffer {
  const key = Buffer.from(value, 'base64url');
  if (key.byteLength !== 32) {
    throw new Error('SESSION_ENCRYPTION_KEY must be a base64url-encoded 32-byte key.');
  }
  return key;
}

function encrypt(value: string, key: Buffer): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
}

function decrypt(value: Buffer, key: Buffer): string {
  const iv = value.subarray(0, 12);
  const tag = value.subarray(12, 28);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString('utf8');
}

function authError(code: string, statusCode: number): Error {
  return Object.assign(new Error(code), { code, statusCode });
}

function hasStrongAuthentication(claims: JWTPayload): boolean {
  const methods = Array.isArray(claims.amr)
    ? claims.amr.filter((value): value is string => typeof value === 'string')
    : [];
  return methods.some((value) => ['mfa', 'otp', 'totp', 'webauthn', 'hwk'].includes(value));
}
