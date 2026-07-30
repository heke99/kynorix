import { loadRootEnvironment } from './load-root-env.js';
import { randomBytes } from 'node:crypto';
import pg, { type PoolClient } from 'pg';

loadRootEnvironment();

const databaseUrl = required('SUPABASE_DB_URL');
const operatorRef = required('OPERATOR_REF');
const command = process.argv[2];
if (!command) {
  throw new Error(
    'A bootstrap command is required: first-admin, asset, provider, fee-schedule, or market-template.',
  );
}

const client = new pg.Client({
  connectionString: databaseUrl,
  application_name: 'zoryqon-bootstrap',
  ssl: { rejectUnauthorized: process.env.SUPABASE_DB_SSL === 'verify-full' },
});
await client.connect();
try {
  await client.query('begin');
  await client.query('select pg_advisory_xact_lock($1)', [1_963_074_904]);
  const result = await run(command, client);
  await audit(client, command, result.resourceType, result.resourceRef, result.details);
  await client.query('commit');
  process.stdout.write(`${command} completed for ${result.resourceRef}\n`);
} catch (error) {
  await client.query('rollback');
  throw error;
} finally {
  await client.end();
}

async function run(
  value: string,
  db: PoolClient | pg.Client,
): Promise<{
  resourceType: string;
  resourceRef: string;
  details: Record<string, unknown>;
}> {
  if (value === 'first-admin') {
    const tenantRef = required('TENANT_REF');
    const supabaseUserId = required('ADMIN_SUPABASE_USER_ID');
    const userRef = required('ADMIN_USER_REF');
    const email = required('ADMIN_EMAIL').toLowerCase();
    const displayName = required('ADMIN_DISPLAY_NAME');
    const permissions = list('ADMIN_PERMISSIONS');
    if (permissions.length === 0) throw new Error('ADMIN_PERMISSIONS must not be empty.');
    const tenant = await db.query<{ id: string }>(
      `insert into public.tenants
       (tenant_ref, legal_name, status, default_country, default_timezone)
       values ($1,$2,'active',$3,$4)
       on conflict (tenant_ref) do update set legal_name = excluded.legal_name
       returning id`,
      [
        tenantRef,
        required('TENANT_LEGAL_NAME'),
        required('TENANT_COUNTRY'),
        required('TENANT_TIMEZONE'),
      ],
    );
    const tenantId = tenant.rows[0]!.id;
    const user = await db.query<{ id: string }>(
      `insert into public.users
       (tenant_id,user_ref,oidc_subject,supabase_user_id,account_status,customer_type,kyc_level)
       values ($1,$2,$3,$3::uuid,'active','institutional_customer','institution')
       on conflict (tenant_id,supabase_user_id) do update set user_ref = excluded.user_ref
       returning id`,
      [tenantId, userRef, supabaseUserId],
    );
    const userId = user.rows[0]!.id;
    await db.query(
      `insert into public.user_profiles (user_id,display_name,preferred_locale)
       values ($1,$2,'en-US')
       on conflict (user_id) do update set display_name = excluded.display_name`,
      [userId, displayName],
    );
    await db.query(
      `insert into public.user_emails (user_id,email,verified_at,is_primary)
       values ($1,$2,clock_timestamp(),true)
       on conflict (lower(email)) do nothing`,
      [userId, email],
    );
    await db.query(
      `insert into public.roles (role_key,staff_role,description)
       values ('platform_super_admin',true,'Explicitly bootstrapped platform administrator')
       on conflict (role_key) do update set description = excluded.description`,
    );
    for (const permission of permissions) {
      await db.query(
        `insert into public.role_permissions (role_key,permission_key)
         values ('platform_super_admin',$1) on conflict do nothing`,
        [permission],
      );
    }
    await db.query(
      `insert into public.user_roles (user_id,role_key,granted_by)
       values ($1,'platform_super_admin',$1) on conflict do nothing`,
      [userId],
    );
    return {
      resourceType: 'user',
      resourceRef: userRef,
      details: { tenantRef, email, permissionCount: permissions.length },
    };
  }

  if (value === 'asset') {
    const assetRef = required('ASSET_REF');
    const asset = await db.query<{ id: string }>(
      `insert into public.assets
       (asset_ref,symbol,display_name,decimals,asset_type,enabled)
       values ($1,$2,$3,$4,$5,$6)
       on conflict (asset_ref) do update set display_name = excluded.display_name,
         enabled = excluded.enabled returning id`,
      [
        assetRef,
        required('ASSET_SYMBOL'),
        required('ASSET_NAME'),
        integer('ASSET_DECIMALS'),
        required('ASSET_TYPE'),
        boolean('ASSET_ENABLED'),
      ],
    );
    const assetId = asset.rows[0]!.id;
    await db.query(
      `insert into public.ledger_accounts
       (tenant_id,account_ref,owner_user_id,asset_id,account_type,normal_side)
       select t.id, 'acct:platform:' || lower($2) || ':' || value.account_type,
         null, $1, value.account_type, value.normal_side::public.ledger_normal_side
       from public.tenants t
       cross join (values
         ('collateral_locked','credit'),
         ('trade_clearing','debit'),
         ('settlement_payable','credit'),
         ('platform_fee_revenue','credit'),
         ('partner_fee_payable','credit'),
         ('network_fee_payable','credit'),
         ('refund_payable','credit'),
         ('chargeback_reserve','credit'),
         ('treasury_cash','debit'),
         ('treasury_crypto','debit'),
         ('reconciliation_difference','debit')
       ) as value(account_type,normal_side)
       on conflict (tenant_id,owner_user_id,asset_id,account_type) do nothing`,
      [assetId, required('ASSET_SYMBOL')],
    );
    await db.query(
      `insert into public.ledger_accounts
       (tenant_id,account_ref,owner_user_id,asset_id,account_type,normal_side)
       select u.tenant_id,
         'acct:' || u.user_ref || ':' || lower($2) || ':' || value.account_type,
         u.id, $1, value.account_type, 'credit'::public.ledger_normal_side
       from public.users u
       cross join (values
         ('customer_available'),
         ('customer_locked'),
         ('customer_pending_deposit'),
         ('customer_pending_withdrawal'),
         ('customer_asset_available'),
         ('customer_asset_locked')
       ) as value(account_type)
       on conflict (tenant_id,owner_user_id,asset_id,account_type) do nothing`,
      [assetId, required('ASSET_SYMBOL')],
    );
    return {
      resourceType: 'asset',
      resourceRef: assetRef,
      details: { symbol: required('ASSET_SYMBOL'), enabled: boolean('ASSET_ENABLED') },
    };
  }

  if (value === 'provider') {
    const providerRef = required('PROVIDER_REF');
    const providerType = required('PROVIDER_TYPE');
    const metadata = json('PROVIDER_METADATA_JSON');
    if (providerType === 'price') {
      await db.query(
        `insert into public.price_providers
         (provider_ref,name,adapter_type,licensing_metadata,enabled)
         values ($1,$2,$3,$4,$5)
         on conflict (provider_ref) do update set licensing_metadata = excluded.licensing_metadata,
           enabled = excluded.enabled`,
        [
          providerRef,
          required('PROVIDER_LEGAL_NAME'),
          required('PROVIDER_ADAPTER_TYPE'),
          metadata,
          boolean('PROVIDER_ENABLED'),
        ],
      );
    } else {
      await db.query(
        `insert into public.service_providers
         (provider_ref,provider_type,legal_name,configuration_metadata,status)
         values ($1,$2,$3,$4,'registered')
         on conflict (provider_ref) do update
         set legal_name = excluded.legal_name, configuration_metadata = excluded.configuration_metadata`,
        [providerRef, providerType, required('PROVIDER_LEGAL_NAME'), metadata],
      );
    }
    return {
      resourceType: 'provider',
      resourceRef: providerRef,
      details: { providerType },
    };
  }

  if (value === 'fee-schedule') {
    const tenantId = await activeTenant(db, required('TENANT_REF'));
    const approverId = await userId(db, tenantId, required('APPROVER_USER_REF'));
    const scheduleRef = required('FEE_SCHEDULE_REF');
    const version = integer('FEE_SCHEDULE_VERSION');
    const schedule = await db.query<{ id: string }>(
      `insert into public.fee_schedules
       (tenant_id,fee_schedule_ref,version,status,effective_from,approved_by)
       values ($1,$2,$3,'active',$4,$5)
       on conflict (tenant_id,fee_schedule_ref,version) do nothing returning id`,
      [tenantId, scheduleRef, version, required('FEE_EFFECTIVE_FROM'), approverId],
    );
    if (!schedule.rows[0]) throw new Error('The fee schedule version already exists.');
    const rule = json('FEE_RULE_JSON') as Record<string, unknown>;
    await db.query(
      `insert into public.fee_rules
       (fee_schedule_id,fee_type,maker_basis_points,taker_basis_points,flat_atoms,
        product_ref,market_ref,customer_tier,country,asset_symbol,volume_from_atoms)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        schedule.rows[0].id,
        stringValue(rule, 'feeType'),
        numberValue(rule, 'makerBasisPoints'),
        numberValue(rule, 'takerBasisPoints'),
        stringValue(rule, 'flatAtoms'),
        nullableString(rule, 'productRef'),
        nullableString(rule, 'marketRef'),
        nullableString(rule, 'customerTier'),
        nullableString(rule, 'country'),
        nullableString(rule, 'assetSymbol'),
        nullableString(rule, 'volumeFromAtoms'),
      ],
    );
    return {
      resourceType: 'fee_schedule',
      resourceRef: `${scheduleRef}:${version}`,
      details: { tenantRef: required('TENANT_REF') },
    };
  }

  if (value === 'market-template') {
    const tenantId = await activeTenant(db, required('TENANT_REF'));
    const approverId = await userId(db, tenantId, required('APPROVER_USER_REF'));
    const templateRef = required('MARKET_TEMPLATE_REF');
    const templateVersion = integer('MARKET_TEMPLATE_VERSION');
    await db.query(
      `insert into public.market_templates
       (tenant_id,template_ref,version,product_definition_id,category_id,title_pattern,
        question_pattern,rule_definition,price_index_ref,status,approved_by,approved_at)
       select $1,$2,$3,pd.id,mc.id,$4,$5,$6,$7,'approved',$8,clock_timestamp()
       from public.product_definitions pd cross join public.market_categories mc
       where pd.product_ref = $9 and pd.status = 'approved'
         and mc.category_ref = $10 and mc.enabled
       order by pd.version desc limit 1`,
      [
        tenantId,
        templateRef,
        templateVersion,
        required('MARKET_TITLE_PATTERN'),
        required('MARKET_QUESTION_PATTERN'),
        json('MARKET_RULE_DEFINITION_JSON'),
        optional('PRICE_INDEX_REF'),
        approverId,
        required('PRODUCT_REF'),
        required('CATEGORY_REF'),
      ],
    );
    return {
      resourceType: 'market_template',
      resourceRef: `${templateRef}:${templateVersion}`,
      details: { tenantRef: required('TENANT_REF') },
    };
  }

  throw new Error(`Unsupported bootstrap command: ${value}`);
}

async function audit(
  db: PoolClient | pg.Client,
  action: string,
  resourceType: string,
  resourceRef: string,
  details: Record<string, unknown>,
): Promise<void> {
  await db.query(
    `insert into public.audit_log
     (event_ref,actor_ref,actor_roles,action,resource_type,resource_ref,new_value,occurred_at)
     values ($1,$2,array['operator'],$3,$4,$5,$6,clock_timestamp())`,
    [
      `aud_${randomBytes(12).toString('hex')}`,
      operatorRef,
      `bootstrap.${action}`,
      resourceType,
      resourceRef,
      details,
    ],
  );
}

async function activeTenant(db: PoolClient | pg.Client, tenantRef: string): Promise<string> {
  const result = await db.query<{ id: string }>(
    `select id from public.tenants where tenant_ref = $1 and status = 'active'`,
    [tenantRef],
  );
  if (!result.rows[0]) throw new Error('The tenant is not active.');
  return result.rows[0].id;
}

async function userId(
  db: PoolClient | pg.Client,
  tenantId: string,
  userRef: string,
): Promise<string> {
  const result = await db.query<{ id: string }>(
    'select id from public.users where tenant_id = $1 and user_ref = $2',
    [tenantId, userRef],
  );
  if (!result.rows[0]) throw new Error('The approving user was not found.');
  return result.rows[0].id;
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}
function optional(name: string): string | null {
  return process.env[name]?.trim() || null;
}
function integer(name: string): number {
  const value = Number(required(name));
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error(`${name} must be a non-negative integer.`);
  return value;
}
function boolean(name: string): boolean {
  const value = required(name);
  if (!['true', 'false'].includes(value)) throw new Error(`${name} must be true or false.`);
  return value === 'true';
}
function list(name: string): string[] {
  return required(name)
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}
function json(name: string): unknown {
  try {
    return JSON.parse(required(name)) as unknown;
  } catch {
    throw new Error(`${name} must be valid JSON.`);
  }
}
function stringValue(value: Record<string, unknown>, key: string): string {
  const item = value[key];
  if (typeof item !== 'string' || item.length === 0) throw new Error(`${key} must be a string.`);
  return item;
}
function nullableString(value: Record<string, unknown>, key: string): string | null {
  const item = value[key];
  if (item === undefined || item === null || item === '') return null;
  if (typeof item !== 'string') throw new Error(`${key} must be a string or null.`);
  return item;
}
function numberValue(value: Record<string, unknown>, key: string): number {
  const item = value[key];
  if (typeof item !== 'number' || !Number.isSafeInteger(item) || item < 0) {
    throw new Error(`${key} must be a non-negative integer.`);
  }
  return item;
}
