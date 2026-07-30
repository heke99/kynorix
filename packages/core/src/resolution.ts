export interface ResolutionApprovalInput {
  proposalStatus: 'proposed' | 'approved' | 'rejected';
  proposerRef: string;
  approverRef: string;
  existingApproverRefs: readonly string[];
}

export function assertIndependentResolutionApproval(input: ResolutionApprovalInput): void {
  if (input.proposalStatus !== 'proposed') {
    throw new Error('RESOLUTION_PROPOSAL_NOT_OPEN');
  }
  if (input.proposerRef === input.approverRef) {
    throw new Error('INDEPENDENT_APPROVER_REQUIRED');
  }
  if (input.existingApproverRefs.includes(input.approverRef)) {
    throw new Error('RESOLUTION_ALREADY_REVIEWED_BY_USER');
  }
}

export function resolveDirection(
  startAtoms: bigint,
  endAtoms: bigint,
  tieRule: 'void' | 'up' | 'down' | 'separate_outcome',
): 'up' | 'down' | 'tie' | 'void' {
  if (endAtoms > startAtoms) return 'up';
  if (endAtoms < startAtoms) return 'down';
  if (tieRule === 'up' || tieRule === 'down') return tieRule;
  return tieRule === 'void' ? 'void' : 'tie';
}
