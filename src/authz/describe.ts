/** Plain-English descriptions of access, e.g. "Raj Malhotra has role CHECKER for client ACME, branch BOM, IMPORT, any mode." */
import type { AccessGrant, Delegation } from '@prisma/client';
import { describeScope, toScope } from './scope';

const day = (d: Date) => d.toISOString().slice(0, 10);

export function describeGrant(userName: string, g: AccessGrant, at = new Date()): string {
  const base = `${userName} has role ${g.roleId} for ${describeScope(toScope(g))}`;
  if (g.revokedAt && g.revokedAt <= at) return `${base} - REVOKED on ${day(g.revokedAt)}${g.revokeReason ? ` (${g.revokeReason})` : ''}.`;
  if (g.validUntil && g.validUntil <= at) return `${base} - EXPIRED on ${day(g.validUntil)}.`;
  if (g.validFrom > at) return `${base} - starts ${day(g.validFrom)}.`;
  return `${base}${g.validUntil ? ` until ${day(g.validUntil)}` : ''}.`;
}

export function describeDelegation(delegateName: string, delegatorName: string, d: Delegation): string {
  return `${delegateName} temporarily covers ${delegatorName}'s ${d.roleId} work for ${describeScope(toScope(d))}, ${day(d.validFrom)} to ${day(d.validUntil)}${d.revokedAt ? ' - REVOKED' : ''}.`;
}
