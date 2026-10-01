-- 010_project_scope_backfill.sql
--
-- Populates `user_roles.project_id`, the per-project junction PRD §2.3 specifies
-- ("users are assigned a role PER PROJECT — PM sees own projects; Finance sees
-- all cost data; Viewer sees assigned dashboards").
--
-- WHY THIS MIGRATION IS NEEDED BEFORE ENFORCEMENT CAN BE TURNED ON
-- ---------------------------------------------------------------
-- `user_roles.project_id` has existed since 001 and was NULL in every row and
-- read by zero code. `projectContext` resolved the project from a raw `?project=N`
-- query parameter with no authorization check, so any signed-in user could read
-- and write any project by changing one number.
--
-- Enforcing "assigned only" against a column of NULLs would refuse EVERY existing
-- account access to their own install — so decision 4A (the owner) fixes the order:
-- backfill the real assignment FIRST, enforce second. This migration is step 2 of
-- that sequence. It is deliberately DATA-ONLY (no DDL) and safe to run before or
-- after enforcement is switched on.
--
-- WHAT IT ASSIGNS, AND THE RULE FOR EACH
-- --------------------------------------
--   1. Organisation-wide roles (administrator, finance, human_capital,
--      procurement) and system admins: remain GLOBAL (project_id IS NULL).
--      Finance sees all cost data by design (PRD §2.3), so scoping it to one
--      project would break the role. This list must stay in step with
--      ORG_WIDE_ROLES in src/lib/permissions.js.
--   2. Every other role (project_admin, project_manager, cost_controller,
--      project_controller, viewer): scoped to EVERY project that existed at
--      migration time. This is the "assign all four accounts to PRJ-2026"
--      decision (1A) generalised: no existing account loses access, and the
--      grants are visible and editable on the admin screen from now on.
--   3. A user with NO role row at all is left alone — there is nothing to scope.
--
-- WHY "ALL EXISTING PROJECTS" RATHER THAN A HAND-MAPPED LIST
-- ----------------------------------------------------------
-- At migration time the install has exactly one project (PRJ-2026), and that is
-- the project all four accounts actually work on. Writing them a grant for every
-- project that exists makes the backfill correct for a single-project install and
-- still lossless for a multi-project one. Subsequent projects get NO automatic
-- grant — a new project is a deliberate assignment, which is the whole point.
--
-- GRANTS ARE DERIVED FROM THE EXISTING ROLE ROW, not invented, so each scoped row
-- carries the role the roster already shows. A user holding several roles gets one
-- scoped row per role per project (the unique key is (user_id, role_code,
-- project_id)).
--
-- IDEMPOTENT: `INSERT OR IGNORE` against that unique key means re-running (or
-- running against an install created from schema.sql where the grants already
-- exist) is a no-op rather than an error.

INSERT OR IGNORE INTO user_roles (user_id, role_code, project_id, granted_by)
SELECT ur.user_id,
       ur.role_code,
       p.id,
       NULL                      -- system backfill, no human actor to credit
  FROM user_roles ur
  JOIN users u ON u.id = ur.user_id
  CROSS JOIN projects p
 WHERE ur.project_id IS NULL                                   -- candidate: a global grant
   AND u.is_system_admin = 0                                   -- 1: admins stay global
   AND ur.role_code NOT IN ('administrator', 'finance',
                            'human_capital', 'procurement')    -- 1: org-wide stays global
   AND EXISTS (SELECT 1 FROM projects);                        -- nothing to scope without a project

-- Audit trail: one row per user whose grants this migration created, so the change
-- is attributable to the migration and not to a human Administrator. Guards against
-- a duplicate row if the migration is ever re-applied.
INSERT INTO audit_log (entity_type, entity_id, action, actor_id, before_json, after_json)
SELECT 'user_roles', ur.user_id, 'projects_backfilled', NULL, NULL,
       json_object('role_codes', group_concat(DISTINCT ur.role_code),
                   'project_ids', group_concat(DISTINCT ur.project_id),
                   'source', 'migration_010')
  FROM user_roles ur
 JOIN users u ON u.id = ur.user_id
 WHERE ur.project_id IS NOT NULL
   AND u.is_system_admin = 0
 GROUP BY ur.user_id
   HAVING NOT EXISTS (
     SELECT 1 FROM audit_log a
      WHERE a.entity_type = 'user_roles' AND a.entity_id = ur.user_id
        AND a.action = 'projects_backfilled');
