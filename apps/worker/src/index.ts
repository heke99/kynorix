import { createHash } from 'node:crypto';
import { Kafka } from 'kafkajs';
import pg, { type PoolClient } from 'pg';
import { z } from 'zod';

const EnvironmentSchema = z.object({
  DATABASE_URL: z.string().url(),
  DATABASE_SSL: z.enum(['disable', 'require', 'verify-full']).default('require'),
  EVENT_BROKER_URL: z.string().min(1),
  PRICE_PROVIDER_BASE_URL: z.string().url(),
  PRICE_PROVIDER_API_KEY: z.string().min(1),
  NOTIFICATION_PROVIDER_BASE_URL: z.string().url(),
  NOTIFICATION_PROVIDER_API_KEY: z.string().min(1),
  WORKER_POLL_INTERVAL_MS: z.coerce.number().int().min(250).max(60_000).default(1_000),
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
const { Pool } = pg;
const pool = new Pool({
  connectionString: config.DATABASE_URL,
  application_name: 'kynorix-worker',
  ssl:
    config.DATABASE_SSL === 'disable'
      ? false
      : { rejectUnauthorized: config.DATABASE_SSL === 'verify-full' },
});
const broker = new URL(config.EVENT_BROKER_URL);
const kafka = new Kafka({
  clientId: 'kynorix-worker',
  brokers: [`${broker.hostname}:${broker.port || '9092'}`],
});
const producer = kafka.producer({ allowAutoTopicCreation: false, idempotent: true });
await producer.connect();
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
    runJob('outbox-publication', publishOutbox),
    runJob('notification-delivery', deliverNotifications),
    runJob('reconciliation', runReconciliation),
  ]);
  const remaining = Math.max(0, config.WORKER_POLL_INTERVAL_MS - (Date.now() - startedAt));
  await new Promise((resolve) => setTimeout(resolve, remaining));
}

await producer.disconnect();
await pool.end();

async function ingestPrices(): Promise<void> {
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
     order by mts.next_run_at for update skip locked limit 20`,
  );
  for (const schedule of due.rows) {
    await withTransaction(async (client) => {
      const locked = await client.query(
        `select mts.id from public.market_template_schedules mts
         where mts.id = $1 and mts.enabled and mts.next_run_at <= clock_timestamp()
         for update`,
        [schedule.id],
      );
      if (!locked.rowCount) return;
      await client.query(
        `insert into public.audit_log
         (event_ref, actor_ref, actor_roles, action, resource_type, resource_ref,
          new_value, occurred_at)
         values ($1,'market-scheduler',array['service'],'market.schedule.due',
          'market_template_schedule',$2,jsonb_build_object('status','awaiting_canonical_creation'),
          clock_timestamp())`,
        [
          `aud_${createHash('sha256').update(`${schedule.id}:${Date.now()}`).digest('hex').slice(0, 24)}`,
          schedule.id,
        ],
      );
      await client.query(
        `update public.market_template_schedules
         set next_run_at = clock_timestamp() + interval '1 day' where id = $1`,
        [schedule.id],
      );
    });
  }
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
      await producer.send({
        topic: 'kynorix.events.v1',
        acks: -1,
        messages: [
          {
            key: event.channel,
            value: JSON.stringify({
              eventId: event.event_ref,
              channel: event.channel,
              eventType: event.event_type,
              sequence: event.sequence,
              serverTimestamp: event.occurred_at,
              payloadVersion: event.payload_version,
              payload: event.payload,
            }),
          },
        ],
      });
      await pool.query(
        `update public.outbox_events set published_at = clock_timestamp(),
          locked_at = null, locked_by = null where id = $1 and locked_by = $2`,
        [event.id, workerRef],
      );
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

async function runJob(name: string, operation: () => Promise<void>): Promise<void> {
  try {
    await operation();
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify({
        level: 'error',
        component: 'kynorix-worker',
        job: name,
        message: error instanceof Error ? error.message : 'Worker job failed.',
        timestamp: new Date().toISOString(),
      })}\n`,
    );
  }
}
