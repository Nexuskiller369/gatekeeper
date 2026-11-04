# Gatekeeper: Design Document

*Access control for NFPL customs jobs. About 4 pages.*

## 1. The problem in one line

A filed shipment was altered and nobody could say **who had been allowed to, or why**. So the
system must (a) refuse what shouldn't happen, (b) explain every yes and no, and (c) remember
enough to answer questions about the past, while staying easy to run day to day.

## 2. The model

**A job** has four *access attributes*: client, branch, direction (IMPORT/EXPORT), mode
(AIR/FCL/LCL). They are fixed after creation, because they decide who may touch the job. It also has a
stage: `CONFIRMED → PREPARED → CHECKED → FILED`, plus `CANCELLED` and `REOPENED`.

**Permissions** are fine-grained verbs: `job.view`, `job.edit`, `job.prepare`, `job.check`,
`job.reject`, `job.file`, `job.cancel`, `job.cancel_filed`, `job.reopen`, `job.assign`,
`job.create`, `job.import_update`, `access.manage`, `access.explain`, `audit.view`.

**Roles** are named bundles of permissions stored as **data** (a `Role` row with a permission list):
MAKER, CHECKER, FILER, VIEWER, CLIENT_VIEWER, OPS_ADMIN, ACCESS_ADMIN, SYSTEM_PARSER, SYSTEM_AUTOMATION.

**An AccessGrant** is the core idea. It says "user U has role R **for** scope S, valid from T1 to T2".
A scope is any combination of `client, branch, direction, mode`, where an empty field means "any". A user
holds as many grants as they need. Grants are never deleted: revoking sets `revokedAt`, `revokedBy`
and a reason, so the past stays answerable.

**Delegation** says "A's role R for scope S is temporarily exercised by B, until T". B acts in their own
name, *on behalf of* A, and history records both.

**Absence** blocks *work* (not viewing) for a period. **User status** INACTIVE blocks everything.

**Workflow rules** are data too (`src/domain/permissions.ts`): which stages each action may start
from, which actions need a written reason, and separation-of-duties rules ("you may not `check` a job
if you `PREPARE`d it"; "an admin who checked or filed a job may not cancel or reopen it").

**History** comes in three append-only logs:
- `JobHistory`: every change to a job, with actor, on-behalf-of, the **grant or delegation that
  authorized it**, the stage before and after, a reason, and a field-level diff.
- `AccessAuditLog`: every access change *and every denied attempt*.
- `AutomationLog`: everything the router and the parser did or failed to do.

**The engine** (`src/authz/engine.ts`) is a set of pure functions with no database access:
`decide(context, action, job, history, at)`. It runs checks in a fixed order and stops at the first failure.
Every check appends a line to a **trace**:

1. identity (exists, active) → 2. known action → 3. job exists → 4. stage allows the action
(filed jobs are locked here) → 5. not absent → 6. client boundary (client users) → 7. some active
role has the permission → 8. some grant or delegation **scope covers** the job → 9. separation of duties.

The result is `ALLOW` or `DENY`, plus a machine code (`SCOPE_MISMATCH`, `SOD_VIOLATION`...), a
human sentence, the trace, and the exact grant or delegation that matched. Because it's pure, the same
function powers enforcement, explanations, history replays, queues and routing. There is only one
copy of the rules.

## 3. Key decisions and trade-offs

| Decision | Why | Trade-off accepted |
|---|---|---|
| **Scoped grants** (role × scope) instead of one role per user, or roles named like `CHECKER_ACME_BOM` | Matches how NFPL really works: people cover slices of the business. Avoids role explosion. | Slightly more complex queries; solved by turning scopes into SQL filters (below). |
| **One pure engine used everywhere** | Lists, queues, routing and explanations can't drift from enforcement. Easy to unit test (33 tests, no DB). | Callers must load facts first (`context.ts`). |
| **Token carries only the user id**; access is read from the DB on each request | "Changes take effect when people expect": a revoke or deactivation applies on the next click, not hours later. | One small DB read per request. Fine at 500 users; a short cache could come later. |
| **Deny by default, fail closed** | Any unknown action, missing data or exception becomes `DENY` with code `INDETERMINATE`. | A bug causes a refusal, never a silent allow. |
| **404 when you may not even see a job** | Doesn't leak which jobs exist, especially to client users. | Callers can't tell "missing" from "hidden"; admins use the explain API instead. |
| **Optimistic concurrency** (`version` column, conditional update) | Two people clicking "check" at once: exactly one wins, the other gets 409. No locks held. | The loser must reload. |
| **Synchronous routing** after each change (no queue or worker) | Simple, testable, enough for 120 staff. | Under heavy load you'd move it to an outbox + worker. Documented. |
| **Privileged roles are bootstrap-only** (can't be granted through the API) | Stops admins from creating more admins, including for each other. | Adding an admin is a deliberate seed or migration step. |

**Making lists fast at 200k jobs.** Visibility isn't checked job by job. The user's grants are
turned into one SQL `WHERE` (an OR of their scopes, each an AND of the fixed attributes) and the
database filters and paginates. Indexes: `Job(stage, clientId, branchId, direction, mode)`,
`Job(assigneeId, stage)`, `Job(clientId, createdAt)`, `JobHistory(jobId, createdAt)`,
`JobHistory(jobId, action, actorId)` for separation-of-duties lookups. Measured once on a laptop with
200,008 jobs: list pages 15–35 ms, waiting-for-me 16–62 ms, who-could-act over 500 users 44 ms.

## 4. Answers to the questions

**1. Should everyone see everything?** No. Viewing is a permission like any other (`job.view`),
scoped the same way: a checker for ACME/BOM sees ACME/BOM jobs. Seeing is wider than acting. A MAKER
for all clients sees all jobs but can only *prepare*; a VIEWER sees but can't act. Client users are
additionally clamped to their own company whatever their grant says, and their history view hides staff
names ("NFPL" instead). Jobs you can't see return 404, not 403.

**2. Maker everywhere, Checker for a few? Checker for one client, one branch, imports only?**
Several grants per person, each with its own scope. Sarah: `MAKER (any)` + `CHECKER (client ACME)` +
`CHECKER (client BLUESKY)`. Raj: one grant, `CHECKER (client ACME, branch BOM, direction IMPORT, any
mode)`. The system says this in plain English (`GET /auth/me`, `npm run access:describe`).

**3. The preparer is also qualified to approve it?** Qualification isn't enough. A
separation-of-duties rule is checked *after* scope: if you ever `PREPARE`d this job (per its history),
you can't `check` or `reject` it. Sarah can check ACME jobs, just not her own. Routing and
waiting-for-me apply the same rule, so she's never even offered it. The same idea stops an
admin who checked or filed a job from cancelling or reopening it.

**4. The person responsible is absent?** An `Absence` blocks *work* actions (view still works).
Recording one immediately re-checks every open job assigned to that person. Each job is re-routed to someone
the engine says can do the next step, or, if nobody can, left unassigned with a FAILED entry in
the automation log for a human to handle. Cover is explicit: a **delegation** lets Dev do Priya's
CORAL checking until a set date, and history records "Dev, on behalf of Priya, under delegation X".
Delegation guardrails: it *lends scope, not qualification* (Dev must already be a CHECKER). It
reaches only the intersection of the delegation's scope and Priya's grants *at the moment of use*, so if
Priya loses CORAL, Dev does too. It's capped at 30 days, and an admin can't set up a delegation they are part
of. Permissions are never silently copied.

**5. Jobs halfway through when responsibilities change?** Two parts. (a) *Authority*: a revoke
takes effect on the next request. Work already done stays valid, and its history still points to the
grant that allowed it then. (b) *Assignments*: revoking a grant, ending a delegation or
deactivating a user re-validates that person's open jobs and re-routes the ones they can no longer do.
The job keeps its stage; only the next actor changes.

**6. Who can cancel a filed job or reopen a closed one?** Filed jobs are locked for everyone by the
stage check. Cancelling a filed job is a separate, more sensitive permission (`job.cancel_filed`) from
cancelling a draft. It and `job.reopen` belong only to OPS_ADMIN, **scoped** (Olivia can only do DEL), require a
written reason, and are blocked for an admin who checked or filed that job. Each is recorded with the
reason and the grant used. *Assumption:* a single in-scope admin with a reason is enough. A two-person
approval was considered and left out as too heavy day to day, but it would slot in as one more check.

**7. A client's employee follows their shipments?** A `CLIENT` user type with a `CLIENT_VIEWER`
grant for their own client. Three safeguards: the role only has `job.view`; the engine clamps client users
to their company even if a grant were misconfigured; and admins can only give client users read-only
roles for their own client. Their history view shows the status trail without internal names.

**8. An admin fixes a stuck job? An admin tries to make themselves more powerful?** Fixing:
OPS_ADMIN can `assign` with a reason, but only to someone the engine says can do the next step. They
can't *do* the work for someone else, and they can't force a stage (there is no "set stage" endpoint).
Escalation: the access engine refuses any change where actor = target (`SELF_ESCALATION`), refuses
granting privileged roles at all, and refuses changes outside the admin's own scope (Bharat is DEL-only).
Every attempt, allowed or denied, is written to the audit log.

**9. The overnight parser?** As a user, not a backdoor. It's a `SERVICE` identity with no
password, whose SYSTEM_PARSER role allows only `job.create` and `job.import_update`, and only before
preparation. It calls the same services and engine as people, so a filed job rejects its update the same way.
Re-running a file is safe because records are matched on `externalRef`, and unchanged data writes nothing.
It may not change client/branch/direction/mode, since that would silently move a job into other people's
scope. Bad records are logged and skipped; the batch continues.

**10. "Why can she do this and he can't?"** `POST /authorization/check` with several user ids runs
the engine for each and returns, side by side, the decision, a sentence and the trace. Example: *"Sarah
has CHECKER for client ACME… which covers this EXPORT AIR job for ACME at DEL"* vs *"No CHECKER access
covers this job. Closest: CHECKER for client ACME, branch BOM, IMPORT; mismatch on branch (job is
DEL), direction (job is EXPORT)."* The "closest grant" hint tells an admin exactly what to change.

**11. "Who could have changed this job on the 3rd?"** Three separate questions. *Who did* comes from
JobHistory. *Under what authority* comes from the grant or delegation id stored on each history row. *Who could have*
comes from `GET /jobs/:id/who-could-act?at=…`, which rebuilds the facts as they were at that moment (the job's stage
from its history, grants and delegations by their validity windows and revoke dates, absences) and
re-runs the same engine for every user. Nothing is overwritten, so this works for any past time.

**12. A new role next quarter while engineering is busy?** Roles are data: a new role is one row
(name + permission list), and it's granted with the normal scoped-grant API. No code changes or deploys
are needed. What *does* need engineering is a genuinely new *verb* (a new permission) or a new workflow
rule. An admin screen for creating roles was cut for time; today it's a one-line seed or SQL change.

**13. "Jobs waiting for me" matches what I can actually do?** It isn't a stored task list
that could go stale. It's a query built from the same parts as the engine (my grants' scopes for
the job's next action, the separation-of-duties rule, assigned-to-me-or-unassigned) and computed fresh on each
request. A test walks every user's queue and confirms the engine says ALLOW for each item, so drift would fail
the build.

**14. When the system is unsure?** It says no, and says why. Unknown actions, missing facts or
any exception during evaluation become `DENY` with code `INDETERMINATE`. Routing that can't find a
safely eligible person leaves the job unassigned and flags it instead of guessing. Ambiguous
input (missing reason, bad dates, a parser record that would move scope) is rejected, not repaired.

### Questions we added

**15. What if two people act on the same job at once?** Optimistic concurrency: exactly one wins,
the other gets 409. A test fires two simultaneous checks and asserts one CHECK in history.

**16. How fast does a revoke take effect for someone already logged in?** On their next request,
because tokens hold identity only. Deactivated users' tokens stop working at once.

**17. Can a client user learn that other clients' jobs exist?** No. Out-of-scope jobs return 404
and lists are filtered in SQL.

## 5. Assumptions and what was cut

*Assumptions:* one NFPL organisation; jobs' access attributes don't change after creation;
"reopen" returns a job to a stage where it can be prepared again; a reason of at least 3 characters is enough;
cover for absence is short (a delegation of 30 days at most), and longer changes are new grants.

*Cut for time (not claimed as built):* configurable automation rules and an event bus; overdue-job
escalation and notifications (both depend on that engine); an admin UI/API for creating roles;
a parser HTTP endpoint; a UI. Next steps, in order: outbox + worker for routing, escalation of
stale jobs, role-management API, a short-lived permission cache if request volume grows.
