import type { ProductStatus, ProductType } from '@kynorix/contracts';

export interface ProductPolicy {
  productRef: string;
  productType: ProductType;
  status: ProductStatus;
  targetCustomerTypes: string[];
  permittedCountries: string[];
  blockedCountries: string[];
  requiredKycLevel: string;
  allowedChannels: Array<'web' | 'ios' | 'android' | 'api'>;
  positionLimitAtoms: bigint;
  effectiveFrom: string;
  effectiveTo: string | null;
}

export interface PolicySubject {
  country: string;
  customerType: string;
  kycLevel: string;
  channel: 'web' | 'ios' | 'android' | 'api';
  selfExcluded: boolean;
  sanctionsHit: boolean;
  accountRestricted: boolean;
}

export type ProductAccessDecision =
  | { decision: 'allowed'; reasonCode: 'POLICY_ALLOWED' }
  | {
      decision: 'blocked';
      reasonCode:
        | 'SUBJECT_RESTRICTED'
        | 'PRODUCT_NOT_APPROVED'
        | 'CHANNEL_BLOCKED'
        | 'CUSTOMER_TYPE_BLOCKED'
        | 'COUNTRY_BLOCKED'
        | 'KYC_UPGRADE_REQUIRED'
        | 'POLICY_NOT_EFFECTIVE';
    };

export function decideProductAccess(
  policy: ProductPolicy,
  subject: PolicySubject,
  now = new Date(),
): ProductAccessDecision {
  if (subject.selfExcluded || subject.sanctionsHit || subject.accountRestricted) {
    return { decision: 'blocked', reasonCode: 'SUBJECT_RESTRICTED' };
  }
  if (policy.status !== 'approved') {
    return { decision: 'blocked', reasonCode: 'PRODUCT_NOT_APPROVED' };
  }
  if (!policy.allowedChannels.includes(subject.channel)) {
    return { decision: 'blocked', reasonCode: 'CHANNEL_BLOCKED' };
  }
  if (
    policy.targetCustomerTypes.length &&
    !policy.targetCustomerTypes.includes(subject.customerType)
  ) {
    return { decision: 'blocked', reasonCode: 'CUSTOMER_TYPE_BLOCKED' };
  }
  if (
    policy.blockedCountries.includes('*') ||
    policy.blockedCountries.includes(subject.country) ||
    (!policy.permittedCountries.includes('*') &&
      !policy.permittedCountries.includes(subject.country))
  ) {
    return { decision: 'blocked', reasonCode: 'COUNTRY_BLOCKED' };
  }
  if (subject.kycLevel !== policy.requiredKycLevel && policy.requiredKycLevel !== 'unverified') {
    return { decision: 'blocked', reasonCode: 'KYC_UPGRADE_REQUIRED' };
  }
  const instant = now.getTime();
  if (
    Date.parse(policy.effectiveFrom) > instant ||
    (policy.effectiveTo && Date.parse(policy.effectiveTo) <= instant)
  ) {
    return { decision: 'blocked', reasonCode: 'POLICY_NOT_EFFECTIVE' };
  }
  return { decision: 'allowed', reasonCode: 'POLICY_ALLOWED' };
}
