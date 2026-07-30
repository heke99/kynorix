import type { ResolutionEvidence } from '@kynorix/contracts';
import { externalRef } from './id.js';

export interface ResolutionProposal {
  proposalRef: string;
  marketRef: string;
  outcomeRef: string;
  proposedBy: string;
  proposedAt: string;
  reason: string;
  evidence: ResolutionEvidence[];
  approvals: Array<{ officerRef: string; approvedAt: string }>;
  status: 'proposed' | 'approved' | 'rejected';
}

export class ResolutionWorkflow {
  private readonly proposals = new Map<string, ResolutionProposal>();

  propose(input: Omit<ResolutionProposal, 'proposalRef' | 'proposedAt' | 'approvals' | 'status'>) {
    const proposal: ResolutionProposal = {
      ...input,
      proposalRef: externalRef('rsp'),
      proposedAt: new Date().toISOString(),
      approvals: [],
      status: 'proposed',
    };
    this.proposals.set(proposal.proposalRef, proposal);
    return proposal;
  }

  approve(proposalRef: string, officerRef: string): ResolutionProposal {
    const proposal = this.proposals.get(proposalRef);
    if (!proposal) throw new Error('RESOLUTION_PROPOSAL_NOT_FOUND');
    if (proposal.status !== 'proposed') throw new Error('RESOLUTION_PROPOSAL_NOT_OPEN');
    if (proposal.proposedBy === officerRef) throw new Error('FOUR_EYES_SAME_OFFICER_DENIED');
    if (proposal.approvals.some((approval) => approval.officerRef === officerRef)) {
      return proposal;
    }
    proposal.approvals.push({ officerRef, approvedAt: new Date().toISOString() });
    // Proposer + one independent approver implements two-person control.
    proposal.status = 'approved';
    return proposal;
  }

  get(proposalRef: string): ResolutionProposal | undefined {
    return this.proposals.get(proposalRef);
  }
}
