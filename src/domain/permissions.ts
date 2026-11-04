/**
 * The permission catalogue and the business rules that sit around it.
 * Everything the AuthorizationEngine knows about "what an action means" lives here,
 * in plain data, so the rules are readable in one place.
 */
import type { Stage } from '@prisma/client';

export const PERMISSIONS = [
  'job.view',          // see a job
  'job.create',        // create a job
  'job.edit',          // change business data (consignee, weight, value, notes)
  'job.prepare',       // CONFIRMED/REOPENED -> PREPARED
  'job.check',         // PREPARED -> CHECKED
  'job.reject',        // PREPARED -> CONFIRMED (checker sends it back, reason required)
  'job.file',          // CHECKED -> FILED
  'job.cancel',        // cancel a job that is NOT filed yet
  'job.cancel_filed',  // cancel a FILED job (sensitive)
  'job.reopen',        // FILED/CANCELLED -> REOPENED (sensitive)
  'job.assign',        // change who a job is assigned to
  'job.import_update', // parser updates its own data fields on a not-yet-prepared job
  'access.manage',     // grant/revoke access, delegations, absences, user status
  'access.explain',    // ask "why can X do Y" about someone else
  'audit.view',        // read the access audit log
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export function isPermission(value: string): value is Permission {
  return (PERMISSIONS as readonly string[]).includes(value);
}

/** Permissions that operate on a job (as opposed to administration). */
export type JobAction = Extract<Permission, `job.${string}`>;

/**
 * Which stages each job action may start from, and where it leads.
 * `to: null` means the action does not change the stage.
 * Anything not listed here is impossible - there is no "set stage" action.
 */
export const STAGE_RULES: Record<JobAction, { from: Stage[] | 'ANY'; to: Stage | null }> = {
  'job.view':          { from: 'ANY', to: null },
  'job.create':        { from: 'ANY', to: null }, // evaluated against the proposed job
  'job.edit':          { from: ['CONFIRMED', 'REOPENED'], to: null },
  'job.import_update': { from: ['CONFIRMED'], to: null },
  'job.prepare':       { from: ['CONFIRMED', 'REOPENED'], to: 'PREPARED' },
  'job.check':         { from: ['PREPARED'], to: 'CHECKED' },
  'job.reject':        { from: ['PREPARED'], to: 'CONFIRMED' },
  'job.file':          { from: ['CHECKED'], to: 'FILED' },
  'job.cancel':        { from: ['CONFIRMED', 'PREPARED', 'CHECKED', 'REOPENED'], to: 'CANCELLED' },
  'job.cancel_filed':  { from: ['FILED'], to: 'CANCELLED' },
  'job.reopen':        { from: ['FILED', 'CANCELLED'], to: 'REOPENED' },
  'job.assign':        { from: ['CONFIRMED', 'PREPARED', 'CHECKED', 'REOPENED'], to: null },
};

/** The JobHistory action name written when a permission is exercised. */
export const HISTORY_ACTION: Record<JobAction, string> = {
  'job.view': 'VIEW',
  'job.create': 'CREATE',
  'job.edit': 'EDIT',
  'job.import_update': 'IMPORT_UPDATE',
  'job.prepare': 'PREPARE',
  'job.check': 'CHECK',
  'job.reject': 'REJECT',
  'job.file': 'FILE',
  'job.cancel': 'CANCEL',
  'job.cancel_filed': 'CANCEL',
  'job.reopen': 'REOPEN',
  'job.assign': 'ASSIGN',
};

/** Actions that need a written reason. */
export const REASON_REQUIRED: JobAction[] = ['job.reject', 'job.cancel', 'job.cancel_filed', 'job.reopen'];

/** "Work" actions are blocked while the person is absent. Viewing is not. */
export const WORK_ACTIONS: JobAction[] = [
  'job.edit', 'job.prepare', 'job.check', 'job.reject', 'job.file',
  'job.cancel', 'job.cancel_filed', 'job.reopen', 'job.assign',
];

/**
 * Separation of duties: you may not perform `action` on a job if you have EVER performed
 * one of `conflictsWith` (JobHistory action names) on that same job.
 */
export const SOD_RULES: { action: JobAction; conflictsWith: string[]; message: string }[] = [
  {
    action: 'job.check',
    conflictsWith: ['PREPARE'],
    message: 'The person who prepared this job cannot check it (maker-checker rule).',
  },
  {
    action: 'job.reject',
    conflictsWith: ['PREPARE'],
    message: 'The person who prepared this job cannot review (reject) it.',
  },
  {
    action: 'job.cancel_filed',
    conflictsWith: ['CHECK', 'FILE'],
    message: 'An admin who checked or filed this job cannot cancel it.',
  },
  {
    action: 'job.reopen',
    conflictsWith: ['CHECK', 'FILE'],
    message: 'An admin who checked or filed this job cannot reopen it.',
  },
];

/** The next piece of work a job is waiting for, by stage (used by queues and routing). */
export const NEXT_ACTION: Partial<Record<Stage, JobAction>> = {
  CONFIRMED: 'job.prepare',
  REOPENED: 'job.prepare',
  PREPARED: 'job.check',
  CHECKED: 'job.file',
};
