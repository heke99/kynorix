import { z } from 'zod';

export const ProductTypeSchema = z.enum([
  'virtual_prediction',
  'b2b_private_prediction',
  'real_money_prediction',
  'spot_crypto',
  'five_minute_up_down',
  'binary_option',
  'gold_price_display',
  'gold_event_contract',
  'gold_exposure',
]);
export type ProductType = z.infer<typeof ProductTypeSchema>;

export const ProductStatusSchema = z.enum([
  'draft',
  'sandbox_only',
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
});
export type Outcome = z.infer<typeof OutcomeSchema>;

export const MarketSchema = z.object({
  marketRef: z.string().min(1),
  tenantRef: z.string().min(1),
  productType: ProductTypeSchema,
  title: z.string().min(1),
  question: z.string().min(1),
  category: z.string().min(1),
  rules: z.string().min(1),
  resolutionSource: z.string().min(1),
  resolutionTime: z.string().datetime(),
  opensAt: z.string().datetime(),
  closesAt: z.string().datetime(),
  displayTimezone: z.string().min(1),
  status: MarketStatusSchema,
  collateralAsset: z.string().min(1),
  payoutAtoms: z.string().regex(/^\d+$/),
  tickAtoms: z.string().regex(/^\d+$/),
  minimumOrderQuantity: z.string().regex(/^\d+$/),
  maximumPositionQuantity: z.string().regex(/^\d+$/),
  feeVersion: z.string().min(1),
  immutableRuleVersion: z.string().min(1),
  outcomes: z.array(OutcomeSchema).min(2),
  featured: z.boolean(),
});
export type Market = z.infer<typeof MarketSchema>;

export const PlaceOrderSchema = z.object({
  marketRef: z.string().min(1),
  outcomeRef: z.string().min(1),
  side: OrderSideSchema,
  type: z.literal('limit'),
  priceAtoms: z.string().regex(/^\d+$/),
  quantity: z.string().regex(/^[1-9]\d*$/),
  timeInForce: TimeInForceSchema.default('GTC'),
  postOnly: z.boolean().default(false),
  idempotencyKey: z.string().min(8).max(128),
});
export type PlaceOrder = z.infer<typeof PlaceOrderSchema>;

export const OrderSchema = PlaceOrderSchema.extend({
  orderRef: z.string().min(1),
  userRef: z.string().min(1),
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
  buyerUserRef: z.string().min(1),
  sellerUserRef: z.string().min(1),
  priceAtoms: z.string().regex(/^\d+$/),
  quantity: z.string().regex(/^[1-9]\d*$/),
  buyerFeeAtoms: z.string().regex(/^\d+$/),
  sellerFeeAtoms: z.string().regex(/^\d+$/),
  sequence: z.string().regex(/^\d+$/),
  executedAt: z.string().datetime(),
});
export type Trade = z.infer<typeof TradeSchema>;

export const BalanceSchema = z.object({
  asset: z.string().min(1),
  availableAtoms: z.string(),
  lockedAtoms: z.string(),
});
export type Balance = z.infer<typeof BalanceSchema>;

export const PositionSchema = z.object({
  marketRef: z.string().min(1),
  outcomeRef: z.string().min(1),
  availableQuantity: z.string(),
  lockedQuantity: z.string(),
  averageEntryPriceAtoms: z.string(),
  realizedPnlAtoms: z.string(),
  feesPaidAtoms: z.string(),
});
export type Position = z.infer<typeof PositionSchema>;

export const JurisdictionDecisionSchema = z.object({
  decision: z.enum([
    'allowed',
    'allowed_with_limits',
    'kyc_upgrade_required',
    'professional_only',
    'web_only',
    'blocked_product',
    'blocked_asset',
    'blocked_country',
    'manual_review',
  ]),
  productType: ProductTypeSchema,
  reasonCode: z.string().min(1),
  policyVersion: z.string().min(1),
  evaluatedAt: z.string().datetime(),
});
export type JurisdictionDecision = z.infer<typeof JurisdictionDecisionSchema>;

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

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    requestRef: string;
    details?: unknown;
  };
}

export interface ApiEnvelope<T> {
  data: T;
  meta: {
    requestRef: string;
    serverTime: string;
    sandbox: boolean;
  };
}

export interface RealtimeEvent<T = unknown> {
  sequence: string;
  eventId: string;
  channel: string;
  eventType: string;
  serverTimestamp: string;
  marketTimestamp: string;
  payloadVersion: '1';
  payload: T;
}
