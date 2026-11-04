# Gatekeeper, explained simply

This guide is for understanding the project well enough to explain it to someone else, including
an interviewer. No prior knowledge assumed. For the formal version, read [DESIGN.md](DESIGN.md).

---

## 1. What problem are we solving?

NFPL is a customs broker. Every shipment is a **job**. A job moves through steps:

```
CONFIRMED ──prepare──▶ PREPARED ──check──▶ CHECKED ──file──▶ FILED
    ▲                     │                                   │
    └──────reject─────────┘                       cancel ◀────┤────▶ reopen
                                                 CANCELLED          REOPENED
```

Different people do different steps. A **Maker** prepares the paperwork, a **Checker** reviews it,
and a **Filer** submits it to customs.

Last month someone changed a job that was already filed, and nobody could say who had been
allowed to or why. Management wants:

1. **Strict rules:** the wrong person simply can't do the wrong thing.
2. **Explanations:** "why was this allowed or blocked?" always has an answer.
3. **Memory:** "who did this, and who *could* have done it on the 3rd?" can be answered later.

Gatekeeper is a backend service (an API, with no screens) that does those three things.

---

## 2. The big idea in one picture

Every question the system answers boils down to this:

> **Can PERSON do ACTION on JOB, right now (or at time T)?**

One piece of code answers it: **the engine**. Everything else either *collects facts* for the
engine or *uses its answer*.

```
                    ┌────────────────────────────┐
  HTTP request ───▶ │  routes.ts  (thin: checks  │
  (with token)      │  input, finds who you are) │
                    └─────────────┬──────────────┘
                                  ▼
                    ┌────────────────────────────┐
                    │  services/  (jobs, queue,  │
                    │  admin, history, parser)   │
                    └──────┬──────────────┬──────┘
             "load facts"  │              │  "save result + history"
                           ▼              ▼
              ┌──────────────────┐   ┌─────────────┐
              │  context.ts      │   │  Postgres   │
              │  (user, grants,  │◀──│  (Prisma)   │
              │  delegations,    │   └─────────────┘
              │  absences, job)  │
              └────────┬─────────┘
                       ▼
              ┌──────────────────┐
              │   ENGINE         │  pure function, no database:
              │   decide(...)    │  facts in → ALLOW/DENY + reason + trace out
              └──────────────────┘
```

Why is the engine a "pure function" (no database inside)?
- It's **easy to test**: give it facts, check the answer. 33 unit tests do exactly that, in milliseconds.
- It can be **reused everywhere**: doing the action, explaining a decision, replaying the past,
  building "jobs waiting for me", and choosing who to assign work to. One set of rules means no
  contradictions.

---

## 3. The vocabulary (learn these and you can explain everything)

| Word | Plain meaning | Example |
|---|---|---|
| **Job** | One shipment | NF-DEMO-01 |
| **Job attributes** | The 4 things that decide who can touch a job | client ACME, branch BOM, IMPORT, AIR |
| **Stage** | Where the job is in the workflow | PREPARED |
| **Permission** | One verb the system understands | `job.check` |
| **Role** | A named bundle of permissions | CHECKER = view + check + reject |
| **Scope** | *Which* jobs a role applies to. Blank means "any". | client ACME, branch BOM, IMPORT |
| **Grant** (AccessGrant) | "Person has Role for Scope, from date to date" | Raj has CHECKER for ACME / BOM / IMPORT |
| **Delegation** | Temporary cover: B does A's work, *on behalf of* A, until a date | Dev covers Priya's CORAL checking |
| **Absence** | Person is away, so they can't do work (can still look) | Priya on annual leave |
| **Separation of duties (SoD)** | You can't approve your own work | The preparer can't check the same job |
| **Trace** | The list of checks the engine ran, each PASS/FAIL | "identity PASS, stage PASS, scope FAIL…" |
| **Service identity** | A non-human user | the overnight parser, the automation |

The key sentence: **access = role × scope**. One person can have many grants, which is how
"Maker everywhere but Checker for only two clients" works (Sarah has three grants).

---

## 4. What the engine checks, in order

Like airport security, the first failure stops you and tells you which gate you failed.

| # | Check | Fails with | Example |
|---|---|---|---|
| 1 | Do you exist and is your account active? | `ACTOR_INACTIVE` | Eric left the company |
| 2 | Is this a real action? | `UNKNOWN_ACTION` | typo in the action name |
| 3 | Does the job exist? | `JOB_NOT_FOUND` | |
| 4 | Is the job at a stage where this action makes sense? | `WRONG_STAGE` / `FILED_LOCKED` | can't edit a FILED job |
| 5 | Are you absent? | `ACTOR_ABSENT` | Priya on leave |
| 6 | Client user looking at another company's job? | `CLIENT_BOUNDARY` | Tom (Acme) and a Bluesky job |
| 7 | Do you have *any* role with this permission? | `NO_PERMISSION` | Alice has no CHECKER role |
| 8 | Does one of your grants (or delegations) **cover this job's attributes**? | `SCOPE_MISMATCH` | Raj checks only BOM imports |
| 9 | Did you do something earlier on this job that conflicts? | `SOD_VIOLATION` | Sarah prepared it, so she can't check it |

If everything passes you get `ALLOW`, plus **which grant allowed it**. That grant id is saved in
the job's history, which is how we can later say "under what authority".

If anything weird happens (an error, missing data), the answer is `DENY` with `INDETERMINATE`.
**When unsure, say no.**

---

## 5. Life of one request (what actually happens when Raj clicks "check")

1. Raj sends `POST /jobs/NF-DEMO-01/check` with his **token**.
2. `http/auth.ts` verifies the token. The token only says "this is raj". It does **not** contain his
   roles. We look up the user in the DB and make sure he's still ACTIVE.
3. `routes.ts` validates the input and calls `performJobAction('raj', 'NF-DEMO-01', 'job.check')`.
4. The service loads facts (`context.ts`): Raj's grants, delegations and absences, the job, and the job's history.
5. The **engine** decides. Raj has CHECKER for ACME/BOM/IMPORT, the job is ACME/BOM/IMPORT and PREPARED, and
   Raj didn't prepare it, so the answer is **ALLOW, via grant_00X**.
6. The service updates the job **only if nobody changed it since we read it** (the `version`
   number). If someone did, Raj gets "409 conflict, reload". This stops two people checking at once.
7. In the same database transaction, it writes a **JobHistory** row: who, what, stage before and after, which grant.
8. **Routing** runs: the job is now CHECKED and needs a filer. It asks the engine which filers could
   file it, picks the least-busy one, and assigns it. That's also written to history as "automation".
9. Raj gets the updated job back.

If the engine had said DENY, Raj would get `403` with the code, the sentence and the trace. If
Raj wasn't even allowed to *see* the job, he gets `404`, so he can't learn it exists.

---

## 6. The important features, each in two lines

- **Manage who has what:** access admins create and revoke grants and delegations and record absences.
  They can't touch their own access, can't hand out admin roles, and can't act outside their own scope. Every
  attempt, even a failed one, goes into the audit log.
- **"May X do Y on Z, and why?":** `POST /authorization/check` can compare several people at once
  ("why can she and he can't?"), and at a past date.
- **Jobs that need me:** `GET /jobs/waiting-for-me` is *calculated* from your grants every time,
  never stored, so it can't go out of date. A test proves every job in the list is one the engine allows.
- **History:** JobHistory (what happened to jobs), AccessAuditLog (who changed access, and failed
  attempts), AutomationLog (what the robots did). Rows are only ever added, never edited.
- **"Who could have changed it on the 3rd?":** rebuild the world as it was on the 3rd (job stage,
  grants valid then, absences then) and re-run the engine for everyone.
- **Absence / changed responsibility:** when someone goes absent, loses a grant or is
  deactivated, their open jobs are re-checked and handed to someone eligible, or flagged if
  nobody is. Changes apply on the very next request.
- **Overnight parser:** a robot user with very limited powers. It can create jobs and update a few fields
  before a human starts on the job. Running it twice changes nothing the second time ("idempotent").
- **Client users:** customers can log in and see only their own company's jobs, with staff names hidden.

---

## 7. Where the code lives (a guided tour)

Read in this order, and the whole project makes sense:

1. `src/domain/permissions.ts`: the rulebook as data (permissions, which stage each action needs, which need a reason, SoD rules).
2. `src/authz/scope.ts`: "does this scope cover this job?" (blank = any).
3. `src/authz/engine.ts`: **the heart**. `decide()` runs the 9 checks; `decideAccessChange()` runs the admin rules.
4. `src/authz/context.ts`: loads the facts from the database for the engine.
5. `src/services/jobService.ts`: doing actions on jobs (enforce → update → history → route).
6. `src/services/queueService.ts`: waiting-for-me as a database query.
7. `src/services/routingService.ts`: picks who gets a job next; re-routes when people become unavailable.
8. `src/services/historyService.ts`: history, explain, who-could-act.
9. `src/services/accessService.ts`: grants, delegations, absences, user status, audit.
10. `src/services/parserService.ts`: the overnight parser.
11. `src/http/`: login/token, routes, error format. Deliberately thin.
12. `prisma/schema.prisma`: the tables.
13. `src/seed/seed.ts`: the sample people and jobs.
14. `tests/`: `unit/engine.test.ts` (rules only), `integration/` (real HTTP + real DB).

**The database tables:** Branch, Client, User, Role, AccessGrant, Delegation, Absence, Job,
JobHistory, AccessAuditLog, AutomationLog.

---

## 8. Design choices you should be able to defend

| Choice | The one-line reason |
|---|---|
| Grants with scopes instead of many fixed roles | Real people cover "slices" of the business; avoids hundreds of roles like CHECKER_ACME_BOM_IMPORT |
| One pure engine used for everything | Enforcement, explanations, queues and routing can never disagree |
| Token holds only the user id | Revokes work instantly instead of when the token expires |
| Default deny; errors become deny | A bug causes a refusal, not a security hole |
| 404 for jobs you can't see | Don't reveal what exists, especially to customers |
| Grants are revoked, never deleted | So we can answer questions about the past |
| History stores *which grant* allowed each action | Answers "under what authority" exactly |
| Version number on jobs | Two people can't both "win" the same step |
| Filters done in SQL, not by loading all jobs | Fast at 200,000 jobs (measured: 15–62 ms) |
| Routing runs right after each change (no background worker) | Simple and enough for 120 staff; the scaling path is documented |

---

## 9. What we did NOT build (and should say so honestly)

- A configurable "automation rules" engine and event system
- Escalation of overdue jobs, notifications
- An API/screen to create new roles (roles are data rows, so today it's a seed/SQL change)
- A user interface

Why: the time budget was 4–6 hours, so the core (correct decisions, explanations, history, tests)
came first. Don't claim these exist. Say "designed for, not built".

---

## 10. Interview prep

### 30-second introduction
"I built Gatekeeper, an access-control service for a customs broker. It decides whether a person may
do an action on a shipment job, based on their role *and* which clients, branches, directions and
modes that role covers. Every decision comes with a human-readable explanation, every action records
which grant allowed it, and you can ask who *could* have changed a job at any past date. It's
TypeScript, Express and Postgres, with 65 automated tests."

### 1-minute explanation
"The core is a pure decision engine: facts in, ALLOW or DENY out, with a step-by-step trace. Access
is modeled as grants, meaning role times scope, so 'Maker everywhere, Checker for two clients' is just three
grants. The engine checks identity, workflow stage, absence, permission, scope and separation of
duties, in that order, and fails closed. Because it's pure, I reuse it for enforcement, for
'why can she and he can't', for replaying the past, for the jobs-waiting-for-me queue and for
automatic routing, so they can never disagree. Lists stay fast at 200k jobs because a user's grants are
turned into a SQL filter instead of checking jobs one by one."

### 3-minute technical walkthrough (follow the demo in README §4)
1. Log in as Sarah, `GET /auth/me`, and show the plain-English access.
2. "Why can she and he can't": compare Sarah, Raj and Alice on NF-DEMO-03, and read out the trace and the "closest grant" hint.
3. Maker-checker: Sarah is blocked on her own job; Raj checks it; Fiona files it.
4. The incident: editing a filed job gives `FILED_LOCKED`; Omar cancels it with a reason.
5. Job history showing the grant id on each step, then who-could-act on a past date.
6. Anita tries to grant herself a role: denied, and the attempt is in the audit log.
7. Run the parser twice; the second run is all UNCHANGED.

### Questions you're likely to get, with short answers
- **"Why not put roles in the JWT?"** Then a revoke wouldn't apply until the token expires. We pay
  one small DB read per request for instant effect.
- **"How is waiting-for-me guaranteed correct?"** It's computed from the same rules on every request,
  and a test cross-checks every item against the engine.
- **"What if two checkers click at once?"** The version check lets one win; the other gets 409. A test proves it.
- **"How would you scale further?"** Move routing to a background worker (outbox pattern), cache
  each user's grants for a few seconds, and partition history by date.
- **"Why is cancel_filed a separate permission?"** Cancelling a draft is routine; cancelling a filed
  customs declaration is serious. Separate verbs let you give them to different people.
- **"How would you add a two-person approval for reopening?"** Add one more check in the engine
  (a pending approval by a different admin) plus an approvals table. The engine design makes that local.
- **"What happens if the engine crashes mid-decision?"** It returns DENY / INDETERMINATE. It never fails open.
- **"What did you cut?"** See section 9. Name it before they ask.

### Things to rehearse running live
`npm run seed`, `npm run dev`, the README demo commands, `npm test` (about 6 seconds), `npm run parser:run`,
`npm run access:describe`.
