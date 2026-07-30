import { z } from 'zod';

export const ProductTypeSchema = z.enum(['event_contract', 'price_event_contract', 'spot_asset']);
export type ProductType = z.infer<typeof ProductTypeSchema>;

export const ProductStatusSchema = z.enum([
  'draft',
  'legal_review',
  'partner_required',
  'approved',
  'suspended',
  'retired',
]);
export type ProductStatus = z.infer<typeof ProductStatusSchema>;

export const MarketStatusSchema = z.enum([
  'draft',
  'under_review',
  'approved',
  'scheduled',
  'pre_open',
  'open',
  'suspended',
  'closing',
  'closed',
  'resolution_pending',
  'proposed',
  'disputed',
  'appealed',
  'resolved',
  'settling',
  'settled',
  'cancelled',
  'voided',
  'archived',
]);
export type MarketStatus = z.infer<typeof MarketStatusSchema>;

export const OrderSideSchema = z.enum(['buy', 'sell']);
export type OrderSide = z.infer<typeof OrderSideSchema>;
export const TimeInForceSchema = z.enum(['GTC', 'IOC', 'FOK']);
export type TimeInForce = z.infer<typeof TimeInForceSchema>;
export const OrderStatusSchema = z.enum([
  'received',
  'pending_validation',
  'accepted',
  'open',
  'partially_filled',
  'filled',
  'cancel_pending',
  'cancelled',
  'rejected',
  'expired',
  'suspended',
]);
export type OrderStatus = z.infer<typeof OrderStatusSchema>;

export const OutcomeSchema = z.object({
  outcomeRef: z.string().min(1),
  label: z.string().min(1),
  displayOrder: z.number().int().nonnegative(),
  lastPriceAtoms: z.string().regex(/^\d+$/).nullable().optional(),
});
export type Outcome = z.infer<typeof OutcomeSchema>;

export const MarketSchema = z.object({
  marketRef: z.string().min(1),
  tenantRef: z.string().min(1),
  productType: ProductTypeSchema,
  title: z.string().min(1),
  question: z.string().min(1),
  category: z.string().min(1),
  imageUrl: z.string().url().nullable().optional(),
  rules: z.string().min(1),
  resolutionSource: z.string().min(1),
  backupResolutionSource: z.string().nullable().optional(),
  resolutionTime: z.string().datetime(),
  opensAt: z.string().datetime(),
  closesAt: z.string().datetime(),
  displayTimezone: z.string().min(1),
  status: MarketStatusSchema,
  tradingSuspended: z.boolean().default(false),
  collateralAsset: z.string().min(1),
  assetDecimals: z.number().int().nonnegative(),
  payoutAtoms: z.string().regex(/^\d+$/),
  tickAtoms: z.string().regex(/^\d+$/),
  minimumOrderQuantity: z.string().regex(/^\d+$/),
  maximumPositionQuantity: z.string().regex(/^\d+$/),
  feeVersion: z.string().min(1),
  immutableRuleVersion: z.string().min(1),
  outcomes: z.array(OutcomeSchema).min(2),
  featured: z.boolean(),
  volumeAtoms: z.string().regex(/^\d+$/),
  liquidityAtoms: z.string().regex(/^\d+$/),
  openInterestAtoms: z.string().regex(/^\d+$/),
  change24hBasisPoints: z.number().int().nullable(),
});
export type Market = z.infer<typeof MarketSchema>;

export const MarketQuerySchema = z.object({
  query: z.string().trim().max(200).optional(),
  category: z.string().trim().max(80).optional(),
  sort: z.enum(['trending', 'volume', 'liquidity', 'newest', 'ending_soon']).default('trending'),
  status: MarketStatusSchema.optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(24),
});
export type MarketQuery = z.infer<typeof MarketQuerySchema>;

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export const OrderQuoteRequestSchema = z.object({
  marketRef: z.string().min(1),
  outcomeRef: z.string().min(1),
  side: OrderSideSchema,
  priceAtoms: z.string().regex(/^[1-9]\d*$/),
  quantity: z.string().regex(/^[1-9]\d*$/),
  timeInForce: TimeInForceSchema.default('GTC'),
  postOnly: z.boolean().default(false),
  maximumSlippageBasisPoints: z.number().int().min(0).max(10_000).default(100),
});
export type OrderQuoteRequest = z.infer<typeof OrderQuoteRequestSchema>;

export const PlaceOrderSchema = OrderQuoteRequestSchema.extend({
  type: z.literal('limit'),
  quoteRef: z.string().min(1),
  idempotencyKey: z.string().min(8).max(128),
});
export type PlaceOrder = z.infer<typeof PlaceOrderSchema>;

export interface FeeQuote {
  quoteRef: string;
  marketRef: string;
  outcomeRef: string;
  asset: string;
  priceAtoms: string;
  quantity: string;
  orderValueAtoms: string;
  feeAtoms: string;
  totalDebitAtoms: string;
  potentialPayoutAtoms: string;
  potentialProfitAtoms: string;
  priceImpactBasisPoints: number;
  feeScheduleRef: string;
  feeScheduleVersion: number;
  expiresAt: string;
}

export const OrderSchema = PlaceOrderSchema.extend({
  orderRef: z.string().min(1),
  status: OrderStatusSchema,
  remainingQuantity: z.string().regex(/^\d+$/),
  sequence: z.string().regex(/^\d+$/),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Order = z.infer<typeof OrderSchema>;

export const TradeSchema = z.object({
  tradeRef: z.string().min(1),
  marketRef: z.string().min(1),
  outcomeRef: z.string().min(1),
  makerOrderRef: z.string().min(1),
  takerOrderRef: z.string().min(1),
  priceAtoms: z.string().regex(/^\d+$/),
  quantity: z.string().regex(/^[1-9]\d*$/),
  buyerFeeAtoms: z.string().regex(/^\d+$/),
  sellerFeeAtoms: z.string().regex(/^\d+$/),
  sequence: z.string().regex(/^\d+$/),
  executedAt: z.string().datetime(),
});
export type Trade = z.infer<typeof TradeSchema>;

export interface Balance {
  asset: string;
  decimals: number;
  availableAtoms: string;
  lockedAtoms: string;
  pendingDepositAtoms: string;
  pendingWithdrawalAtoms: string;
}

export interface Position {
  marketRef: string;
  marketTitle: string;
  marketStatus: MarketStatus;
  outcomeRef: string;
  outcomeLabel: string;
  availableQuantity: string;
  lockedQuantity: string;
  averageEntryPriceAtoms: string;
  currentPriceAtoms: string | null;
  positionValueAtoms: string;
  potentialPayoutAtoms: string;
  unrealizedPnlAtoms: string;
  realizedPnlAtoms: string;
  feesPaidAtoms: string;
}

export interface MarketHistoryPoint {
  timestamp: string;
  outcomeRef: string;
  priceAtoms: string;
  volumeAtoms: string;
}

export const DepositStatusSchema = z.enum([
  'created',
  'awaiting_payment',
  'provider_pending',
  'received',
  'confirming',
  'compliance_review',
  'credited',
  'rejected',
  'reversed',
  'chargeback',
  'failed',
]);
export type DepositStatus = z.infer<typeof DepositStatusSchema>;
export const WithdrawalStatusSchema = z.enum([
  'requested',
  'authentication_required',
  'risk_review',
  'compliance_review',
  'approval_required',
  'approved',
  'signing',
  'submitted',
  'confirming',
  'completed',
  'rejected',
  'cancelled',
  'failed',
  'reversed',
]);
export type WithdrawalStatus = z.infer<typeof WithdrawalStatusSchema>;

export const CreateDepositSchema = z.object({
  method: z.enum(['bank_transfer', 'open_banking', 'card', 'stablecoin', 'crypto']),
  asset: z.string().min(2).max(16),
  amountAtoms: z.string().regex(/^[1-9]\d*$/),
  idempotencyKey: z.string().min(8).max(128),
});
export type CreateDeposit = z.infer<typeof CreateDepositSchema>;

export const CreateWithdrawalSchema = z.object({
  method: z.enum(['bank_transfer', 'stablecoin', 'crypto']),
  asset: z.string().min(2).max(16),
  amountAtoms: z.string().regex(/^[1-9]\d*$/),
  destinationRef: z.string().min(1),
  idempotencyKey: z.string().min(8).max(128),
});
export type CreateWithdrawal = z.infer<typeof CreateWithdrawalSchema>;

export const ConfirmWithdrawalSchema = z.object({
  idempotencyKey: z.string().min(8).max(128),
});
export type ConfirmWithdrawal = z.infer<typeof ConfirmWithdrawalSchema>;

export const StartVerificationSchema = z.object({
  requiredLevel: z.enum(['basic', 'enhanced', 'institution']).default('basic'),
  returnUrl: z.string().url(),
  idempotencyKey: z.string().min(8).max(128),
});
export type StartVerification = z.infer<typeof StartVerificationSchema>;

export interface Deposit {
  depositRef: string;
  method: string;
  asset: string;
  amountAtoms: string;
  feeAtoms: string;
  status: DepositStatus;
  providerReference: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface Withdrawal {
  withdrawalRef: string;
  method: string;
  asset: string;
  amountAtoms: string;
  feeAtoms: string;
  status: WithdrawalStatus;
  providerReference: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface LedgerTransaction {
  journalRef: string;
  transactionType: string;
  asset: string;
  referenceType: string;
  referenceRef: string;
  effectiveAt: string;
  debitAtoms: string;
  creditAtoms: string;
}

export interface VerificationStatus {
  level: string;
  status: string;
  caseRef: string | null;
  actionUrl: string | null;
  openedAt: string | null;
  decidedAt: string | null;
}

export const ResolutionEvidenceSchema = z.object({
  source: z.string().url(),
  capturedAt: z.string().datetime(),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  notes: z.string().min(10),
});
export type ResolutionEvidence = z.infer<typeof ResolutionEvidenceSchema>;
export const ProposeResolutionSchema = z.object({
  outcomeRef: z.string().min(1),
  evidence: z.array(ResolutionEvidenceSchema).min(1),
  reason: z.string().min(20),
});
export type ProposeResolution = z.infer<typeof ProposeResolutionSchema>;

export const CreateMarketSchema = z
  .object({
    title: z.string().min(10).max(240),
    question: z.string().min(10).max(500),
    categoryRef: z.string().min(1),
    productRef: z.string().min(1),
    outcomes: z
      .array(z.object({ label: z.string().min(1).max(100) }))
      .min(2)
      .max(20),
    rules: z.string().min(50),
    primarySource: z.string().url(),
    backupSource: z.string().url().nullable().optional(),
    priceIndexRef: z.string().min(1).nullable().optional(),
    opensAt: z.string().datetime(),
    closesAt: z.string().datetime(),
    resolutionAt: z.string().datetime(),
    displayTimezone: z.string().min(1),
    collateralAsset: z.string().min(2).max(16),
    payoutAtoms: z.string().regex(/^[1-9]\d*$/),
    tickAtoms: z.string().regex(/^[1-9]\d*$/),
    minimumOrderQuantity: z.string().regex(/^[1-9]\d*$/),
    maximumPositionQuantity: z.string().regex(/^[1-9]\d*$/),
    feeScheduleRef: z.string().min(1),
    jurisdictionPolicyRef: z.string().min(1),
    riskClass: z.enum(['low', 'standard', 'high', 'restricted']),
  })
  .refine((value) => Date.parse(value.opensAt) < Date.parse(value.closesAt), {
    message: 'Opening time must be before closing time.',
  })
  .refine((value) => Date.parse(value.closesAt) <= Date.parse(value.resolutionAt), {
    message: 'Resolution time must not be before closing time.',
  });
export type CreateMarket = z.infer<typeof CreateMarketSchema>;

export interface AuthenticatedUser {
  userRef: string;
  email: string;
  displayName: string;
  accountStatus: string;
  kycLevel: string;
  roles: string[];
  permissions: string[];
  mfaVerified: boolean;
}

export interface ApiErrorBody {
  error: { code: string; message: string; requestRef: string; details?: unknown };
}
export interface ApiEnvelope<T> {
  data: T;
  meta: { requestRef: string; serverTime: string };
}
export interface RealtimeEvent<T = unknown> {
  eventId: string;
  channel: string;
  eventType: string;
  sequence: string;
  serverTimestamp: string;
  payloadVersion: string;
  payload: T;
}
