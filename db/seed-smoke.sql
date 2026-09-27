-- PRACTIS smoke test: seed one realistic project, then exercise the views.
-- Scenario: warehouse build, contract Rp 1,000,000,000 (IDR, whole rupiah).
--   WBS 1.1 Foundation (budget Rp 300,000,000 over 3 months)
--   WBS 1.2 Steel structure (budget Rp 500,000,000 over 4 months)
--   Cash: client invoices 40% (Rp 400,000,000), pays Rp 300,000,000, Rp 40,000,000 held as retainage.
--   Costs: cement Rp 90,000,000 (CBS MAT-01) in month 2.
--   Progress: foundation milestone "install" ticked → 60%.
-- Expected: receivable outstanding = 400,000,000 - 300,000,000 - 40,000,000 = 60,000,000
--           SPI/CPI computed, not null.

PRAGMA foreign_keys = ON;

INSERT INTO app_settings(key,value) VALUES ('base_currency','IDR'), ('fx_enabled','0');

INSERT INTO teams(id,code,name) VALUES (1,'PC','Project Controls');
INSERT INTO users(id,email,full_name,password_hash,team_id,is_system_admin) VALUES
  (1,'admin@practis.local','Admin','x',1,1),
  (2,'pm@practis.local','PM','x',1,0),
  (3,'cc@practis.local','Cost Controller','x',1,0),
  (4,'fin@practis.local','Finance','x',1,0),
  (5,'pa@practis.local','Project Admin','x',1,0);

INSERT INTO roles(code,name,domain) VALUES
  ('administrator','Administrator','system'),
  ('project_manager','Project Manager','project'),
  ('project_controller','Project Controller','schedule'),
  ('cost_controller','Cost Controller','cost'),
  ('finance','Finance','money'),
  ('project_admin','Project Admin','entry'),
  ('viewer','Viewer','readonly');

INSERT INTO industry_types(id,name,description) VALUES (1,'Manufacturing','Manufacturing / production');
INSERT INTO project_types(id,name,description) VALUES (1,'Construction','Build & install');
INSERT INTO clients(id,code,name,industry_id,payment_terms_days)
  VALUES (1,'CLI-001','PT Maju Jaya',1,30);
INSERT INTO suppliers(id,code,name,supplier_type) VALUES (1,'SUP-001','PT Semen Nusantara','material');

INSERT INTO cost_categories(id,code,name,is_receivable,is_payable,is_cash_in,is_cash_out,is_retainage) VALUES
  (1,'RCV','Receivable',1,0,0,0,0),
  (2,'PAY','Payable',0,1,0,0,0),
  (3,'CASHIN','Cash In',0,0,1,0,0),
  (4,'CASHOUT','Cash Out',0,0,0,1,0),
  (5,'RETAIN','Retainage Receivable',1,0,0,0,1);

INSERT INTO chart_of_accounts(id,code,name,account_type,normal_side) VALUES
  (1,'1100','Accounts Receivable','asset','debit'),
  (2,'4100','Contract Revenue','income','credit'),
  (3,'5100','Material Cost','expense','debit');
INSERT INTO cashflow_categories(id,code,name,direction) VALUES (1,'OP','Operating','in'),(2,'OPX','Operating Out','out');
INSERT INTO resource_categories(id,code,name) VALUES (1,'LAB','Labor'),(2,'MAT','Material'),(3,'EQP','Equipment');

INSERT INTO wbs_code(id,code,name,parent_code) VALUES
  (1,'1','Warehouse Build',NULL),
  (2,'1.1','Foundation','1'),
  (3,'1.2','Steel Structure','1');
INSERT INTO rbs_code(id,code,name,resource_category_id) VALUES
  (1,'L','Labor',1),(2,'M','Material',2),(3,'E','Equipment',3);
INSERT INTO transaction_accounts(id,code,name,cost_category_id,cashflow_category_id,chart_of_account_id) VALUES
  (1,'MAT-01','Material',3,2,3),
  (2,'LAB-01','Labor',3,2,3),
  (3,'RCV-01','Client Receivable',1,1,1),
  (4,'CASHIN-01','Cash In',3,1,1),
  (5,'DROP-01','Cash Advance (Dropping)',4,2,3);

INSERT INTO projects(id,code,name,client_id,project_type_id,contract_amount,currency,revenue_method,
                     payment_terms_days,start_date,end_date,status)
  VALUES (1,'PRJ-001','Warehouse Build',1,1,1000000000,'IDR','poc',30,'2026-01-01','2026-06-30','active');

INSERT INTO user_roles(id,user_id,role_code,project_id) VALUES
  (1,2,'project_manager',1),(2,3,'cost_controller',1),(3,4,'finance',1),(4,5,'project_admin',1);

INSERT INTO wbs_nodes(id,project_id,wbs_code,name,parent_id,sort_order,start_date,end_date,
                      baseline_start,baseline_end,status,is_control_account,version) VALUES
  (1,1,'1','Warehouse Build',NULL,0,'2026-01-01','2026-06-30','2026-01-01','2026-06-30','active',0,1),
  (2,1,'1.1','Foundation',1,1,'2026-01-01','2026-03-31','2026-01-01','2026-03-31','active',1,1),
  (3,1,'1.2','Steel Structure',1,2,'2026-03-01','2026-06-30','2026-03-01','2026-06-30','active',1,1);

INSERT INTO progress_milestones(id,wbs_node_id,seq,name,pct_weight,planned_date,ticked,ticked_at,ticked_by) VALUES
  (1,2,1,'mobilize',10,'2026-01-10',1,'2026-01-12',5),
  (2,2,2,'install',50,'2026-02-20',1,'2026-02-22',5),
  (3,2,3,'test',20,'2026-03-15',0,NULL,NULL),
  (4,2,4,'handover',20,'2026-03-30',0,NULL,NULL);

INSERT INTO wbs_progress(id,wbs_node_id,period_month,pct_complete,source,reported_by) VALUES
  (1,2,'2026-02',60,'milestones',5);

-- Cost baseline: monthly buckets. Foundation Rp 300M: Jan 90, Feb 120, Mar 90. Steel Rp 500M: Mar 150, Apr 200, May 150.
INSERT INTO cbs_plan(id,project_id,transaction_account_id,wbs_node_id,plan_type,version,period_month,amount) VALUES
  (1,1,1,2,'baseline',1,'2026-01',90000000),
  (2,1,2,2,'baseline',1,'2026-02',120000000),
  (3,1,1,2,'baseline',1,'2026-03',90000000),
  (4,1,1,3,'baseline',1,'2026-03',150000000),
  (5,1,1,3,'baseline',1,'2026-04',200000000),
  (6,1,1,3,'baseline',1,'2026-05',150000000);

INSERT INTO rbs_load(id,project_id,wbs_node_id,rbs_code,transaction_account_id,description,rate,units,unit_label,total_amount,version) VALUES
  (1,1,2,'M',1,'Cement 400t',225000,400,'tonne',90000000,1);

-- LEDGER. Signs: income/credit = NEGATIVE, cost/debit = POSITIVE.
-- 1) Invoice client Rp 400M (receivable, credit → negative)
-- 1) Progress claim: receivable side. credit → NEGATIVE per R2-7 / verified real data.
INSERT INTO accounting_ledger(id,project_id,document_no,partner_type,partner_id,date,effective_date,type,line_role,in_cost_basis,
       cost_category_id,chart_of_account_id,cashflow_category_id,transaction_account_id,wbs_node_id,
       amount,debit,credit,retainage_amount,paid_amount,currency,description,source,cost_checked,cost_checked_by) VALUES
  (1,1,'INV-0224','client',1,'2026-02-28',NULL,'Receivable','receivable',0,1,1,1,3,2,-400000000,0,400000000,40000000,300000000,'IDR','Progress claim 40%','manual',1,3);
-- 2) Payment received Rp 300M cash-in (debit → positive), same document_no
INSERT INTO accounting_ledger(id,project_id,document_no,partner_type,partner_id,date,type,line_role,in_cost_basis,
       cost_category_id,chart_of_account_id,cashflow_category_id,transaction_account_id,wbs_node_id,
       amount,debit,credit,currency,description,source,cost_checked,cost_checked_by) VALUES
  (2,1,'INV-0224','client',1,'2026-03-25','Receivable','funding',0,3,1,1,4,NULL,300000000,300000000,0,'IDR','Payment received','manual',1,3);
-- 3) Cement invoice from supplier Rp 90M, CBS MAT-01 + WBS 1.1, Finance posted wrong month → CC corrected
INSERT INTO accounting_ledger(id,project_id,document_no,partner_type,partner_id,date,effective_date,type,line_role,in_cost_basis,
       cost_category_id,chart_of_account_id,cashflow_category_id,transaction_account_id,wbs_node_id,
       amount,debit,credit,currency,description,source,cost_checked,cost_checked_by) VALUES
  (3,1,'PO-9001','supplier',1,'2026-03-05','2026-02-27','Payable','expense',1,2,3,2,1,2,90000000,90000000,0,'IDR','Cement delivery','manual',1,3);
-- 4) Untagged cost line (Finance posted, Cost Controller has not tagged yet)
INSERT INTO accounting_ledger(id,project_id,document_no,partner_type,partner_id,date,type,line_role,in_cost_basis,
       cost_category_id,cashflow_category_id,amount,debit,credit,currency,description,source,cost_checked) VALUES
  (4,1,'PO-9002','supplier',1,'2026-03-10','Expense','expense',1,2,2,15000000,15000000,0,'IDR','Fuel','import',0);
-- 5) Cash advance (Dropping) Rp 50M — CASH MOVEMENT, not project cost (in_cost_basis=0).
--    Its real cost arrives later as CHECKED lpb_statements lines (Project Admin detail + Cost
--    Controller check). Counting both would double-count.
INSERT INTO accounting_ledger(id,project_id,document_no,partner_type,partner_id,date,type,line_role,in_cost_basis,
       cost_category_id,cashflow_category_id,transaction_account_id,amount,debit,credit,currency,description,source,cost_checked,cost_checked_by) VALUES
  (5,1,'DROP-001','employee',1,'2026-03-02','Dropping','dropping',0,2,2,5,50000000,50000000,0,'IDR','Cash advance issued','manual',1,3);
-- 6) Finance posts the LPB SETTLEMENT in bulk (no detail in the ledger — user's actual workflow).
--    in_cost_basis=0: the detail lives in lpb_statements, which v_cbs_actual reads directly.
--    This bulk = 45M, matching the CHECKED detail lines below (reconciliation = balanced).
INSERT INTO accounting_ledger(id,project_id,document_no,partner_type,partner_id,date,type,line_role,in_cost_basis,
       cost_category_id,cashflow_category_id,transaction_account_id,amount,debit,credit,currency,description,source,cost_checked,cost_checked_by) VALUES
  (6,1,'LPB-001','employee',1,'2026-03-31','LPB','expense',0,2,2,5,-45000000,0,45000000,'IDR','LPB Oct settlement (bulk)','manual',1,3);
-- 8) Finance's bulk LPB for April 2026 — admin detail not yet recorded (reconciliation = missing_detail)
INSERT INTO accounting_ledger(id,project_id,document_no,partner_type,partner_id,date,type,line_role,in_cost_basis,
       cost_category_id,cashflow_category_id,transaction_account_id,amount,debit,credit,currency,description,source,cost_checked,cost_checked_by) VALUES
  (8,1,'LPB-002','employee',1,'2026-04-30','LPB','expense',0,2,2,5,-30000000,0,30000000,'IDR','LPB Apr settlement (bulk)','manual',1,3);
-- 7) Project Admin's LPB DETAIL lines (the real cost) — checked by Cost Controller → actuals.
--    The cash_advance master row: the advance is one pot per project; the LPB lines reference it.
INSERT INTO cash_advance(id,project_id,advance_no,sequence,recipient_type,recipient_id,amount,issued_date)
  VALUES (1,1,'DROP-001',1,'employee',1,50000000,'2026-03-02');
INSERT INTO lpb_statements(id,cash_advance_id,project_id,lpb_no,period_month,entry_date,description,
       debit,credit,amount,transaction_account_id,wbs_node_id,status,checked_by,checked_at) VALUES
  (1,1,1,'LPB-001','2026-03','2026-03-15','Site materials (tools)',20000000,0,20000000,1,2,'checked',3,'2026-03-20 10:00:00'),
  (2,1,1,'LPB-001','2026-03','2026-03-22','Subcontractor day labor',25000000,0,25000000,2,2,'checked',3,'2026-03-22 15:00:00'),
  (3,1,1,'LPB-001','2026-03','2026-03-28','Site fuel',5000000,0,5000000,1,1,'draft',NULL,NULL);

-- 7b) DIFFERENCE case: Finance's bulk (LPB-003 = 20M) does not match Admin's checked detail (18M).
--     Proves the 'difference' branch reports finance - admin = 2,000,000 (not 0, not missing_detail).
INSERT INTO accounting_ledger(id,project_id,document_no,partner_type,partner_id,date,type,line_role,in_cost_basis,
       cost_category_id,cashflow_category_id,transaction_account_id,amount,debit,credit,currency,description,source,cost_checked,cost_checked_by) VALUES
  (9,1,'LPB-003','employee',1,'2026-05-31','LPB','expense',0,2,2,5,-20000000,0,20000000,'IDR','LPB May settlement (bulk)','manual',1,3);
INSERT INTO cash_advance(id,project_id,advance_no,sequence,recipient_type,recipient_id,amount,issued_date)
  VALUES (2,1,'DROP-002',1,'employee',1,20000000,'2026-05-02');
INSERT INTO lpb_statements(id,cash_advance_id,project_id,lpb_no,period_month,entry_date,description,
       debit,credit,amount,transaction_account_id,wbs_node_id,status,checked_by,checked_at) VALUES
  (4,2,1,'LPB-003','2026-05','2026-05-20','Site materials (May)',18000000,0,18000000,1,2,'checked',3,'2026-05-25 10:00:00');

INSERT INTO revenue_recognized(project_id,period_month,method,basis_pct,amount,cumulative) VALUES
  (1,'2026-02','poc',60,600000000,600000000);

INSERT INTO acceptance_register(project_id,wbs_node_id,certificate_no,description,percentage_progress,handover_date,accepted_date,status) VALUES
  (1,2,'BAST-001','Foundation handover',60,'2026-02-25','2026-02-27','accepted');

INSERT INTO frozen_periods(project_id,period_month,frozen_by) VALUES (1,'2026-01',2);
INSERT INTO project_reports(project_id,period_month,status,spi,cpi,generated_at) VALUES
  (1,'2026-01','frozen',1.0,1.0,'2026-02-03 09:00:00');
