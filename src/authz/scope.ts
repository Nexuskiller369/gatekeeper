/**
 * A Scope is the "where" part of a grant: client, branch, direction, mode.
 * null in any field means ANY. These small pure functions are shared by the
 * single-job decision AND the list/queue SQL filters, which is how we guarantee
 * that "jobs waiting for me" agrees with "may I act on this job".
 */
import type { Direction, Mode, Prisma } from '@prisma/client';

// A `type` (not `interface`) so a Scope can be stored directly in JSON audit columns.
export type Scope = {
  clientId: string | null;
  branchId: string | null;
  direction: Direction | null;
  mode: Mode | null;
};

export interface JobAttributes {
  clientId: string;
  branchId: string;
  direction: Direction;
  mode: Mode;
}

export const SCOPE_FIELDS = ['clientId', 'branchId', 'direction', 'mode'] as const;
export type ScopeField = (typeof SCOPE_FIELDS)[number];

const FIELD_LABEL: Record<ScopeField, string> = {
  clientId: 'client',
  branchId: 'branch',
  direction: 'direction',
  mode: 'mode',
};

export const ANY_SCOPE: Scope = { clientId: null, branchId: null, direction: null, mode: null };

export function toScope(row: Partial<Scope>): Scope {
  return {
    clientId: row.clientId ?? null,
    branchId: row.branchId ?? null,
    direction: row.direction ?? null,
    mode: row.mode ?? null,
  };
}

/** Which scope dimensions fail for this job? Empty array = the scope covers the job. */
export function mismatchedFields(scope: Scope, job: JobAttributes): ScopeField[] {
  return SCOPE_FIELDS.filter((f) => scope[f] !== null && scope[f] !== job[f]);
}

export function scopeMatches(scope: Scope, job: JobAttributes): boolean {
  return mismatchedFields(scope, job).length === 0;
}

/**
 * Intersection of two scopes ("A AND B"). Returns null when they cannot both hold,
 * e.g. client ACME intersected with client BLUESKY.
 */
export function intersectScopes(a: Scope, b: Scope): Scope | null {
  const out = { ...ANY_SCOPE } as Record<ScopeField, string | null>;
  for (const f of SCOPE_FIELDS) {
    const x = a[f];
    const y = b[f];
    if (x !== null && y !== null && x !== y) return null;
    out[f] = x ?? y;
  }
  return out as unknown as Scope;
}

/** Does `outer` cover everything `inner` covers? (Used so admins cannot grant beyond their own scope.) */
export function scopeContains(outer: Scope, inner: Scope): boolean {
  return SCOPE_FIELDS.every((f) => outer[f] === null || outer[f] === inner[f]);
}

/** Human-readable scope, e.g. "client ACME, branch BOM, IMPORT, any mode". */
export function describeScope(scope: Scope): string {
  return [
    scope.clientId ? `client ${scope.clientId}` : 'any client',
    scope.branchId ? `branch ${scope.branchId}` : 'any branch',
    scope.direction ? `${scope.direction}` : 'any direction',
    scope.mode ? `${scope.mode}` : 'any mode',
  ].join(', ');
}

export function describeMismatch(fields: ScopeField[], job: JobAttributes): string {
  return fields.map((f) => `${FIELD_LABEL[f]} (job is ${job[f]})`).join(', ');
}

export function fieldLabels(fields: ScopeField[]): string[] {
  return fields.map((f) => FIELD_LABEL[f]);
}

/** A scope as a Prisma `where` fragment on the Job table. ANY fields are simply left out. */
export function scopeToJobWhere(scope: Scope): Prisma.JobWhereInput {
  const where: Prisma.JobWhereInput = {};
  if (scope.clientId) where.clientId = scope.clientId;
  if (scope.branchId) where.branchId = scope.branchId;
  if (scope.direction) where.direction = scope.direction;
  if (scope.mode) where.mode = scope.mode;
  return where;
}
