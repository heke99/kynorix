import { loadRootEnvironment } from './load-root-env.js';
import { createHash } from 'node:crypto';
import pg, { type PoolClient } from 'pg';
import { z } from 'zod';

loadRootEnvironment();

const optionalUrl = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
  z.string().url().optional(),
);
const optionalSecret = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
  z.string().min(1).optional(),
);
const EnvironmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
  SUPABASE_DB_URL: z.string().url(),
  SUPABASE_DB_SSL: z.enum(['require', 'verify-full']).default('require'),
  PRICE_PROVIDER_BASE_URL: optionalUrl,
  PRICE_PROVIDER_API_KEY: optionalSecret,
  NOTIFICATION_PROVIDER_BASE_URL: optionalUrl,
  NOTIFICATION_PROVIDER_API_KEY: optionalSecret,
  WORKER_POLL_INTERVAL_MS: z.coerce.number().int().min(250).max(60_000).default(1_000),
});
const ScheduledMarketDefinitionSchema = z.object({
  feeScheduleRef: z.string().min(1),
  jurisdictionPolicyRef: z.string().min(1),
  collateralAsset: z.string().min(1),
  displayTimezone: z.string().min(1),
  openOffsetMinutes: z.number().int().min(0).default(0),
  tradingDurationMinutes: z.number().int().positive(),
  resolutionOffsetMinutes: z.number().int().min(0),
  scheduleIntervalMinutes: z.number().int().min(5).default(1_440),
  payoutAtoms: z.string().regex(/^[1-9]\d*$/),
  tickAtoms: z.string().regex(/^[1-9]\d*$/),
  minimumOrderQuantity: z.string().regex(/^[1-9]\d*$/),
  maximumPositionQuantity: z.string().regex(/^[1-9]\d*$/),
  riskClass: z.enum(['low', 'standard', 'high', 'restricted']),
  outcomes: z.array(z.object({ label: z.string().min(1).max(100) })).length(2),
  rules: z.string().min(50),
  primarySource: z.string().url(),
  backupSource: z.string().url().optional(),
});
const parsed = EnvironmentSchema.safeParse(process.env);
if (!parsed.success) {
  throw new Error(
    `Invalid or missing worker configuration: ${parsed.error.issues
      .map((issue) => issue.path.join('.'))
      .join(', ')}`,
  );
}
const config = parsed.data;
assertProviderPair(
  'PRICE_PROVIDER',
  config.PRICE_PROVIDER_BASE_URL,
  config.PRICE_PROVIDER_API_KEY,
  config.NODE_ENV === 'production',
);
assertProviderPair(
  'NOTIFICATION_PROVIDER',
  config.NOTIFICATION_PROVIDER_BASE_URL,
  config.NOTIFICATION_PROVIDER_API_KEY,
  config.NODE_ENV === 'production',
);
if (config.NODE_ENV === 'production') {
  assertProductionEndpoint('PRICE_PROVIDER_BASE_URL', config.PRICE_PROVIDER_BASE_URL!);
  assertProductionEndpoint(
    'NOTIFICATION_PROVIDER_BASE_URL',
    config.NOTIFICATION_PROVIDER_BASE_URL!,
  );
}
const { Pool } = pg;
const pool = new Pool({
  connectionString: config.SUPABASE_DB_URL,
  application_name: 'zoryqon-worker',
  ssl: { rejectUnauthorized: config.SUPABASE_DB_SSL === 'verify-full' },
});
const workerRef = `${process.env.HOSTNAME ?? 'worker'}:${process.pid}`;

let stopping = false;
const stop = () => {
  stopping = true;
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);

while (!stopping) {
  const startedAt = Date.now();
  await Promise.all([
    runJob('price-ingestion', ingestPrices),
    runJob('price-index-calculation', calculatePriceIndexes),
    runJob('market-scheduling', generateScheduledMarkets),
    runJob('market-opening', openScheduledMarkets),
    runJob('market-closing', closeExpiredMarkets),
    runJob('resolution-finalisation', finaliseApprovedResolutions),
    runJob('market-settlement', settleResolvedMarkets),
    runJob('outbox-publication', publishOutbox),
    runJob('notification-delivery', deliverNotifications),
    runJob('reconciliation', runReconciliation),
  ]);
  const remaining = Math.max(0, config.WORKER_POLL_INTERVAL_MS - (Date.now() - startedAt));
  await new Promise((resolve) => setTimeout(resolve, remaining));
}

await pool.end();

async function ingestPrices(): Promise<void> {
  if (!config.PRICE_PROVIDER_BASE_URL || !config.PRICE_PROVIDER_API_KEY) return;
  const jobs = await pool.query<{
    provider_id: string;
    instrument_id: string;
    provider_ref: string;
    source_symbol: string;
    normalized_symbol: string;
  }>(
    `select pp.id as provider_id, pi.id as instrument_id, pp.provider_ref,
      pi.normalized_symbol as source_symbol, pi.normalized_symbol
     from public.price_providers pp cross join public.price_instruments pi
     where pp.enabled`,
  );
  for (const job of jobs.rows) {
    try {
      const response = await fetch(
        new URL(
          `/v1/prices/${encodeURIComponent(job.source_symbol)}`,
          config.PRICE_PROVIDER_BASE_URL,
        ),
        {
          headers: { authorization: `Bearer ${config.PRICE_PROVIDER_API_KEY}` },
          signal: AbortSignal.timeout(5_000),
        },
      );
      if (!response.ok) throw new Error('Price provider request failed.');
      const value = z
        .object({
          bid_atomic: z.string().regex(/^\d+$/).nullable(),
          ask_atomic: z.string().regex(/^\d+$/).nullable(),
          last_atomic: z.string().regex(/^\d+$/).nullable(),
          volume_atomic: z.string().regex(/^\d+$/).nullable(),
          source_timestamp: z.string().datetime(),
          sequence: z.string().min(1),
        })
        .parse(await response.json());
      const sourceTime = Date.parse(value.source_timestamp);
      const delay = Date.now() - sourceTime;
      const status = delay > 30_000 ? 'stale' : delay < -5_000 ? 'excluded' : 'healthy';
      await withTransaction(async (client) => {
        await client.query(
          `insert into public.price_observations
           (provider_id, instrument_id, source_symbol, bid_atoms, ask_atoms, last_atoms,
            volume_atoms, source_timestamp, provider_sequence, status)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
           on conflict do nothing`,
          [
            job.provider_id,
            job.instrument_id,
            job.source_symbol,
            value.bid_atomic,
            value.ask_atomic,
            value.last_atomic,
            value.volume_atomic,
            value.source_timestamp,
            value.sequence,
            status,
          ],
        );
        await client.query(
          `insert into public.price_feed_health
           (provider_id, instrument_id, status, last_observation_at, delay_milliseconds)
           values ($1,$2,$3,$4,$5)
           on conflict (provider_id,instrument_id) do update
           set status = excluded.status, last_observation_at = excluded.last_observation_at,
             delay_milliseconds = excluded.delay_milliseconds,
             consecutive_failures = case when excluded.status = 'healthy' then 0
               else public.price_feed_health.consecutive_failures + 1 end,
             updated_at = clock_timestamp()`,
          [job.provider_id, job.instrument_id, status, value.source_timestamp, delay],
        );
      });
    } catch {
      await pool.query(
        `insert into public.price_feed_health
         (provider_id, instrument_id, status, consecutive_failures, reason)
         values ($1,$2,'disconnected',1,'provider request failed')
         on conflict (provider_id,instrument_id) do update
         set status = 'disconnected',
           consecutive_failures = public.price_feed_health.consecutive_failures + 1,
           reason = excluded.reason, updated_at = clock_timestamp()`,
        [job.provider_id, job.instrument_id],
      );
    }
  }
}

async function generateScheduledMarkets(): Promise<void> {
  const due = await pool.query<{ id: string }>(
    `select mts.id from public.market_template_schedules mts
     join public.market_templates mt on mt.id = mts.market_template_id
     where mts.enabled and mt.status = 'approved'
       and mts.next_run_at <= clock_timestamp()
       and (mts.locked_at is null or mts.locked_at < clock_timestamp() - interval '10 minutes')
     order by mts.next_run_at limit 20`,
  );
  for (const schedule of due.rows) {
    let job:
      | {
          run_id: string;
          tenant_id: string;
          scheduled_for: string;
          template_id: string;
          title_pattern: string;
          question_pattern: string;
          product_definition_id: string;
          category_id: string;
          price_index_ref: string | null;
          rule_definition: unknown;
          approved_by: string;
        }
      | undefined;
    try {
      job = await withTransaction(async (client) => {
        const claimed = await client.query<{
          tenant_id: string;
          scheduled_for: string;
          template_id: string;
          title_pattern: string;
          question_pattern: string;
          product_definition_id: string;
          category_id: string;
          price_index_ref: string | null;
          rule_definition: unknown;
          approved_by: string;
        }>(
          `select mt.tenant_id,mts.next_run_at::text as scheduled_for,
            mt.id as template_id,mt.title_pattern,mt.question_pattern,
            mt.product_definition_id,mt.category_id,mt.price_index_ref,
            mt.rule_definition,mt.approved_by
           from public.market_template_schedules mts
           join public.market_templates mt on mt.id = mts.market_template_id
           where mts.id = $1 and mts.enabled and mt.status = 'approved'
             and mt.approved_by is not null and mts.next_run_at <= clock_timestamp()
             and (mts.locked_at is null
               or mts.locked_at < clock_timestamp() - interval '10 minutes')
           for update of mts`,
          [schedule.id],
        );
        const row = claimed.rows[0];
        if (!row) return undefined;
        await setTenantContext(client, row.tenant_id);
        const run = await client.query<{ id: string }>(
          `insert into public.market_schedule_runs
           (schedule_id,tenant_id,scheduled_for,status,worker_ref)
           values ($1,$2,$3,'processing',$4)
           on conflict (schedule_id,scheduled_for) do nothing returning id`,
          [schedule.id, row.tenant_id, row.scheduled_for, workerRef],
        );
        if (!run.rows[0]) return undefined;
        await client.query(
          `update public.market_template_schedules
           set locked_at = clock_timestamp(),locked_by = $2,
             last_scheduled_for = $3,last_run_at = clock_timestamp(),
             last_run_status = 'processing',last_error = null,
             run_attempt_count = run_attempt_count + 1,
             next_run_at = $3::timestamptz + make_interval(mins =>
               case when (select rule_definition->>'scheduleIntervalMinutes'
                          from public.market_templates where id = market_template_id)
                          ~ '^[0-9]+$'
                 then greatest(5,(select (rule_definition->>'scheduleIntervalMinutes')::integer
                                  from public.market_templates where id = market_template_id))
                 else 1440 end)
           where id = $1`,
          [schedule.id, workerRef, row.scheduled_for],
        );
        return { ...row, run_id: run.rows[0].id };
      });
      if (!job) continue;
      const definition = ScheduledMarketDefinitionSchema.parse(job.rule_definition);
      await materialiseScheduledMarket(schedule.id, job, definition);
    } catch (error) {
      if (job) {
        await markScheduleFailure(
          schedule.id,
          job.run_id,
          job.tenant_id,
          error instanceof Error ? error.message : 'Scheduled market materialisation failed.',
        );
      }
    }
  }
}

async function materialiseScheduledMarket(
  scheduleId: string,
  job: {
    run_id: string;
    tenant_id: string;
    scheduled_for: string;
    template_id: string;
    title_pattern: string;
    question_pattern: string;
    product_definition_id: string;
    category_id: string;
    price_index_ref: string | null;
    approved_by: string;
  },
  definition: z.infer<typeof ScheduledMarketDefinitionSchema>,
): Promise<void> {
  await withTransaction(async (client) => {
    await setTenantContext(client, job.tenant_id);
    const run = await client.query(
      `select 1 from public.market_schedule_runs
       where id = $1 and tenant_id = $2 and status = 'processing' for update`,
      [job.run_id, job.tenant_id],
    );
    if (!run.rowCount) return;
    const references = await client.query<{
      policy_id: string;
      fee_id: string;
      asset_id: string;
      creator_id: string;
    }>(
      `select jp.id as policy_id,fs.id as fee_id,a.id as asset_id,u.id as creator_id
       from public.jurisdiction_policies jp
       cross join public.fee_schedules fs
       cross join public.assets a
       join lateral (
         select candidate.id from public.users candidate
         where candidate.tenant_id = $1 and candidate.account_status = 'active'
           and candidate.id <> $2
           and exists (
             select 1 from public.user_roles ur
             join public.roles r on r.role_key = ur.role_key
             where ur.user_id = candidate.id and ur.revoked_at is null and r.staff_role
           )
         order by candidate.created_at limit 1
       ) u on true
       where jp.policy_ref = $3 and jp.status = 'active'
         and fs.tenant_id = $1 and fs.fee_schedule_ref = $4 and fs.status = 'active'
         and a.symbol = $5 and a.enabled
       order by jp.version desc,fs.version desc limit 1`,
      [
        job.tenant_id,
        job.approved_by,
        definition.jurisdictionPolicyRef,
        definition.feeScheduleRef,
        definition.collateralAsset,
      ],
    );
    const refs = references.rows[0];
    if (!refs) throw new Error('Scheduled market references or independent creator are missing.');
    const scheduledFor = new Date(job.scheduled_for);
    const opensAt = new Date(scheduledFor.getTime() + definition.openOffsetMinutes * 60_000);
    const closesAt = new Date(opensAt.getTime() + definition.tradingDurationMinutes * 60_000);
    const resolutionAt = new Date(
      closesAt.getTime() + definition.resolutionOffsetMinutes * 60_000,
    );
    const date = scheduledFor.toISOString().slice(0, 10);
    const title = job.title_pattern.replaceAll('{{date}}', date);
    const question = job.question_pattern.replaceAll('{{date}}', date);
    const marketRef = deterministicRef('mkt', job.run_id);
    const market = await client.query<{ id: string }>(
      `insert into public.markets
       (tenant_id,market_ref,product_definition_id,category_id,template_id,
        jurisdiction_policy_id,fee_schedule_id,title,question,display_timezone,
        opens_at,closes_at,resolution_at,collateral_asset_id,payout_atoms,tick_atoms,
        minimum_order_quantity,maximum_position_quantity,risk_class,status,
        immutable_rule_version,approval_state,created_by,approved_by,approved_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,
         $19,'scheduled',$20,'approved',$21,$22,clock_timestamp())
       returning id`,
      [
        job.tenant_id,
        marketRef,
        job.product_definition_id,
        job.category_id,
        job.template_id,
        refs.policy_id,
        refs.fee_id,
        title,
        question,
        definition.displayTimezone,
        opensAt.toISOString(),
        closesAt.toISOString(),
        resolutionAt.toISOString(),
        refs.asset_id,
        definition.payoutAtoms,
        definition.tickAtoms,
        definition.minimumOrderQuantity,
        definition.maximumPositionQuantity,
        definition.riskClass,
        `template:${job.template_id}:${job.run_id}`,
        refs.creator_id,
        job.approved_by,
      ],
    );
    const marketId = market.rows[0]!.id;
    await client.query(
      `insert into public.market_rules
       (market_id,version,rules,tie_behavior,cancellation_behavior,void_behavior,content_hash)
       values ($1,1,$2,'void','cancel_open_orders','refund_collateral',$3)`,
      [marketId, definition.rules, sha256(definition.rules)],
    );
    await client.query(
      `insert into public.market_sources
       (market_id,source_type,source_uri,source_name,priority)
       values ($1,'primary',$2,'Primary resolution source',1)`,
      [marketId, definition.primarySource],
    );
    if (definition.backupSource) {
      await client.query(
        `insert into public.market_sources
         (market_id,source_type,source_uri,source_name,priority)
         values ($1,'backup',$2,'Backup resolution source',2)`,
        [marketId, definition.backupSource],
      );
    }
    if (job.price_index_ref) {
      const index = await client.query(
        `select 1 from public.price_indexes where index_ref = $1 and status = 'active'`,
        [job.price_index_ref],
      );
      if (!index.rowCount) throw new Error('The template price index is not active.');
      await client.query(
        `insert into public.market_sources
         (market_id,source_type,source_uri,source_name,priority)
         values ($1,'price_index',$2,'Approved price index',1)`,
        [marketId, job.price_index_ref],
      );
    }
    for (const [index, outcome] of definition.outcomes.entries()) {
      const inserted = await client.query<{ id: string }>(
        `insert into public.market_outcomes
         (tenant_id,market_id,outcome_ref,label,display_order)
         values ($1,$2,$3,$4,$5) returning id`,
        [job.tenant_id, marketId, deterministicRef('out', `${job.run_id}:${index}`), outcome.label, index],
      );
      await client.query(
        `insert into public.market_book_sequences (market_id,outcome_id) values ($1,$2)`,
        [marketId, inserted.rows[0]!.id],
      );
    }
    await client.query(
      `insert into public.market_versions (market_id,version,snapshot,content_hash,created_by)
       values ($1,1,$2,$3,$4)`,
      [marketId, definition, sha256(JSON.stringify(definition)), refs.creator_id],
    );
    await client.query(
      `insert into public.market_status_events
       (market_id,from_status,to_status,actor_id,reason)
       values
        ($1,null,'draft',$2,'Materialised from an approved schedule.'),
        ($1,'draft','under_review',$2,'Submitted by the scheduled-market service.'),
        ($1,'under_review','approved',$3,'Inherited independent template approval.'),
        ($1,'approved','scheduled',$3,'Scheduled occurrence created atomically.')`,
      [marketId, refs.creator_id, job.approved_by],
    );
    await client.query(
      `update public.market_schedule_runs
       set status = 'succeeded',market_id = $2,completed_at = clock_timestamp(),last_error = null
       where id = $1`,
      [job.run_id, marketId],
    );
    await client.query(
      `update public.market_template_schedules
       set last_run_status = 'succeeded',last_error = null,locked_at = null,locked_by = null
       where id = $1 and locked_by = $2`,
      [scheduleId, workerRef],
    );
    await client.query(
      `insert into public.audit_log
       (tenant_id,event_ref,actor_ref,actor_roles,action,resource_type,resource_ref,new_value)
       values ($1,$2,'market-scheduler',array['service'],'market.schedule.materialised',
         'market',$3,jsonb_build_object('schedule_id',$4,'scheduled_for',$5))`,
      [
        job.tenant_id,
        deterministicRef('aud', job.run_id),
        marketRef,
        scheduleId,
        job.scheduled_for,
      ],
    );
  });
}

async function markScheduleFailure(
  scheduleId: string,
  runId: string,
  tenantId: string,
  message: string,
): Promise<void> {
  await withTransaction(async (client) => {
    await setTenantContext(client, tenantId);
    await client.query(
      `update public.market_schedule_runs
       set status = 'failed',completed_at = clock_timestamp(),last_error = left($2,2000)
       where id = $1 and status = 'processing'`,
      [runId, message],
    );
    await client.query(
      `update public.market_template_schedules
       set last_run_status = 'failed',last_error = left($2,2000),
         locked_at = null,locked_by = null
       where id = $1`,
      [scheduleId, message],
    );
  });
}

async function calculatePriceIndexes(): Promise<void> {
  await withTransaction(async (client) => {
    await client.query(
      `with latest as (
         select distinct on (po.provider_id, po.instrument_id)
           po.id, po.provider_id, po.instrument_id, po.last_atoms,
           po.source_timestamp, po.received_timestamp
         from public.price_observations po
         where po.last_atoms is not null
         order by po.provider_id, po.instrument_id, po.source_timestamp desc
       ),
       medians as (
         select instrument_id,
           percentile_disc(0.5) within group (order by last_atoms) as median_atoms
         from latest
         where source_timestamp >= clock_timestamp() - interval '30 seconds'
         group by instrument_id
       ),
       thresholds as (
         select instrument_id, max(outlier_basis_points) as outlier_basis_points
         from public.price_indexes where status = 'active' group by instrument_id
       )
       update public.price_observations po set status = case
         when l.source_timestamp < clock_timestamp() - interval '30 seconds'
           then 'stale'::public.feed_status
         when m.median_atoms > 0 and
           abs(l.last_atoms - m.median_atoms) * 10000 / m.median_atoms > t.outlier_basis_points
           then 'outlier'::public.feed_status
         else 'healthy'::public.feed_status end
       from latest l
       left join medians m on m.instrument_id = l.instrument_id
       left join thresholds t on t.instrument_id = l.instrument_id
       where po.id = l.id`,
    );
    await client.query(
      `with candidates as (
         select pix.id as price_index_id, pix.minimum_healthy_sources,
           po.id as observation_id, po.last_atoms, po.source_timestamp
         from public.price_indexes pix
         join public.price_index_components pic on pic.price_index_id = pix.id
         join lateral (
           select observation.id, observation.last_atoms, observation.source_timestamp
           from public.price_observations observation
           where observation.provider_id = pic.provider_id
             and observation.instrument_id = pix.instrument_id
             and observation.status = 'healthy' and observation.last_atoms is not null
             and observation.source_timestamp >= clock_timestamp() - interval '30 seconds'
           order by observation.source_timestamp desc limit 1
         ) po on true
         where pix.status = 'active' and pix.calculation_method = 'median'
       ),
       values_to_insert as (
         select price_index_id,
           percentile_disc(0.5) within group (order by last_atoms) as value_atoms,
           max(source_timestamp) as observed_at,
           array_agg(observation_id order by observation_id) as observation_ids,
           encode(digest(string_agg(observation_id::text || ':' || last_atoms::text,
             ',' order by observation_id), 'sha256'), 'hex') as evidence_hash
         from candidates
         group by price_index_id, minimum_healthy_sources
         having count(*) >= minimum_healthy_sources
       )
       insert into public.price_index_values
       (price_index_id,value_atoms,observed_at,component_observation_ids,evidence_hash)
       select price_index_id,value_atoms,observed_at,observation_ids,evidence_hash
       from values_to_insert on conflict do nothing`,
    );
  });
}

async function openScheduledMarkets(): Promise<void> {
  const due = await pool.query<{
    tenant_id: string;
    market_ref: string;
    approved_by: string;
  }>(
    `select m.tenant_id,m.market_ref,m.approved_by
     from public.markets m
     join public.product_definitions pd on pd.id = m.product_definition_id
     where m.status = 'scheduled' and m.approved_by is not null
       and m.opens_at <= clock_timestamp() and m.closes_at > clock_timestamp()
       and not exists (
         select 1 from public.reconciliation_cases rc
         join public.reconciliation_items ri on ri.id = rc.reconciliation_item_id
         join public.reconciliation_runs rr on rr.id = ri.reconciliation_run_id
         where rr.tenant_id = m.tenant_id and rc.status <> 'resolved'
           and rc.blocks_publication
       )
       and (
         pd.product_type <> 'price_event_contract'
         or exists (
           select 1 from public.market_sources ms
           join public.price_indexes pix on pix.index_ref = ms.source_uri
           join lateral (
             select observed_at from public.price_index_values piv
             where piv.price_index_id = pix.id
             order by observed_at desc limit 1
           ) value on value.observed_at >= clock_timestamp() - interval '30 seconds'
           where ms.market_id = m.id and ms.source_type = 'price_index'
             and pix.status = 'active'
         )
       )
     order by m.opens_at limit 100`,
  );
  for (const market of due.rows) {
    await withTransaction(async (client) => {
      await setTenantContext(client, market.tenant_id);
      const locked = await client.query(
        `select 1 from public.markets where tenant_id = $1 and market_ref = $2
         and status = 'scheduled' for update`,
        [market.tenant_id, market.market_ref],
      );
      if (!locked.rowCount) return;
      await client.query('select public.transition_market($1,$2,$3,$4,$5)', [
        market.tenant_id,
        market.market_ref,
        'pre_open',
        market.approved_by,
        'The approved opening time was reached.',
      ]);
      await client.query('select public.transition_market($1,$2,$3,$4,$5)', [
        market.tenant_id,
        market.market_ref,
        'open',
        market.approved_by,
        'Trading opened after policy and dependency checks.',
      ]);
    });
  }
}

async function closeExpiredMarkets(): Promise<void> {
  const due = await pool.query<{
    tenant_id: string;
    market_ref: string;
    actor_id: string;
  }>(
    `select tenant_id,market_ref,coalesce(approved_by,created_by) as actor_id
     from public.markets
     where status in ('open','suspended') and closes_at <= clock_timestamp()
     order by closes_at limit 50`,
  );
  for (const market of due.rows) {
    try {
      await withTransaction(async (client) => {
        await setTenantContext(client, market.tenant_id);
        const lockedMarket = await client.query<{
          id: string;
          asset_id: string;
          status: string;
        }>(
          `select id,collateral_asset_id as asset_id,status::text
           from public.markets
           where tenant_id = $1 and market_ref = $2
             and status in ('open','suspended') and closes_at <= clock_timestamp()
           for update`,
          [market.tenant_id, market.market_ref],
        );
        const current = lockedMarket.rows[0];
        if (!current) return;
        await client.query('select public.transition_market($1,$2,$3,$4,$5)', [
          market.tenant_id,
          market.market_ref,
          'closing',
          market.actor_id,
          'The approved trading window ended.',
        ]);
        const orders = await client.query<{
          id: string;
          order_ref: string;
          user_id: string;
          market_id: string;
          outcome_id: string;
          side: 'buy' | 'sell';
          amount_atoms: string;
          quantity: string;
        }>(
          `select o.id,o.order_ref,o.user_id,o.market_id,o.outcome_id,o.side::text,
            cr.amount_atoms::text,cr.quantity::text
           from public.orders o
           join public.collateral_reservations cr on cr.order_id = o.id
           where o.market_id = $1 and o.status in ('open','partially_filled')
           order by o.book_sequence for update of o,cr`,
          [current.id],
        );
        for (const order of orders.rows) {
          if (order.side === 'buy' && BigInt(order.amount_atoms) > 0n) {
            const locked = await workerLedgerAccount(
              client,
              market.tenant_id,
              order.user_id,
              current.asset_id,
              'customer_locked',
            );
            const available = await workerLedgerAccount(
              client,
              market.tenant_id,
              order.user_id,
              current.asset_id,
              'customer_available',
            );
            if (!locked || !available) throw new Error('Order release accounts are incomplete.');
            await postWorkerJournal(client, {
              tenantId: market.tenant_id,
              assetId: current.asset_id,
              transactionType: 'market_close_reservation_release',
              referenceType: 'order',
              referenceRef: order.order_ref,
              idempotencyKey: `market-close-release:${order.order_ref}`,
              postings: [
                { accountId: locked.id, debitAtoms: BigInt(order.amount_atoms) },
                { accountId: available.id, creditAtoms: BigInt(order.amount_atoms) },
              ],
            });
          }
          if (order.side === 'sell' && BigInt(order.quantity) > 0n) {
            const released = await client.query(
              `update public.positions
               set available_quantity = available_quantity + $5,
                 locked_quantity = locked_quantity - $5,
                 updated_at = clock_timestamp()
               where tenant_id = $1 and user_id = $2 and market_id = $3
                 and outcome_id = $4 and locked_quantity >= $5`,
              [
                market.tenant_id,
                order.user_id,
                order.market_id,
                order.outcome_id,
                order.quantity,
              ],
            );
            if (released.rowCount !== 1) {
              throw new Error('A sell reservation could not be released exactly once.');
            }
          }
          await client.query(
            `update public.orders set remaining_quantity = 0,status = 'expired',
              updated_at = clock_timestamp() where id = $1`,
            [order.id],
          );
          await client.query(
            `update public.collateral_reservations
             set amount_atoms = 0,quantity = 0,status = 'released',
               released_at = clock_timestamp() where order_id = $1`,
            [order.id],
          );
        }
        for (const [status, reason] of [
          ['closed', 'All open orders and reservations were closed atomically.'],
          ['resolution_pending', 'The market is ready for retained resolution evidence.'],
        ] as const) {
          await client.query('select public.transition_market($1,$2,$3,$4,$5)', [
            market.tenant_id,
            market.market_ref,
            status,
            market.actor_id,
            reason,
          ]);
        }
      });
    } catch (error) {
      workerError('market-closing', error, market.market_ref);
    }
  }
}

async function finaliseApprovedResolutions(): Promise<void> {
  const due = await pool.query<{
    tenant_id: string;
    proposal_id: string;
    market_ref: string;
    officer_id: string;
  }>(
    `select rp.tenant_id,rp.id as proposal_id,m.market_ref,ra.officer_id
     from public.resolution_proposals rp
     join public.markets m on m.id = rp.market_id
     join lateral (
       select officer_id from public.resolution_approvals
       where proposal_id = rp.id and decision = 'approve'
       order by decided_at desc limit 1
     ) ra on true
     where rp.status = 'approved_pending_dispute'
       and rp.dispute_closes_at <= clock_timestamp()
       and m.status = 'proposed'
       and not exists (
         select 1 from public.resolution_disputes rd
         where rd.proposal_id = rp.id and rd.status not in ('rejected','closed','withdrawn')
       )
     order by rp.dispute_closes_at limit 50`,
  );
  for (const proposal of due.rows) {
    try {
      await withTransaction(async (client) => {
        await setTenantContext(client, proposal.tenant_id);
        const locked = await client.query(
          `select 1 from public.resolution_proposals rp
           join public.markets m on m.id = rp.market_id
           where rp.id = $1 and rp.tenant_id = $2
             and rp.status = 'approved_pending_dispute'
             and rp.dispute_closes_at <= clock_timestamp() and m.status = 'proposed'
             and not exists (
               select 1 from public.resolution_disputes rd
               where rd.proposal_id = rp.id
                 and rd.status not in ('rejected','closed','withdrawn')
             )
           for update of rp,m`,
          [proposal.proposal_id, proposal.tenant_id],
        );
        if (!locked.rowCount) return;
        await client.query(
          `update public.resolution_proposals
           set status = 'approved',finalised_at = clock_timestamp() where id = $1`,
          [proposal.proposal_id],
        );
        await client.query('select public.transition_market($1,$2,$3,$4,$5)', [
          proposal.tenant_id,
          proposal.market_ref,
          'resolved',
          proposal.officer_id,
          'The dispute window expired without an open dispute.',
        ]);
      });
    } catch (error) {
      workerError('resolution-finalisation', error, proposal.market_ref);
    }
  }
}

async function settleResolvedMarkets(): Promise<void> {
  const due = await pool.query<{
    tenant_id: string;
    market_id: string;
    market_ref: string;
    proposal_id: string;
    actor_id: string;
  }>(
    `select m.tenant_id,m.id as market_id,m.market_ref,rp.id as proposal_id,
      coalesce(ra.officer_id,m.approved_by,m.created_by) as actor_id
     from public.markets m
     join public.resolution_proposals rp on rp.market_id = m.id and rp.status = 'approved'
     left join lateral (
       select officer_id from public.resolution_approvals
       where proposal_id = rp.id and decision = 'approve'
       order by decided_at desc limit 1
     ) ra on true
     where m.status = 'resolved'
       and not exists (
         select 1 from public.reconciliation_cases rc
         join public.reconciliation_items ri on ri.id = rc.reconciliation_item_id
         join public.reconciliation_runs rr on rr.id = ri.reconciliation_run_id
         where rr.tenant_id = m.tenant_id and rc.status <> 'resolved'
           and rc.blocks_settlement
       )
     order by rp.finalised_at nulls last limit 20`,
  );
  for (const market of due.rows) {
    let runId: string | undefined;
    try {
      runId = await claimSettlementRun(market);
      if (!runId) continue;
      await executeSettlement(market, runId);
    } catch (error) {
      if (runId) {
        await failSettlementRun(market.tenant_id, runId, error);
      }
      workerError('market-settlement', error, market.market_ref);
    }
  }
}

async function claimSettlementRun(market: {
  tenant_id: string;
  market_id: string;
  market_ref: string;
  proposal_id: string;
}): Promise<string | undefined> {
  return withTransaction(async (client) => {
    await setTenantContext(client, market.tenant_id);
    const locked = await client.query(
      `select 1 from public.markets
       where id = $1 and tenant_id = $2 and status = 'resolved' for update`,
      [market.market_id, market.tenant_id],
    );
    if (!locked.rowCount) return undefined;
    const inserted = await client.query<{ id: string; status: string }>(
      `insert into public.settlement_runs
       (tenant_id,settlement_ref,market_id,proposal_id,status,started_at,
        locked_at,locked_by,attempt_count)
       values ($1,$2,$3,$4,'processing',clock_timestamp(),clock_timestamp(),$5,1)
       on conflict (market_id) do update
       set status = case when public.settlement_runs.status = 'completed'
           then public.settlement_runs.status else 'processing' end,
         locked_at = case when public.settlement_runs.status = 'completed'
           then public.settlement_runs.locked_at else clock_timestamp() end,
         locked_by = case when public.settlement_runs.status = 'completed'
           then public.settlement_runs.locked_by else excluded.locked_by end,
         attempt_count = case when public.settlement_runs.status = 'completed'
           then public.settlement_runs.attempt_count
           else public.settlement_runs.attempt_count + 1 end,
         last_error = case when public.settlement_runs.status = 'completed'
           then public.settlement_runs.last_error else null end
       returning id,status`,
      [
        market.tenant_id,
        deterministicRef('stl', market.market_id),
        market.market_id,
        market.proposal_id,
        workerRef,
      ],
    );
    return inserted.rows[0]?.status === 'completed' ? undefined : inserted.rows[0]?.id;
  });
}

async function executeSettlement(
  market: {
    tenant_id: string;
    market_id: string;
    market_ref: string;
    proposal_id: string;
    actor_id: string;
  },
  runId: string,
): Promise<void> {
  await withTransaction(async (client) => {
    await setTenantContext(client, market.tenant_id);
    const locked = await client.query<{
      asset_id: string;
      payout_atoms: string;
      winning_outcome_id: string;
    }>(
      `select m.collateral_asset_id as asset_id,m.payout_atoms::text,
        rp.outcome_id as winning_outcome_id
       from public.settlement_runs sr
       join public.markets m on m.id = sr.market_id
       join public.resolution_proposals rp on rp.id = sr.proposal_id
       where sr.id = $1 and sr.tenant_id = $2 and sr.status = 'processing'
         and sr.locked_by = $3 and m.status = 'resolved' and rp.status = 'approved'
       for update of sr,m`,
      [runId, market.tenant_id, workerRef],
    );
    const row = locked.rows[0];
    if (!row) return;
    await client.query('select public.transition_market($1,$2,$3,$4,$5)', [
      market.tenant_id,
      market.market_ref,
      'settling',
      market.actor_id,
      'Exactly-once settlement started.',
    ]);
    const positions = await client.query<{
      id: string;
      user_id: string;
      outcome_id: string;
      available_quantity: string;
      locked_quantity: string;
    }>(
      `select id,user_id,outcome_id,available_quantity::text,locked_quantity::text
       from public.positions
       where market_id = $1 and settled_at is null
         and (available_quantity > 0 or locked_quantity > 0)
       order by id for update`,
      [market.market_id],
    );
    if (positions.rows.some((position) => BigInt(position.locked_quantity) !== 0n)) {
      throw new Error('Settlement is blocked because a position remains locked.');
    }
    const payouts = positions.rows.map((position) => ({
      ...position,
      payout:
        position.outcome_id === row.winning_outcome_id
          ? BigInt(position.available_quantity) * BigInt(row.payout_atoms)
          : 0n,
    }));
    const totalPayout = payouts.reduce((sum, position) => sum + position.payout, 0n);
    let journalId: string | undefined;
    if (totalPayout > 0n) {
      const collateral = await workerLedgerAccount(
        client,
        market.tenant_id,
        null,
        row.asset_id,
        'collateral_locked',
      );
      if (!collateral || collateral.balance < totalPayout) {
        throw new Error('Settlement collateral is insufficient.');
      }
      const postings: WorkerPosting[] = [
        { accountId: collateral.id, debitAtoms: totalPayout },
      ];
      for (const position of payouts) {
        if (position.payout === 0n) continue;
        const available = await workerLedgerAccount(
          client,
          market.tenant_id,
          position.user_id,
          row.asset_id,
          'customer_available',
        );
        if (!available) throw new Error('A settlement beneficiary account is missing.');
        postings.push({ accountId: available.id, creditAtoms: position.payout });
      }
      journalId = await postWorkerJournal(client, {
        tenantId: market.tenant_id,
        assetId: row.asset_id,
        transactionType: 'market_settlement',
        referenceType: 'settlement',
        referenceRef: deterministicRef('stl', market.market_id),
        idempotencyKey: `market-settlement:${market.market_id}`,
        postings,
      });
    }
    if (payouts.length > 0 && !journalId) {
      throw new Error('A populated settlement must have a balanced ledger journal.');
    }
    for (const position of payouts) {
      const item = await client.query<{ id: string }>(
        `insert into public.settlement_items
         (settlement_run_id,position_id,user_id,payout_atoms,ledger_journal_id,
          settled_at,payout_rate_atoms)
         values ($1,$2,$3,$4,$5,clock_timestamp(),$6)
         on conflict (settlement_run_id,position_id) do update
         set payout_atoms = excluded.payout_atoms
         returning id`,
        [
          runId,
          position.id,
          position.user_id,
          position.payout.toString(),
          journalId,
          position.outcome_id === row.winning_outcome_id ? row.payout_atoms : '0',
        ],
      );
      await client.query(
        `update public.positions
         set settled_quantity = available_quantity,available_quantity = 0,
           settled_at = clock_timestamp(),settlement_item_id = $2,
           updated_at = clock_timestamp()
         where id = $1 and settled_at is null`,
        [position.id, item.rows[0]!.id],
      );
    }
    await client.query(
      `update public.settlement_runs
       set status = 'completed',completed_at = clock_timestamp(),
         totals = jsonb_build_object('position_count',$2::integer,'payout_atoms',$3::text),
         locked_at = null,locked_by = null,last_error = null
       where id = $1`,
      [runId, payouts.length, totalPayout.toString()],
    );
    await client.query('select public.transition_market($1,$2,$3,$4,$5)', [
      market.tenant_id,
      market.market_ref,
      'settled',
      market.actor_id,
      'All positions and collateral were settled atomically.',
    ]);
  });
}

async function failSettlementRun(tenantId: string, runId: string, error: unknown): Promise<void> {
  await withTransaction(async (client) => {
    await setTenantContext(client, tenantId);
    await client.query(
      `update public.settlement_runs
       set status = 'failed',last_error = left($2,2000),locked_at = null,locked_by = null
       where id = $1 and status = 'processing'`,
      [runId, error instanceof Error ? error.message : 'Settlement failed.'],
    );
  });
}

async function publishOutbox(): Promise<void> {
  const events = await withTransaction((client) =>
    client.query<{
      id: string;
      event_ref: string;
      event_type: string;
      channel: string;
      sequence: string;
      payload_version: string;
      payload: unknown;
      occurred_at: string;
    }>(
      `update public.outbox_events set locked_at = clock_timestamp(), locked_by = $1
       where id in (
         select id from public.outbox_events
         where published_at is null and next_attempt_at <= clock_timestamp()
           and (locked_at is null or locked_at < clock_timestamp() - interval '5 minutes')
         order by occurred_at for update skip locked limit 100
       )
       returning id, event_ref, event_type, channel, sequence::text, payload_version,
         payload, occurred_at::text`,
      [workerRef],
    ),
  );
  for (const event of events.rows) {
    try {
      await withTransaction(async (client) => {
        await client.query(
          `insert into public.event_stream
           (event_ref,event_type,channel,sequence,payload_version,payload,occurred_at)
           values ($1,$2,$3,$4,$5,$6,$7)
           on conflict (event_ref) do nothing`,
          [
            event.event_ref,
            event.event_type,
            event.channel,
            event.sequence,
            event.payload_version,
            event.payload,
            event.occurred_at,
          ],
        );
        await client.query(
          `update public.outbox_events set published_at = clock_timestamp(),
            locked_at = null, locked_by = null where id = $1 and locked_by = $2`,
          [event.id, workerRef],
        );
      });
    } catch {
      await pool.query(
        `update public.outbox_events set attempt_count = attempt_count + 1,
          next_attempt_at = clock_timestamp() + least(interval '15 minutes',
            interval '1 second' * power(2, least(attempt_count, 10))),
          locked_at = null, locked_by = null
         where id = $1 and locked_by = $2`,
        [event.id, workerRef],
      );
    }
  }
}

async function deliverNotifications(): Promise<void> {
  if (!config.NOTIFICATION_PROVIDER_BASE_URL || !config.NOTIFICATION_PROVIDER_API_KEY) return;
  const deliveries = await withTransaction((client) =>
    client.query<{
      id: string;
      notification_ref: string;
      channel: string;
      title: string;
      body: string;
    }>(
      `update public.notification_deliveries nd set status = 'processing',
        locked_at = clock_timestamp(), locked_by = $1
       from public.notifications n
       where nd.notification_id = n.id and nd.id in (
         select pending.id from public.notification_deliveries pending
         join public.notifications source on source.id = pending.notification_id
         where (
           pending.status in ('pending','retry')
           or (pending.status = 'processing'
             and pending.locked_at < clock_timestamp() - interval '5 minutes')
         ) and pending.attempt_count < 10
         order by source.created_at for update of pending skip locked limit 100
       )
       returning nd.id, n.notification_ref, nd.channel, n.title, n.body`,
      [workerRef],
    ),
  );
  for (const delivery of deliveries.rows) {
    try {
      const response = await fetch(new URL('/v1/messages', config.NOTIFICATION_PROVIDER_BASE_URL), {
        method: 'POST',
        headers: {
          authorization: `Bearer ${config.NOTIFICATION_PROVIDER_API_KEY}`,
          'content-type': 'application/json',
          'idempotency-key': `${delivery.notification_ref}:${delivery.channel}`,
        },
        body: JSON.stringify({
          reference: delivery.notification_ref,
          channel: delivery.channel,
          title: delivery.title,
          body: delivery.body,
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error('Delivery failed.');
      await pool.query(
        `update public.notification_deliveries set status = 'delivered',
          delivered_at = clock_timestamp(), attempt_count = attempt_count + 1,
          locked_at = null, locked_by = null
         where id = $1 and locked_by = $2`,
        [delivery.id, workerRef],
      );
    } catch (error) {
      await pool.query(
        `update public.notification_deliveries set status = 'retry',
          attempt_count = attempt_count + 1, last_error = $2,
          locked_at = null, locked_by = null
         where id = $1 and locked_by = $3`,
        [delivery.id, error instanceof Error ? error.message : 'Delivery failed.', workerRef],
      );
    }
  }
}

async function runReconciliation(): Promise<void> {
  await pool.query(
    `insert into public.system_incidents
     (incident_ref, severity, title, status, started_at, summary)
     select 'inc_' || encode(gen_random_bytes(12),'hex'), 'critical',
       'Ledger imbalance detected', 'open', clock_timestamp(),
       'Automated ledger invariant check found one or more unbalanced journals.'
     where exists (
       select 1 from public.ledger_entries group by journal_id
       having sum(debit_atoms) <> sum(credit_atoms)
     ) and not exists (
       select 1 from public.system_incidents
       where title = 'Ledger imbalance detected' and status = 'open'
     )`,
  );
}

async function withTransaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const result = await operation(client);
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

async function setTenantContext(client: PoolClient, tenantId: string): Promise<void> {
  await client.query(`select set_config('app.tenant_id',$1,true)`, [tenantId]);
  await client.query(`select set_config('app.user_id','',true)`);
}

interface WorkerPosting {
  accountId: string;
  debitAtoms?: bigint;
  creditAtoms?: bigint;
}

async function workerLedgerAccount(
  client: PoolClient,
  tenantId: string,
  userId: string | null,
  assetId: string,
  accountType: string,
): Promise<{ id: string; balance: bigint } | null> {
  const result = await client.query<{
    id: string;
    balance_atoms: string;
  }>(
    `select la.id,coalesce(lab.balance_atoms,0)::text as balance_atoms
     from public.ledger_accounts la
     left join public.ledger_account_balances lab on lab.account_id = la.id
     where la.tenant_id = $1 and la.owner_user_id is not distinct from $2
       and la.asset_id = $3 and la.account_type = $4 and la.status = 'active'
     for update of la`,
    [tenantId, userId, assetId, accountType],
  );
  const row = result.rows[0];
  return row ? { id: row.id, balance: BigInt(row.balance_atoms) } : null;
}

async function postWorkerJournal(
  client: PoolClient,
  input: {
    tenantId: string;
    assetId: string;
    transactionType: string;
    referenceType: string;
    referenceRef: string;
    idempotencyKey: string;
    postings: WorkerPosting[];
  },
): Promise<string> {
  const debit = input.postings.reduce((sum, value) => sum + (value.debitAtoms ?? 0n), 0n);
  const credit = input.postings.reduce((sum, value) => sum + (value.creditAtoms ?? 0n), 0n);
  if (debit <= 0n || debit !== credit) throw new Error('Worker ledger journal is not balanced.');
  const existing = await client.query<{ id: string }>(
    `select id from public.ledger_journals
     where tenant_id = $1 and idempotency_key = $2 for update`,
    [input.tenantId, input.idempotencyKey],
  );
  if (existing.rows[0]) return existing.rows[0].id;
  const journal = await client.query<{ id: string }>(
    `insert into public.ledger_journals
     (tenant_id,journal_ref,transaction_type,asset_id,reference_type,reference_ref,
      idempotency_key,effective_at)
     values ($1,$2,$3,$4,$5,$6,$7,clock_timestamp()) returning id`,
    [
      input.tenantId,
      deterministicRef('ljr', input.idempotencyKey),
      input.transactionType,
      input.assetId,
      input.referenceType,
      input.referenceRef,
      input.idempotencyKey,
    ],
  );
  for (const posting of input.postings) {
    const debitAtoms = posting.debitAtoms ?? 0n;
    const creditAtoms = posting.creditAtoms ?? 0n;
    if ((debitAtoms > 0n) === (creditAtoms > 0n)) {
      throw new Error('Every worker ledger posting must have exactly one side.');
    }
    await client.query(
      `insert into public.ledger_entries
       (tenant_id,journal_id,account_id,debit_atoms,credit_atoms)
       values ($1,$2,$3,$4,$5)`,
      [
        input.tenantId,
        journal.rows[0]!.id,
        posting.accountId,
        debitAtoms.toString(),
        creditAtoms.toString(),
      ],
    );
  }
  return journal.rows[0]!.id;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function deterministicRef(prefix: string, seed: string): string {
  return `${prefix}_${sha256(seed).slice(0, 24)}`;
}

function workerError(job: string, error: unknown, resource?: string): void {
  process.stderr.write(
    `${JSON.stringify({
      level: 'error',
      component: 'zoryqon-worker',
      job,
      resource,
      message: error instanceof Error ? error.message : 'Worker operation failed.',
      timestamp: new Date().toISOString(),
    })}\n`,
  );
}

async function runJob(name: string, operation: () => Promise<void>): Promise<void> {
  try {
    await operation();
  } catch (error) {
    workerError(name, error);
  }
}

function assertProviderPair(
  name: string,
  baseUrl: string | undefined,
  apiKey: string | undefined,
  required: boolean,
): void {
  if (!baseUrl && !apiKey && !required) return;
  if (!baseUrl || !apiKey) {
    throw new Error(`${name}_BASE_URL and ${name}_API_KEY must be configured together.`);
  }
}

function assertProductionEndpoint(name: string, value: string): void {
  const url = new URL(value);
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const privateHost =
    hostname === 'localhost' ||
    hostname === '0.0.0.0' ||
    hostname === '::1' ||
    hostname.endsWith('.local') ||
    /^127\./.test(hostname) ||
    /^10\./.test(hostname) ||
    /^192\.168\./.test(hostname) ||
    /^169\.254\./.test(hostname) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(hostname);
  if (url.protocol !== 'https:' || privateHost || url.username || url.password) {
    throw new Error(`${name} must use a credential-free public HTTPS endpoint in production.`);
  }
}
