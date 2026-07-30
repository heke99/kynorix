import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import type { AuthenticatedUser } from '@zoryqon/contracts';
import { externalRef } from '@zoryqon/core';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { createRemoteJWKSet, decodeJwt, jwtVerify, type JWTPayload } from 'jose';
import type { ApiConfig } from './config.js';
import type { Database } from './database.js';

interface SupabaseTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
  user?: SupabaseUser;
  error?: string;
  error_description?: string;
  message?: string;
}

interface SupabaseUser {
  id: string;
  email?: string;
  email_confirmed_at?: string | null;
  user_metadata?: Record<string, unknown>;
  app_metadata?: Record<string, unknown>;
}

export interface Principal extends AuthenticatedUser {
  userId: string;
  tenantId: string;
  tenantRef: string;
  subject: string;
}

export interface AuthResult {
  authenticated: boolean;
  confirmationRequired: boolean;
  expiresIn?: number;
  user?: AuthenticatedUser;
}

export class AuthService {
  private jwks?: ReturnType<typeof createRemoteJWKSet>;
  private readonly encryptionKey: Buffer;

  constructor(
    private readonly config: ApiConfig,
    private readonly database: Database,
  ) {
    this.encryptionKey = decodeEncryptionKey(config.sessionEncryptionKey);
  }

  async signIn(
    email: string,
    password: string,
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<AuthResult> {
    const tokens = await this.authRequest('/auth/v1/token?grant_type=password', {
      email: email.trim().toLowerCase(),
      password,
    });
    if (!tokens.access_token || !tokens.refresh_token) {
      throw authError('INVALID_LOGIN_CREDENTIALS', 401);
    }
    const principal = await this.establishSession(tokens, request, reply);
    return {
      authenticated: true,
      confirmationRequired: false,
      expiresIn: Math.max(60, tokens.expires_in ?? 3600),
      user: principal,
    };
  }

  async signUp(
    email: string,
    password: string,
    displayName: string,
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<AuthResult> {
    const tokens = await this.authRequest('/auth/v1/signup', {
      email: email.trim().toLowerCase(),
      password,
      data: { display_name: displayName.trim() },
    });
    if (!tokens.access_token || !tokens.refresh_token) {
      return { authenticated: false, confirmationRequired: true };
    }
    const principal = await this.establishSession(tokens, request, reply);
    return {
      authenticated: true,
      confirmationRequired: false,
      expiresIn: Math.max(60, tokens.expires_in ?? 3600),
      user: principal,
    };
  }

  async principal(request: FastifyRequest): Promise<Principal>;
  async principal(request: FastifyRequest, required: true): Promise<Principal>;
  async principal(request: FastifyRequest, required: false): Promise<Principal | null>;
  async principal(request: FastifyRequest, required = true): Promise<Principal | null> {
    const authorization = request.headers.authorization;
    const token = authorization?.startsWith('Bearer ')
      ? authorization.slice(7)
      : request.cookies.zoryqon_access;
    if (!token) {
      if (required) throw authError('AUTHENTICATION_REQUIRED', 401);
      return null;
    }
    const claims = await this.verifyToken(token).catch(() => {
      throw authError('INVALID_ACCESS_TOKEN', 401);
    });
    const subject = claims.sub;
    if (!subject) throw authError('INVALID_ACCESS_TOKEN', 401);

    const sessionRef = request.cookies.zoryqon_session;
    if (!authorization && sessionRef) {
      const session = await this.database.query<{ mfa_verified: boolean }>(
        `select s.mfa_verified from public.user_sessions s
         join public.users u on u.id = s.user_id
         where s.session_ref = $1
           and (u.supabase_user_id::text = $2 or u.oidc_subject = $2)
           and s.revoked_at is null and s.expires_at > clock_timestamp()`,
        [sessionRef, subject],
      );
      if (!session.rows[0]) throw authError('SESSION_REVOKED', 401);
      const principal = await this.loadPrincipal(subject);
      return { ...principal, mfaVerified: session.rows[0].mfa_verified };
    }

    const principal = await this.provisionOrLoadUser(claims);
    return { ...principal, mfaVerified: hasStrongAuthentication(claims) };
  }

  verifyCsrf(request: FastifyRequest): void {
    if (request.headers.authorization?.startsWith('Bearer ')) return;
    const cookie = request.cookies.zoryqon_csrf;
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
    if (!principal.permissions.includes('*') && !principal.permissions.includes(permission)) {
      throw authError('PERMISSION_DENIED', 403);
    }
  }

  async logout(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const sessionRef = request.cookies.zoryqon_session;
    if (sessionRef) {
      await this.database.query(
        'update public.user_sessions set revoked_at = clock_timestamp() where session_ref = $1',
        [sessionRef],
      );
    }
    const token = request.headers.authorization?.startsWith('Bearer ')
      ? request.headers.authorization.slice(7)
      : request.cookies.zoryqon_access;
    if (token) {
      await fetch(`${this.config.supabase.url}/auth/v1/logout`, {
        method: 'POST',
        headers: {
          apikey: this.config.supabase.publishableKey,
          authorization: `Bearer ${token}`,
        },
        signal: AbortSignal.timeout(10_000),
      }).catch(() => undefined);
    }
    clearAuthCookies(reply);
  }

  async refresh(request: FastifyRequest, reply: FastifyReply): Promise<{ expiresIn: number }> {
    const sessionRef = request.cookies.zoryqon_session;
    if (!sessionRef) throw authError('AUTHENTICATION_REQUIRED', 401);
    return this.database.transaction({}, async (client) => {
      const result = await client.query<{
        refresh_token_ciphertext: Buffer;
        subject: string;
      }>(
        `select s.refresh_token_ciphertext,
          coalesce(u.supabase_user_id::text, u.oidc_subject) as subject
         from public.user_sessions s join public.users u on u.id = s.user_id
         where s.session_ref = $1 and s.revoked_at is null
           and s.expires_at > clock_timestamp()
           and s.refresh_token_ciphertext is not null
         for update of s`,
        [sessionRef],
      );
      const session = result.rows[0];
      if (!session) throw authError('SESSION_REFRESH_UNAVAILABLE', 401);

      let tokens: SupabaseTokenResponse;
      try {
        tokens = await this.authRequest('/auth/v1/token?grant_type=refresh_token', {
          refresh_token: decrypt(session.refresh_token_ciphertext, this.encryptionKey),
        });
      } catch {
        await client.query(
          'update public.user_sessions set revoked_at = clock_timestamp() where session_ref = $1',
          [sessionRef],
        );
        clearAuthCookies(reply);
        throw authError('SESSION_REFRESH_FAILED', 401);
      }
      if (!tokens.access_token) throw authError('SESSION_REFRESH_FAILED', 401);
      const claims = await this.verifyToken(tokens.access_token);
      if (claims.sub !== session.subject) throw authError('SESSION_SUBJECT_MISMATCH', 401);

      const rotatedRefresh = tokens.refresh_token;
      const expiresIn = Math.max(60, tokens.expires_in ?? 3600);
      await client.query(
        `update public.user_sessions set
          refresh_token_ciphertext = coalesce($2, refresh_token_ciphertext),
          refresh_token_hash = coalesce($3, refresh_token_hash),
          mfa_verified = $4,
          last_seen_at = clock_timestamp()
         where session_ref = $1`,
        [
          sessionRef,
          rotatedRefresh ? encrypt(rotatedRefresh, this.encryptionKey) : null,
          rotatedRefresh ? sha256(rotatedRefresh) : null,
          hasStrongAuthentication(claims),
        ],
      );
      this.setAccessCookie(reply, tokens.access_token, expiresIn);
      return { expiresIn };
    });
  }

  async providerHealth(): Promise<boolean> {
    try {
      const response = await fetch(`${this.config.supabase.url}/auth/v1/health`, {
        headers: { apikey: this.config.supabase.publishableKey },
        signal: AbortSignal.timeout(5_000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  private async establishSession(
    tokens: SupabaseTokenResponse,
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<Principal> {
    if (!tokens.access_token || !tokens.refresh_token) {
      throw authError('AUTHENTICATION_FAILED', 401);
    }
    const claims = await this.verifyToken(tokens.access_token);
    const principal = await this.provisionOrLoadUser(claims);
    const expiresIn = Math.max(60, tokens.expires_in ?? 3600);
    const sessionRef = externalRef('ses');
    await this.database.query(
      `insert into public.user_sessions
       (user_id, session_ref, refresh_token_ciphertext, refresh_token_hash,
        ip, user_agent, mfa_verified, expires_at)
       values ($1, $2, $3, $4, $5, $6, $7,
         clock_timestamp() + ($8 || ' seconds')::interval)`,
      [
        principal.userId,
        sessionRef,
        encrypt(tokens.refresh_token, this.encryptionKey),
        sha256(tokens.refresh_token),
        request.ip,
        request.headers['user-agent'] ?? null,
        hasStrongAuthentication(claims),
        this.config.sessionMaxAgeSeconds,
      ],
    );
    this.setAccessCookie(reply, tokens.access_token, expiresIn);
    const secure = this.config.environment !== 'development';
    reply.setCookie('zoryqon_session', sessionRef, {
      path: '/',
      httpOnly: true,
      secure,
      sameSite: 'lax',
      maxAge: this.config.sessionMaxAgeSeconds,
    });
    reply.setCookie('zoryqon_csrf', randomBytes(24).toString('base64url'), {
      path: '/',
      httpOnly: false,
      secure,
      sameSite: 'lax',
      maxAge: this.config.sessionMaxAgeSeconds,
    });
    return principal;
  }

  private setAccessCookie(reply: FastifyReply, token: string, expiresIn: number): void {
    reply.setCookie('zoryqon_access', token, {
      path: '/',
      httpOnly: true,
      secure: this.config.environment !== 'development',
      sameSite: 'lax',
      maxAge: expiresIn,
    });
  }

  private async authRequest(path: string, body: unknown): Promise<SupabaseTokenResponse> {
    const response = await fetch(`${this.config.supabase.url}${path}`, {
      method: 'POST',
      headers: {
        apikey: this.config.supabase.publishableKey,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    const payload = (await response.json().catch(() => ({}))) as SupabaseTokenResponse;
    if (!response.ok) {
      const message = payload.error_description ?? payload.message ?? payload.error ?? 'AUTH_FAILED';
      if (/invalid login credentials/i.test(message)) throw authError('INVALID_LOGIN_CREDENTIALS', 401);
      if (/already registered/i.test(message)) throw authError('EMAIL_ALREADY_REGISTERED', 409);
      if (/password/i.test(message)) throw authError('PASSWORD_REQUIREMENTS_NOT_MET', 400);
      throw authError('SUPABASE_AUTH_REQUEST_FAILED', response.status >= 500 ? 502 : 400);
    }
    return payload;
  }

  private async verifyToken(token: string): Promise<JWTPayload> {
    const issuer = `${this.config.supabase.url}/auth/v1`;
    try {
      this.jwks ??= createRemoteJWKSet(
        new URL(`${this.config.supabase.url}/auth/v1/.well-known/jwks.json`),
      );
      const result = await jwtVerify(token, this.jwks, {
        issuer,
        audience: this.config.supabase.jwtAudience,
        clockTolerance: 5,
      });
      return result.payload;
    } catch {
      const response = await fetch(`${this.config.supabase.url}/auth/v1/user`, {
        headers: {
          apikey: this.config.supabase.publishableKey,
          authorization: `Bearer ${token}`,
        },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw authError('INVALID_ACCESS_TOKEN', 401);
      const user = (await response.json()) as SupabaseUser;
      const decoded = decodeJwt(token);
      return {
        ...decoded,
        sub: user.id,
        email: user.email,
        email_verified: Boolean(user.email_confirmed_at),
        name: readString(user.user_metadata?.display_name) ?? readString(user.user_metadata?.name),
      };
    }
  }

  private async provisionOrLoadUser(claims: JWTPayload): Promise<Principal> {
    if (!claims.sub || !isUuid(claims.sub)) throw authError('IDENTITY_SUBJECT_REQUIRED', 401);
    const tenant = await this.database.query<{ id: string }>(
      `select id from public.tenants where tenant_ref = $1 and status = 'active'`,
      [this.config.tenantRef],
    );
    const tenantId = tenant.rows[0]?.id;
    if (!tenantId) throw authError('TENANT_NOT_ACTIVE', 503);

    const userRef = externalRef('usr');
    const email = typeof claims.email === 'string' ? claims.email.toLowerCase() : null;
    const userMetadata = asRecord(claims.user_metadata);
    const displayName =
      readString(claims.name) ??
      readString(userMetadata.display_name) ??
      readString(userMetadata.full_name) ??
      readString(claims.preferred_username) ??
      email ??
      'Zoryqon customer';

    await this.database.transaction({ tenantId }, async (client) => {
      const user = await client.query<{ id: string }>(
        `insert into public.users
         (tenant_id, user_ref, oidc_subject, supabase_user_id, account_status)
         values ($1, $2, $3, $3::uuid, 'email_pending')
         on conflict (tenant_id, supabase_user_id)
         do update set oidc_subject = excluded.oidc_subject, updated_at = clock_timestamp()
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
        if (emailOwner.rows[0]?.user_id !== userId) throw authError('EMAIL_ALREADY_LINKED', 409);
        if (claims.email_verified === true) {
          await client.query(
            `update public.user_emails set verified_at = coalesce(verified_at, clock_timestamp())
             where user_id = $1 and lower(email) = lower($2)`,
            [userId, email],
          );
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
      auth_subject: string;
      account_status: string;
      kyc_level: string;
      display_name: string;
      email: string | null;
      mfa_verified: boolean;
      roles: string[];
      permissions: string[];
    }>(
      `select u.id, u.tenant_id, t.tenant_ref, u.user_ref,
        coalesce(u.supabase_user_id::text, u.oidc_subject) as auth_subject,
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
       where (u.supabase_user_id::text = $1 or u.oidc_subject = $1)
         and u.tenant_id = (select id from public.tenants where tenant_ref = $2)
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
      subject: row.auth_subject,
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

function clearAuthCookies(reply: FastifyReply): void {
  for (const cookie of ['zoryqon_access', 'zoryqon_session', 'zoryqon_csrf']) {
    reply.clearCookie(cookie, { path: '/' });
  }
}

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
  if (claims.aal === 'aal2') return true;
  const values = Array.isArray(claims.amr) ? claims.amr : [];
  return values.some((value) => {
    const method = typeof value === 'string' ? value : readString(asRecord(value).method);
    return Boolean(method && ['mfa', 'otp', 'totp', 'webauthn', 'hwk'].includes(method));
  });
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}
