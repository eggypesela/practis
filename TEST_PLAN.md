# PRACTIS — Test Plan (scaffold)

Per-module test IDs. TDD RED→GREEN. Full suite green before commit.

## S1 — Scaffold boot (server.js, migrate, seed)

| ID | Test | Expected |
|----|------|----------|
| S1.1 | migrate runs on empty DB | schema v2, tables exist, idempotent re-run |
| S1.2 | seed creates admin + project | user admin@practis.local, roles seeded, project PRJ-2026 |
| S1.3 | server boots on PORT | GET / redirects to /login (unauthenticated) |
| S1.4 | login with seed creds | 302 → /, session cookie set |
| S1.5 | GET / (authed) | 200, dashboard HTML renders KPI numbers |
| S1.6 | GET /ledger (authed) | 200, ledger table renders rows |
| S1.7 | logout | session revoked, redirect to /login |

## A1 — Auth

| ID | Test | Expected |
|----|------|----------|
| A1.1 | wrong password | 401, error shown, no cookie |
| A1.2 | unknown email | 401 |
| A1.3 | expired session | treated as logged out |
| A1.4 | API guard (stub for later) | 401 JSON |

## L1 — Ledger

*(next feature — tag queue, add-entry, immutability)*

## Traceability

Scaffold maps to TECH-SPEC: routes §6.1 (/, /ledger), TS-02 sessions (skeleton),
TS-01 auth (PBKDF2 placeholder → Argon2id on auth feature).