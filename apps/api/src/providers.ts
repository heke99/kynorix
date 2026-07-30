import { createHmac, timingSafeEqual } from 'node:crypto';
import type { CreateDeposit, CreateWithdrawal, StartVerification } from '@kynorix/contracts';
import type { ApiConfig, ProviderConfig } from './config.js';

export interface ProviderDepositSession {
  provider: string;
  providerIntentRef: string;
  status: 'awaiting_payment' | 'provider_pending';
  redirectUrl?: string;
  bankInstructions?: Record<string, string>;
  expiresAt?: string;
}

export interface ProviderWithdrawalSubmission {
  provider: string;
  providerTransactionRef: string;
  status: 'submitted' | 'confirming';
}

export interface VerifiedProviderEvent {
  providerEventRef: string;
  eventType: string;
  resourceRef: string;
  asset: string;
  amountAtoms: string;
  providerTransactionRef: string;
  occurredAt: string;
  raw: unknown;
}

export interface ProviderVerificationSession {
  provider: string;
  providerCaseRef: string;
  status: 'created' | 'pending';
  actionUrl: string;
}

export class ProviderRegistry {
  private readonly payment: HttpPaymentProvider;
  private readonly custody: HttpProvider;
  private readonly price: HttpProvider;
  private readonly compliance: HttpProvider;

  constructor(config: ApiConfig) {
    this.payment = new HttpPaymentProvider(config.providers.payment);
    this.custody = new HttpProvider('custody', config.providers.custody);
    this.price = new HttpProvider('price', config.providers.price);
    this.compliance = new HttpProvider('compliance', config.providers.compliance);
  }

  createDeposit(
    depositRef: string,
    userRef: string,
    input: CreateDeposit,
  ): Promise<ProviderDepositSession> {
    return this.payment.createDeposit(depositRef, userRef, input);
  }

  createWithdrawal(
    withdrawalRef: string,
    userRef: string,
    input: CreateWithdrawal,
  ): Promise<ProviderWithdrawalSubmission> {
    return this.payment.createWithdrawal(withdrawalRef, userRef, input);
  }

  createVerification(
    caseRef: string,
    userRef: string,
    input: StartVerification,
  ): Promise<ProviderVerificationSession> {
    return this.compliance.request<ProviderVerificationSession>(
      '/v1/verifications',
      {
        reference: caseRef,
        customer_reference: userRef,
        required_level: input.requiredLevel,
        return_url: input.returnUrl,
      },
      input.idempotencyKey,
    );
  }

  verifyPaymentWebhook(rawBody: Buffer, signature: string | undefined): VerifiedProviderEvent {
    return this.payment.verifyWebhook(rawBody, signature);
  }

  async readiness(): Promise<Record<string, boolean>> {
    const checks = await Promise.all([
      this.payment.health(),
      this.custody.health(),
      this.price.health(),
      this.compliance.health(),
    ]);
    return {
      payment: checks[0],
      custody: checks[1],
      price: checks[2],
      compliance: checks[3],
    };
  }
}

class HttpProvider {
  constructor(
    private readonly name: string,
    protected readonly config: ProviderConfig,
  ) {}

  async health(): Promise<boolean> {
    try {
      const response = await fetch(new URL('/health', this.config.baseUrl), {
        headers: { authorization: `Bearer ${this.config.apiKey}` },
        signal: AbortSignal.timeout(5_000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  async request<T>(path: string, body: unknown, idempotencyKey: string): Promise<T> {
    const response = await fetch(new URL(path, this.config.baseUrl), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.config.apiKey}`,
        'content-type': 'application/json',
        'idempotency-key': idempotencyKey,
        'user-agent': 'Kynorix/1.0',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      throw Object.assign(new Error(`${this.name} provider request failed.`), {
        code: 'PROVIDER_REQUEST_FAILED',
        statusCode: 502,
      });
    }
    return (await response.json()) as T;
  }
}

class HttpPaymentProvider extends HttpProvider {
  constructor(private readonly paymentConfig: ProviderConfig & { webhookSecret: string }) {
    super('payment', paymentConfig);
  }

  async createDeposit(
    depositRef: string,
    userRef: string,
    input: CreateDeposit,
  ): Promise<ProviderDepositSession> {
    const result = await this.request<{
      id: string;
      status: 'awaiting_payment' | 'provider_pending';
      redirect_url?: string;
      bank_instructions?: Record<string, string>;
      expires_at?: string;
    }>(
      '/v1/deposits',
      {
        reference: depositRef,
        customer_reference: userRef,
        method: input.method,
        asset: input.asset,
        amount_atomic: input.amountAtoms,
      },
      input.idempotencyKey,
    );
    const session: ProviderDepositSession = {
      provider: 'configured-payment-provider',
      providerIntentRef: result.id,
      status: result.status,
    };
    if (result.redirect_url) session.redirectUrl = result.redirect_url;
    if (result.bank_instructions) session.bankInstructions = result.bank_instructions;
    if (result.expires_at) session.expiresAt = result.expires_at;
    return session;
  }

  async createWithdrawal(
    withdrawalRef: string,
    userRef: string,
    input: CreateWithdrawal,
  ): Promise<ProviderWithdrawalSubmission> {
    const result = await this.request<{
      id: string;
      status: 'submitted' | 'confirming';
    }>(
      '/v1/withdrawals',
      {
        reference: withdrawalRef,
        customer_reference: userRef,
        method: input.method,
        asset: input.asset,
        amount_atomic: input.amountAtoms,
        destination_reference: input.destinationRef,
      },
      input.idempotencyKey,
    );
    return {
      provider: 'configured-payment-provider',
      providerTransactionRef: result.id,
      status: result.status,
    };
  }

  verifyWebhook(rawBody: Buffer, signature: string | undefined): VerifiedProviderEvent {
    if (!signature) throw webhookError('PROVIDER_SIGNATURE_REQUIRED');
    const expected = createHmac('sha256', this.paymentConfig.webhookSecret)
      .update(rawBody)
      .digest('hex');
    const supplied = signature.replace(/^sha256=/, '');
    if (
      expected.length !== supplied.length ||
      !timingSafeEqual(Buffer.from(expected), Buffer.from(supplied))
    ) {
      throw webhookError('INVALID_PROVIDER_SIGNATURE');
    }
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(rawBody.toString('utf8')) as Record<string, unknown>;
    } catch {
      throw webhookError('INVALID_PROVIDER_PAYLOAD');
    }
    const required = [
      'event_id',
      'event_type',
      'resource_reference',
      'asset',
      'amount_atomic',
      'provider_transaction_reference',
      'occurred_at',
    ] as const;
    for (const field of required) {
      if (typeof body[field] !== 'string' || body[field].length === 0) {
        throw webhookError('INVALID_PROVIDER_PAYLOAD');
      }
    }
    return {
      providerEventRef: body.event_id as string,
      eventType: body.event_type as string,
      resourceRef: body.resource_reference as string,
      asset: body.asset as string,
      amountAtoms: body.amount_atomic as string,
      providerTransactionRef: body.provider_transaction_reference as string,
      occurredAt: body.occurred_at as string,
      raw: {
        event_id: body.event_id,
        event_type: body.event_type,
        resource_reference: body.resource_reference,
        asset: body.asset,
        amount_atomic: body.amount_atomic,
        provider_transaction_reference: body.provider_transaction_reference,
        occurred_at: body.occurred_at,
      },
    };
  }
}

function webhookError(code: string): Error {
  return Object.assign(new Error(code), { code, statusCode: 400 });
}
