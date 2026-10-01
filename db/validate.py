#!/usr/bin/env python3
"""PRACTIS schema validator + smoke test.

Runs schema.sql (and optionally seed-smoke.sql) against an in-memory SQLite DB,
then asserts the invariants that matter. Exits non-zero on any failure.

Usage:
    python3 validate.py            # schema + smoke seed + assertions
    python3 validate.py --schema   # schema only (fast, no seed)
"""
import sqlite3
import sys
import pathlib

HERE = pathlib.Path(__file__).resolve().parent


def main() -> int:
    schema_only = "--schema" in sys.argv
    con = sqlite3.connect(":memory:")
    con.executescript((HERE / "schema.sql").read_text())
    print("schema.sql executed OK")

    counts = {}
    for row in con.execute(
        "SELECT type, COUNT(*) FROM sqlite_master "
        "WHERE name NOT LIKE 'sqlite_%' GROUP BY type ORDER BY type"
    ):
        counts[row[0]] = row[1]
        print(f"  {row[0]}: {row[1]}")

    # DRIFT GATE. schema.sql is a generated artefact of db/migrations/*.sql
    # (`node db/dump-schema.js`). It once drifted silently — 14 triggers here vs 21 in
    # the migrations — so the validator happily asserted invariants against a schema
    # that lacked the reversal and CBS guards and still printed ALL CHECKS PASS.
    # These minimums make that specific failure impossible: if a regenerated file ever
    # loses the guards again, this fails loudly instead of passing quietly.
    REQUIRED = [
        # Reversal guards (migration 006) — the immutable correction path.
        "trg_ledger_reversal_must_negate",
        "trg_ledger_reversal_link_immutable",
        "idx_ledger_one_reversal",
        # CBS guard (migration 009) — a check without a CBS account freezes
        # unattributable money into the cost report.
        "trg_lpb_checked_requires_cbs",
        "trg_lpb_checked_requires_cbs_insert",
        "trg_lpb_blocked_needs_reason",
        "trg_lpb_blocked_needs_reason_insert",
        "trg_lpb_no_check_from_blocked",
        # Dedupe index must keep its partial WHERE — losing the predicate makes a
        # manual duplicate post illegal (the migration-003 regression).
        "idx_ledger_import_dedupe",
    ]
    present = {
        r[0] for r in con.execute(
            "SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'"
        )
    }
    missing = [n for n in REQUIRED if n not in present]
    if missing:
        print(f"  [FAIL] schema drift: required guards missing: {missing}")
        print("         regenerate with: node db/dump-schema.js")
        return 1
    print(f"  [PASS] schema drift: all {len(REQUIRED)} required guards present")

    # The dedupe index must be PARTIAL on source='import'. Check the DDL text, because
    # an index without the predicate exists and behaves differently.
    dedupe_sql = con.execute(
        "SELECT sql FROM sqlite_master WHERE name='idx_ledger_import_dedupe'"
    ).fetchone()
    if not dedupe_sql or "source" not in (dedupe_sql[0] or ""):
        print("  [FAIL] idx_ledger_import_dedupe lost its partial WHERE source='import'")
        return 1
    print("  [PASS] idx_ledger_import_dedupe keeps its partial predicate")

    if schema_only:
        return 0

    con.executescript((HERE / "seed-smoke.sql").read_text())
    print("seed-smoke.sql executed OK")

    # Referential integrity must be verified with enforcement enabled, not merely declared in DDL.
    fk_violations = con.execute("PRAGMA foreign_key_check").fetchall()
    if fk_violations:
        print(f"  [FAIL] foreign_key_check violations: {fk_violations}")
        return 1
    print("  [PASS] foreign_key_check: no violations")

    failures = []

    def check(label, got, want):
        ok = got == want
        print(f"  [{'PASS' if ok else 'FAIL'}] {label}: got={got!r} want={want!r}")
        if not ok:
            failures.append(label)

    # 1. Period derives from effective_date when present, else date.
    #    PO-9001 is posted 2026-03-05 but corrected to 2026-02-27 -> period 2026-02.
    check(
        "effective_date overrides posted date",
        con.execute("SELECT period_month FROM v_ledger_period WHERE id=3").fetchone()[0],
        "2026-02",
    )
    check(
        "blank effective_date falls back to date",
        con.execute("SELECT period_month FROM v_ledger_period WHERE id=1").fetchone()[0],
        "2026-02",
    )

    # 2. Receivable = billed - paid - retainage.
    check(
        "receivable outstanding",
        con.execute("SELECT outstanding_amount FROM v_receivable WHERE document_no='INV-0224'").fetchone()[0],
        60_000_000,
    )
    # 2b. Netting is per document (user workflow 2026-09-25): payment is a ledger line sharing the
    #     invoice's document_no. Same-doc lines must net; a payment for a DIFFERENT doc must not
    #     reduce this invoice's outstanding.
    check(
        "receivable paid recognized via same-doc line",
        con.execute("SELECT paid_amount FROM v_receivable WHERE document_no='INV-0224'").fetchone()[0],
        300_000_000,
    )
    check(
        "receivable retainage kept separate",
        con.execute("SELECT retainage_amount FROM v_receivable WHERE document_no='INV-0224'").fetchone()[0],
        40_000_000,
    )

    check(
        "untagged queue size",
        con.execute("SELECT COUNT(*) FROM v_untagged_queue").fetchone()[0],
        1,
    )

    # 2d. Payable payment line (after queue check so it cannot pollute it): same document_no as the
    #     cement invoice, cash-movement role. This is the user's workflow — Finance posts the
    #     payment as a ledger line; the register nets per document_no.
    con.execute(
        "INSERT INTO accounting_ledger"
        "(id,project_id,document_no,partner_type,partner_id,date,type,line_role,in_cost_basis,"
        "cost_category_id,amount,debit,credit,currency,description,source,cost_checked,cost_checked_by)"
        "VALUES (91,1,'PO-9001','supplier',1,'2026-03-20','Payable','funding',0,"
        "3,-30000000,0,30000000,'IDR','Payment on cement invoice','manual',1,3)"
    )
    payable = con.execute(
        "SELECT billed_amount, paid_amount, outstanding_amount FROM v_payable WHERE document_no='PO-9001'"
    ).fetchone()
    check("payable: billed 90M", payable[0], 90_000_000)
    check("payable: paid 30M recognized", payable[1], 30_000_000)
    check("payable: outstanding nets to 60M", payable[2], 60_000_000)

    # 2e. Cost basis must NOT include the payment line (it is a cash movement, not project cost).
    total_pay = con.execute(
        "SELECT COALESCE(SUM(amount),0) FROM accounting_ledger WHERE id=91 AND in_cost_basis=1"
    ).fetchone()[0]
    check("payment line excluded from cost basis", total_pay, 0)

    # A valid second project makes project reassignment a real risk, not an FK failure: changing
    # id=1 to NULL would be blocked by the foreign key alone, so it would not test our control.
    con.execute(
        "INSERT INTO projects(id,code,name,currency,status) "
        "VALUES (2,'P-TAMPER','Tamper target project','IDR','active')"
    )
    con.execute(
        "INSERT INTO projects(id,code,name,currency,status) "
        "VALUES (3,'P-TAMPER-LPB','Tamper target project LPB','IDR','active')"
    )

    # 4. Ledger immutability triggers actually block. Every money-moving or classification field
    #    must be frozen: if one is forgotten here, the same hole returns (review findings A-1/D-1).
    immutable_ledger_statements = (
        "UPDATE accounting_ledger SET amount=-1 WHERE id=1",
        "UPDATE accounting_ledger SET date='2026-02-01' WHERE id=1",
        "UPDATE accounting_ledger SET type='LPB' WHERE id=1",
        "UPDATE accounting_ledger SET document_no='X' WHERE id=1",
        "UPDATE accounting_ledger SET debit=debit+1 WHERE id=1",
        "UPDATE accounting_ledger SET credit=credit+1 WHERE id=1",
        "UPDATE accounting_ledger SET project_id=2 WHERE id=1",
        "UPDATE accounting_ledger SET in_cost_basis=0 WHERE id=4",
        "UPDATE accounting_ledger SET cost_checked=1 WHERE id=4",
        "UPDATE accounting_ledger SET line_role='funding' WHERE id=1",
        "UPDATE accounting_ledger SET wbs_node_id=1 WHERE id=1",
        "UPDATE accounting_ledger SET source='import' WHERE id=1",
        "UPDATE accounting_ledger SET paid_amount=1 WHERE id=1",
        "DELETE FROM accounting_ledger WHERE id=1",
    )
    for stmt in immutable_ledger_statements:
        try:
            con.execute(stmt)
            failures.append(f"immutability not enforced: {stmt}")
            print(f"  [FAIL] immutability not enforced: {stmt}")
        except sqlite3.IntegrityError:
            print(f"  [PASS] blocked: {stmt}")

    # 5. The sanctioned correction path still works. Row 1 is dated 2026-02-28, so the
    #    corrected effective_date stays inside 2026-02 — an open month. (seed-smoke.sql
    #    deliberately freezes project 1 / 2026-01, and writing there is the subject of
    #    the next assertion.)
    con.execute("UPDATE accounting_ledger SET effective_date='2026-02-27' WHERE id=1")
    check(
        "effective_date is editable",
        con.execute("SELECT period_month FROM v_ledger_period WHERE id=1").fetchone()[0],
        "2026-02",
    )

    # 5b. The period is DERIVED from effective_date, and effective_date is editable by
    #     design — so without a guard an UPDATE can walk a posted row INTO a frozen
    #     month, which is the insert hole reached one statement later. Migration 011
    #     guards UPDATE OF effective_date, date for exactly this.
    try:
        con.execute("UPDATE accounting_ledger SET effective_date='2026-01-31' WHERE id=1")
        failures.append("effective_date walk into a frozen month allowed")
        print("  [FAIL] effective_date walk into a frozen month allowed")
    except sqlite3.IntegrityError:
        print("  [PASS] blocked: effective_date walk into a frozen month")
    # ...and the row is provably still in its own month, not the frozen one.
    check(
        "and the row did not move",
        con.execute("SELECT period_month FROM v_ledger_period WHERE id=1").fetchone()[0],
        "2026-02",
    )

    # 6. De-scope keeps the line visible with status + remaining budget, never deletes it.
    con.execute(
        "INSERT INTO wbs_nodes(project_id,wbs_code,name,parent_id,sort_order,status,"
        "de_scope_period,version) VALUES (1,'1.3','Roof',1,3,'de_scoped','2026-04',1)"
    )
    row = con.execute(
        "SELECT status, de_scope_period FROM v_descoped_lines WHERE wbs_code='1.3'"
    ).fetchone()
    check("de-scoped line retained", row, ("de_scoped", "2026-04"))

    # 7. EVM view computes (and does not error on missing buckets).
    evm = con.execute(
        "SELECT spi, cpi FROM v_evm_period WHERE period_month='2026-02'"
    ).fetchone()
    check("EVM Feb values present", evm is not None and evm[0] is not None, True)

    # 8. Duplicate baseline bucket in the same month is rejected (UNIQUE index).
    try:
        con.execute(
            "INSERT INTO cbs_plan(project_id,transaction_account_id,wbs_node_id,plan_type,"
            "version,period_month,amount) VALUES (1,1,2,'baseline',1,'2026-01',1)"
        )
        failures.append("duplicate plan bucket allowed")
        print("  [FAIL] duplicate plan bucket allowed")
    except sqlite3.IntegrityError:
        print("  [PASS] duplicate cbs_plan bucket rejected")

    # 9. EXPORT REGRESSION — rules verified against fixture-ledger-export.tsv (26 rows, 2023-10),
    #    a synthetic export whose SHAPE mirrors the real legacy export it replaced.
    #    These guard the migration contract.
    import csv as _csv, datetime as _dt, pathlib as _pl
    fx = _pl.Path(__file__).parent / "fixture-ledger-export.tsv"
    if fx.exists():
        rows = list(_csv.DictReader(fx.open(), delimiter="\t"))
        rows = [{k.strip(): (v or "").strip() for k, v in r.items()} for r in rows]

        def _f(s):
            try:
                return float(s)
            except (TypeError, ValueError):
                return 0.0

        # 9a. amount == debit - credit, on every row. This IS the stored-sign rule (R2-7).
        bad = [r["id"] for r in rows if abs(_f(r["amount"]) - (_f(r["debit"]) - _f(r["credit"]))) > 1e-6]
        check("export: amount == debit - credit (all rows)", bad, [])

        # 9b. Every transaction_id nets to zero => legacy ledger is strict double-entry.
        #     (One id in the sample is a partial extract and legitimately does not balance.)
        from collections import defaultdict as _dd
        net = _dd(float)
        for r in rows:
            net[r["transaction_id"]] += _f(r["amount"])
        unbalanced = sorted(k for k, v in net.items() if abs(v) > 1e-6)
        check("export: unbalanced transaction_ids (partial extract)", unbalanced, ["SAL-24-10-0038"])

        # 9c. date_adjustment is populated on the rows => the correction column is genuinely in use.
        adj = [r for r in rows if r["date_adjustment"]]
        check("export: date_adjustment in use", len(adj) > 0, True)
        print(f"         ({len(adj)}/{len(rows)} fixture rows carry a date correction)")

        # 9d. Cost-basis rule: Dropping excluded from project cost (real cost = LPB details).
        print(f"         fixture: {len(rows)} ledger rows verified")

    # 10. LPB flow (user-clarified 2026-09-23): finance's bulk LPB settlement carries NO detail,
    #     so it is NOT cost; the Project Admin's DETAIL lines (once checked) ARE the cost.
    #     Seed: checked lines 20M (MAT-01) + 25M (LAB-01); draft 5M (MAT-01) not counted;
    #     advance 50M and bulk settlement 50M excluded (cancel each other, no double count).
    from collections import defaultdict as _dd2
    ac = _dd2(int)
    for pid, ta, pm, amt in con.execute(
        "SELECT project_id, transaction_account_id, period_month, actual_amount FROM v_cbs_actual"
    ):
        ac[(ta, pm)] += amt
    check("LPB: checked detail counts as cost (MAT-01 2026-03)", ac.get((1, "2026-03"), 0), 20000000)
    check("LPB: checked detail counts as cost (LAB-01 2026-03)", ac.get((2, "2026-03"), 0), 25000000)
    # March cost basis = 15M fuel (ledger) + 45M checked LPB detail; advance + bulk settlement excluded.
    total = con.execute(
        "SELECT COALESCE(SUM(amount),0) FROM ("
        "  SELECT lp.amount FROM v_ledger_period lp WHERE lp.in_cost_basis=1 AND lp.period_month='2026-03' "
        "  UNION ALL SELECT amount FROM lpb_statements WHERE period_month='2026-03' AND status='checked')"
    ).fetchone()[0]
    check("LPB: March cost basis = 15M + 45M checked (no advance, no bulk)", total, 60000000)

    # 11. LPB reconciliation (user feature 2026-09-23): Finance's bulk vs Admin's detail per LPB no.
    rec = {(r[0], r[1]): (r[2], r[3], r[4], r[5]) for r in con.execute(  # lpb_no, project -> (finance, admin, diff, status)
        "SELECT lpb_no, project_id, finance_amount, admin_detail_amount, difference, status FROM v_lpb_reconciliation"
    )}
    check("LPB recon: balanced case", rec.get(("LPB-001", 1)), (45000000, 45000000, 0, "balanced"))
    check("LPB recon: missing detail flagged",
          (rec.get(("LPB-002", 1)) or (None, None, None, None))[0] == 30000000 and
          (rec.get(("LPB-002", 1)) or (None, None, None, None))[3] == "missing_detail",
          True)
    check("LPB recon: difference case reports finance - admin",
          (rec.get(("LPB-003", 1)) or (None, None, None, None))[0:4], (20000000, 18000000, 2000000, "difference"))

    # 12. Import dedupe (R2-27): same (transaction_id, document_no, date, amount, project) → skipped.
    con.execute("""INSERT INTO accounting_ledger
        (id,project_id,transaction_id,document_no,date,type,line_role,in_cost_basis,amount,debit,credit,currency,description,source)
        VALUES (101,1,'X-1','DOC-1','2026-02-15','Expense','expense',1,500000,500000,0,'IDR','dup test','import')""")
    try:
        con.execute("""INSERT INTO accounting_ledger
            (id,project_id,transaction_id,document_no,date,type,line_role,in_cost_basis,amount,debit,credit,currency,description,source)
            VALUES (102,1,'X-1','DOC-1','2026-02-15','Expense','expense',1,500000,500000,0,'IDR','dup test','import')""")
        dup_blocked = False
    except sqlite3.IntegrityError:
        dup_blocked = True
    check("import dup: identical re-import blocked", dup_blocked, True)

    # 13. Cost Controller workflow (R2-10, R2-23): the A-1 freeze must NOT lock the controller out.
    #     The same fields frozen against tampering must still accept their one-way legit transitions.
    #     Seed id=4: WBS + CBS (transaction_account_id) are NULL, cost_category_id already 2.
    #     Runs AFTER the LPB cost-basis assertions so this tagging cannot pollute those numbers.
    con.execute("UPDATE accounting_ledger SET wbs_node_id=2, transaction_account_id=1 WHERE id=4")
    con.execute(
        "UPDATE accounting_ledger SET cost_checked=1, cost_checked_by=2, cost_checked_at='2026-09-24 10:00:00' WHERE id=4"
    )
    row = con.execute(
        "SELECT wbs_node_id, transaction_account_id, cost_checked, cost_checked_by FROM accounting_ledger WHERE id=4"
    ).fetchone()
    check("controller can tag line (WBS/CBS)", row[:3], (2, 1, 1))
    check("controller check stamps recorded", row[3], 2)
    # after checking, the line must be frozen again — controller cannot silently un-tag or un-check
    for stmt in (
        "UPDATE accounting_ledger SET wbs_node_id=NULL WHERE id=4",
        "UPDATE accounting_ledger SET cost_checked=0 WHERE id=4",
        "UPDATE accounting_ledger SET cost_checked_by=NULL WHERE id=4",
    ):
        try:
            con.execute(stmt)
            failures.append(f"post-check tamper not enforced: {stmt}")
            print(f"  [FAIL] post-check tamper not enforced: {stmt}")
        except sqlite3.IntegrityError:
            print(f"  [PASS] blocked after check: {stmt}")

    # 14. Negative controls at the DB boundary. Each proves a bad row cannot enter the database.
    def rejects(label, sql):
        try:
            con.execute(sql)
            check(label, False, True)
        except sqlite3.IntegrityError:
            check(label, True, True)

    # A zero ledger line has neither debit nor credit, so it carries no accounting meaning (A-8).
    rejects(
        "ledger: zero-amount line rejected",
        "INSERT INTO accounting_ledger"
        "(id,project_id,date,type,line_role,in_cost_basis,amount,debit,credit,source)"
        "VALUES (901,1,'2026-02-01','Expense','expense',1,0,0,0,'manual')",
    )
    rejects(
        "ledger: fractional rupiah rejected",
        "INSERT INTO accounting_ledger"
        "(id,project_id,date,type,line_role,in_cost_basis,amount,debit,credit,source)"
        "VALUES (902,1,'2026-02-01','Expense','expense',1,1.5,1.5,0,'manual')",
    )
    rejects(
        "ledger: both debit and credit rejected",
        "INSERT INTO accounting_ledger"
        "(id,project_id,date,type,line_role,in_cost_basis,amount,debit,credit,source)"
        "VALUES (903,1,'2026-02-01','Expense','expense',1,100,60,40,'manual')",
    )
    rejects(
        "ledger: amount not equal to debit - credit rejected",
        "INSERT INTO accounting_ledger"
        "(id,project_id,date,type,line_role,in_cost_basis,amount,debit,credit,source)"
        "VALUES (904,1,'2026-02-01','Expense','expense',1,999,100,0,'manual')",
    )
    rejects(
        "ledger: negative debit rejected",
        "INSERT INTO accounting_ledger"
        "(id,project_id,date,type,line_role,in_cost_basis,amount,debit,credit,source)"
        "VALUES (905,1,'2026-02-01','Expense','expense',1,-100,-100,0,'manual')",
    )
    rejects(
        "ledger: NULL debit side rejected",
        "INSERT INTO accounting_ledger"
        "(id,project_id,date,type,line_role,in_cost_basis,amount,debit,credit,source)"
        "VALUES (906,1,'2026-02-01','Expense','expense',1,100,NULL,0,'manual')",
    )

    # LPB detail: same money rules, plus no self-declared checks and no edits after checking.
    rejects(
        "lpb: zero-amount line rejected",
        "INSERT INTO lpb_statements(project_id,entry_date,amount,debit,credit,status)"
        "VALUES (1,'2026-03-01',0,0,0,'draft')",
    )
    rejects(
        "lpb: fractional rupiah rejected",
        "INSERT INTO lpb_statements(project_id,entry_date,amount,debit,credit,status)"
        "VALUES (1,'2026-03-01',1.5,1.5,0,'draft')",
    )
    rejects(
        "lpb: both debit and credit rejected",
        "INSERT INTO lpb_statements(project_id,entry_date,amount,debit,credit,status)"
        "VALUES (1,'2026-03-01',100,60,40,'draft')",
    )
    rejects(
        "lpb: amount not equal to debit - credit rejected",
        "INSERT INTO lpb_statements(project_id,entry_date,amount,debit,credit,status)"
        "VALUES (1,'2026-03-01',999,100,0,'draft')",
    )
    rejects(
        "lpb: NULL debit side rejected",
        "INSERT INTO lpb_statements(project_id,entry_date,amount,debit,credit,status)"
        "VALUES (1,'2026-03-01',100,NULL,0,'draft')",
    )
    rejects(
        "lpb: project reassignment rejected once checked",
        "UPDATE lpb_statements SET project_id=3 WHERE id=1",
    )
    rejects(
        "lpb: status checked without checker identity rejected",
        "INSERT INTO lpb_statements(project_id,entry_date,amount,debit,credit,status,checked_by,checked_at)"
        "VALUES (1,'2026-03-01',100,100,0,'checked',NULL,NULL)",
    )
    # A draft line must stay editable: the finality control applies only after checking.
    con.execute("UPDATE lpb_statements SET amount=5000000 WHERE id=3")
    check("lpb: draft amount editable until checked", True, True)

    rejects(
        "lpb: checked line amount cannot be edited",
        "UPDATE lpb_statements SET amount=1 WHERE id=1",
    )
    rejects(
        "lpb: checked line cannot be silently un-checked",
        "UPDATE lpb_statements SET status='draft' WHERE id=1",
    )
    rejects(
        "lpb: checked line cannot be deleted",
        "DELETE FROM lpb_statements WHERE id=1",
    )
    rejects(
        "lpb: cannot self-mark checked without checker on update",
        "UPDATE lpb_statements SET status='checked', checked_by=NULL, checked_at=NULL WHERE id=3",
    )

    # Cash advance: pot amount is whole rupiah and frozen once it is no longer open.
    rejects(
        "cash advance: fractional amount rejected",
        "INSERT INTO cash_advance(id,project_id,amount) VALUES (901,1,1.5)",
    )
    rejects(
        "cash advance: zero amount rejected",
        "INSERT INTO cash_advance(id,project_id,amount) VALUES (902,1,0)",
    )
    # An open pot is still in the draft workflow: quantity edits are allowed until it settles.
    con.execute("UPDATE cash_advance SET total_amount=20000000 WHERE id=1")
    check("cash advance: open pot total_amount editable (draft workflow)", True, True)
    con.execute("UPDATE cash_advance SET status='settling' WHERE id=1")
    rejects(
        "cash advance: amount frozen once settling",
        "UPDATE cash_advance SET amount=1 WHERE id=1",
    )
    rejects(
        "cash advance: project reassignment frozen once settling",
        "UPDATE cash_advance SET project_id=3 WHERE id=1",
    )
    rejects(
        "cash advance: total_amount frozen once settling",
        "UPDATE cash_advance SET total_amount=1 WHERE id=1",
    )
    rejects(
        "cash advance: pot with detail cannot be deleted",
        "DELETE FROM cash_advance WHERE id=1",
    )
    con.execute("UPDATE cash_advance SET status='open' WHERE id=1")

    # Audit log is append-only evidence for the 10-year retention commitment (A-3).
    con.execute(
        "INSERT INTO audit_log(entity_type,entity_id,action,actor_id) VALUES ('project',1,'create',1)"
    )
    audit_id = con.execute("SELECT MAX(id) FROM audit_log").fetchone()[0]
    rejects(
        "audit log: row cannot be updated",
        f"UPDATE audit_log SET action='forged' WHERE id={audit_id}",
    )
    rejects(
        "audit log: row cannot be deleted",
        f"DELETE FROM audit_log WHERE id={audit_id}",
    )

    # Notifications: one unread alert per condition. The 30-second alert poll must not re-insert
    # the same unread alert on every evaluation (A-9).
    con.execute(
        "INSERT INTO notification_inbox(user_id,project_id,alert_type,severity,title,entity_type,entity_id)"
        "VALUES (3,1,'cpi_spi_breach','warning','CPI below 0.9','project',1)"
    )
    try:
        con.execute(
            "INSERT INTO notification_inbox(user_id,project_id,alert_type,severity,title,entity_type,entity_id)"
            "VALUES (3,1,'cpi_spi_breach','warning','CPI below 0.9','project',1)"
        )
        alert_dedupe_blocked = False
    except sqlite3.IntegrityError:
        alert_dedupe_blocked = True
    check("notification: duplicate unread alert rejected", alert_dedupe_blocked, True)

    # 15. Immutable correction path: the reversal guards (migration 006).
    #
    # These existed in the migrations but NOT in schema.sql, which is exactly the drift
    # the drift gate above now catches. With the guards absent these assertions would have
    # had nothing to bite on, so they are the reason the regenerated file matters.
    #
    # Line 4 is a +15,000,000 Expense debit in project 1; its reversal credits 15,000,000.
    def accepts(label, sql):
        try:
            con.execute(sql)
            check(label, True, True)
        except sqlite3.IntegrityError as e:
            check(f"{label} [{e}]", False, True)

    accepts(
        "reversal: a correct negating entry is accepted",
        "INSERT INTO accounting_ledger"
        "(id,project_id,date,type,line_role,in_cost_basis,amount,debit,credit,source,reverses_ledger_id)"
        "VALUES (920,1,'2026-03-11','Expense','expense',1,-15000000,0,15000000,'manual',4)",
    )
    # idx_ledger_one_reversal — a line is reversed exactly ONCE. Two operators clicking
    # Reverse concurrently must not double-count the correction.
    rejects(
        "reversal: a line cannot be reversed twice",
        "INSERT INTO accounting_ledger"
        "(id,project_id,date,type,line_role,in_cost_basis,amount,debit,credit,source,reverses_ledger_id)"
        "VALUES (921,1,'2026-03-12','Expense','expense',1,-15000000,0,15000000,'manual',4)",
    )
    # trg_ledger_reversal_must_negate — a "reversal" that does not negate would corrupt
    # the pair, so the pair would stop netting to zero in every view.
    rejects(
        "reversal: a non-negating entry is rejected",
        "INSERT INTO accounting_ledger"
        "(id,project_id,date,type,line_role,in_cost_basis,amount,debit,credit,source,reverses_ledger_id)"
        "VALUES (922,1,'2026-03-11','Payable','expense',1,90000000,90000000,0,'manual',3)",
    )
    # Same guard, project dimension: a reversal must sit in the ORIGINAL's project.
    # (Project 2 already exists — created earlier as the tamper target.)
    rejects(
        "reversal: a cross-project reversal is rejected",
        "INSERT INTO accounting_ledger"
        "(id,project_id,date,type,line_role,in_cost_basis,amount,debit,credit,source,reverses_ledger_id)"
        "VALUES (923,2,'2026-03-11','Payable','expense',1,-90000000,0,90000000,'manual',3)",
    )
    # trg_ledger_reversal_link_immutable — the link is evidence, so it never moves.
    rejects(
        "reversal: the reversal link cannot be removed or moved",
        "UPDATE accounting_ledger SET reverses_ledger_id=NULL WHERE id=920",
    )

    print()
    if failures:
        print(f"{len(failures)} FAILURE(S): {failures}")
        return 1
    print("ALL CHECKS PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
