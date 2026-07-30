import type { JurisdictionDecision, ProductStatus, ProductType } from '@kynorix/contracts';

export interface ProductDefinition {
  productId: string;
  productType: ProductType;
  legalClassification: string;
  targetCustomerType: 'consumer' | 'business' | 'professional' | 'any';
  permittedCountries: string[];
  blockedCountries: string[];
  requiredLicences: string[];
  requiredKycLevel: string;
  requiredRiskAssessment: string;
  allowedOrderTypes: string[];
  settlementModel: string;
  custodyModel: string;
  feeModel: string;
  responsibleUseModel: string;
  mobileStoreAvailability: 'allowed' | 'web_only' | 'blocked';
  status: ProductStatus;
  version: string;
}

export interface PolicySubject {
  country: string;
  customerType: 'consumer' | 'business' | 'professional';
  kycLevel: string;
  channel: 'web' | 'ios' | 'android' | 'api';
  selfExcluded: boolean;
  sanctionsHit: boolean;
}

export const PRODUCT_POLICY_VERSION = '2026-07-30.1';

export const PRODUCT_CATALOG: Readonly<Record<ProductType, ProductDefinition>> = {
  virtual_prediction: {
    productId: 'prd_virtual_prediction_v1',
    productType: 'virtual_prediction',
    legalClassification: 'virtual_no-cash-value forecasting sandbox',
    targetCustomerType: 'any',
    permittedCountries: ['*'],
    blockedCountries: [],
    requiredLicences: [],
    requiredKycLevel: 'unverified',
    requiredRiskAssessment: 'basic_abuse',
    allowedOrderTypes: ['limit', 'marketable_limit'],
    settlementModel: 'fully_collateralised_virtual',
    custodyModel: 'none',
    feeModel: 'virtual_fee_v1',
    responsibleUseModel: 'sandbox_limits_v1',
    mobileStoreAvailability: 'allowed',
    status: 'sandbox_only',
    version: PRODUCT_POLICY_VERSION,
  },
  b2b_private_prediction: {
    productId: 'prd_b2b_private_prediction_v1',
    productType: 'b2b_private_prediction',
    legalClassification: 'private enterprise forecasting without redeemable value',
    targetCustomerType: 'business',
    permittedCountries: ['*'],
    blockedCountries: [],
    requiredLicences: [],
    requiredKycLevel: 'institution_verified',
    requiredRiskAssessment: 'enterprise_access',
    allowedOrderTypes: ['limit', 'marketable_limit'],
    settlementModel: 'virtual_enterprise',
    custodyModel: 'none',
    feeModel: 'subscription',
    responsibleUseModel: 'enterprise_policy',
    mobileStoreAvailability: 'allowed',
    status: 'approved',
    version: PRODUCT_POLICY_VERSION,
  },
  real_money_prediction: blockedDefinition(
    'real_money_prediction',
    'wager/event-contract legal classification required',
    'legal_review',
  ),
  spot_crypto: blockedDefinition(
    'spot_crypto',
    'MiCA-authorised CASP or licensed partner required',
    'partner_required',
  ),
  five_minute_up_down: blockedDefinition(
    'five_minute_up_down',
    'potential binary option — written classification required',
    'legal_review',
    'blocked',
  ),
  binary_option: blockedDefinition(
    'binary_option',
    'not distributable in Kynorix mobile applications',
    'suspended',
    'blocked',
  ),
  gold_price_display: {
    ...blockedDefinition(
      'gold_price_display',
      'display-only market data licensing required',
      'partner_required',
    ),
    custodyModel: 'none',
    mobileStoreAvailability: 'allowed',
  },
  gold_event_contract: blockedDefinition(
    'gold_event_contract',
    'event-contract legal classification required',
    'legal_review',
  ),
  gold_exposure: blockedDefinition(
    'gold_exposure',
    'financial-instrument and custody classification required',
    'legal_review',
  ),
};

function blockedDefinition(
  productType: ProductType,
  legalClassification: string,
  status: ProductStatus,
  mobileStoreAvailability: ProductDefinition['mobileStoreAvailability'] = 'web_only',
): ProductDefinition {
  return {
    productId: `prd_${productType}_v1`,
    productType,
    legalClassification,
    targetCustomerType: 'any',
    permittedCountries: [],
    blockedCountries: ['*'],
    requiredLicences: ['written_legal_approval'],
    requiredKycLevel: 'enhanced_due_diligence',
    requiredRiskAssessment: 'manual',
    allowedOrderTypes: [],
    settlementModel: 'disabled',
    custodyModel: 'disabled',
    feeModel: 'disabled',
    responsibleUseModel: 'blocked',
    mobileStoreAvailability,
    status,
    version: PRODUCT_POLICY_VERSION,
  };
}

export function decideProductAccess(
  productType: ProductType,
  subject: PolicySubject,
): JurisdictionDecision {
  const product = PRODUCT_CATALOG[productType];
  const evaluatedAt = new Date().toISOString();

  if (subject.selfExcluded || subject.sanctionsHit) {
    return decision('blocked_product', productType, 'SUBJECT_RESTRICTED', evaluatedAt);
  }
  if (
    product.mobileStoreAvailability === 'blocked' &&
    (subject.channel === 'ios' || subject.channel === 'android')
  ) {
    return decision('blocked_product', productType, 'MOBILE_STORE_BLOCK', evaluatedAt);
  }
  if (product.mobileStoreAvailability === 'web_only' && subject.channel !== 'web') {
    return decision('web_only', productType, 'WEB_ONLY_PRODUCT', evaluatedAt);
  }
  if (product.status !== 'approved' && product.status !== 'sandbox_only') {
    return decision('blocked_product', productType, 'PRODUCT_NOT_APPROVED', evaluatedAt);
  }
  if (product.targetCustomerType !== 'any' && product.targetCustomerType !== subject.customerType) {
    return decision('blocked_product', productType, 'CUSTOMER_TYPE_BLOCK', evaluatedAt);
  }
  if (
    product.blockedCountries.includes('*') ||
    product.blockedCountries.includes(subject.country)
  ) {
    return decision('blocked_country', productType, 'COUNTRY_BLOCK', evaluatedAt);
  }
  return decision('allowed', productType, 'POLICY_ALLOWED', evaluatedAt);
}

function decision(
  value: JurisdictionDecision['decision'],
  productType: ProductType,
  reasonCode: string,
  evaluatedAt: string,
): JurisdictionDecision {
  return {
    decision: value,
    productType,
    reasonCode,
    policyVersion: PRODUCT_POLICY_VERSION,
    evaluatedAt,
  };
}
