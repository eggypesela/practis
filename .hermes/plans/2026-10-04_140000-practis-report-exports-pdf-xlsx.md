# PRACTIS — Report exports: PDF + XLSX (Module 8, part 8.11)

**Status: PLAN — awaiting approval before any build or dependency install.**
Written 2026-10-04. Follows 8.10 (`0da00a3`, pushed). This is the **last open Module 8 item**.

## Why this part exists

PRD §5.4: *"**Exports**: PDF + Excel report pack, light theme (dark app / light print — Q20c)."*
PRD Q8: *"Reports: portfolio + project dashboards + **formal exports all v1**."*
TECH-SPEC TS-06: *"Reports export to PDF and XLSX; HTML source retained as frozen artifact."*
TECH-SPEC line 522: *"Project Update Report — review, approval, freeze, **PDF/XLSX**."*

So the exports are a **v1 deliverable, not a nice-to-have**. 8.10 built the report; this part makes it
leavable — something the accountant and the client can be handed.

## The library question — already decided, by you

**TECH-SPEC TS-18: *"Reports: pdfmake for PDF + exceljs for XLSX (user, 2026-09-24). Pure-JS,
deterministic frozen output, small image; no headless browser."***

That is a locked decision naming the exact packages, and it rules out the alternatives:

| Option | Verdict |
|---|---|
| **pdfmake + exceljs** (TS-18) | **The spec's answer.** Pure JS, no browser — which matters here: this box has 2 GB RAM, no swap, and headless Chrome is already known-unreliable (recorded in memory). |
| hand-rolled XLSX via `zlib` | Possible (`zlib` has `crc32` + `deflateRawSync`) and zero-dep, but it **contradicts TS-18** and produces no PDF at all — the worse half of the job. |
| headless-browser → PDF | Rejected by TS-18 and by this box's constraints. |
| CSV instead of XLSX | Not what TS-06 asks for; a report pack is expected to open as a document. |

**Cost:** +2 runtime dependencies (pdfmake pulls pdfkit/linebreak/xmldoc; exceljs pulls jszip/archiver
&c). Sizes are a few MB; `node_modules` is currently 35 MB on `/opt/data` (52 G free), so disk is not
a concern. Adding them needs your yes, because the approved-dep list has been deliberately tight.

## What gets exported

The **Project Update Report** body, as PRD §5.4 lists it: SPI, CPI, receivable vs recognised revenue,
payable, exceptions, baseline changes. Both formats carry the same figures, from the same source.

### Decision 1 — export the STORED report, never a live recompute

An export that silently recomputed would produce a different document from the one that was approved.
So:

* **frozen / reviewed** report → export **its stored figures**. That is the record.
* **draft** → export the live compile, clearly watermarked **DRAFT**, because a draft is not a record
  and must not be mistakable for one.

### Decision 2 — light print theme (Q20c)

Dark app, light print. The PDF is **black on white**, one document per period, with the project,
the month, the status, and who approved it in the header. No dark backgrounds.

### Decision 3 — formula-injection guard on every exported cell

TECH-SPEC line 204: *"CSV/Excel export prevents formula injection: cells beginning `=`, `+`, `-`, `@`
prefixed safely for spreadsheet readers."* The repo already refuses such cells on **import**
(`src/lib/csv.js`); the **export** side is the mirror of that rule and is what §558's test list names
(*"exported formula-injection guard"*). A certificate number or a BCR title is user-supplied text and
must not become a live formula in someone's Excel.

### Decision 4 — exports are audited

TECH-SPEC marks `export` as an audited action (§221, §225). One audit row per download, with the
format and the report id.

## Routes

| Route | What it does |
|---|---|
| `GET /reports/update/:id/export.pdf` | streams the PDF, `Content-Disposition: attachment` |
| `GET /reports/update/:id/export.xlsx` | streams the XLSX, same |

Guarded by `canViewReport` (any signed-in user), matching the screen. The download is a GET so the
browser can save it; it mutates nothing but the audit log.

## Test plan (UPX8 series, port 3931)

| Test | What it pins |
|---|---|
| UPX8.1 | The XLSX response is a real ZIP (`PK\x03\x04`), the PDF is a real PDF (`%PDF-`), both with the right `Content-Type` and an attachment `Content-Disposition` |
| UPX8.2 | **The exported figures equal the stored report's figures** — not a fresh recompute (the report is the record) |
| UPX8.3 | A **draft** export is marked DRAFT and a **frozen** export carries the approval; neither leaks the other's state |
| UPX8.4 | **Formula injection:** a certificate/BCR title of `=1+1` or `@SUM(A1)` appears as **text**, never as a live formula in the sheet |
| UPX8.5 | The XLSX actually opens: unzip it and assert the workbook parts + shared strings contain the month and the figures (proves "pure-JS deterministic output", not a broken blob) |
| UPX8.6 | The download is **audited** (`export` row with format + report id) |
| UPX8.7 | A **viewer** may download (read parity with the screen), and a **signed-out** request is refused |

## Flagged, and deliberately NOT in this part

1. **The job runner.** TECH-SPEC line 558 puts reporting exports behind *"job state machine,
   retry/backoff, idempotency"*. **No job runner exists in the repo.** I propose a **synchronous**
   export for v1: the report is a single small document and generation is milliseconds. Building a job
   runner to wrap it would be a larger change than the feature. The runner remains a separate
   TECH-SPEC item (Module 9's "jobs") — flagged here so it is a decision, not an omission.
2. **"Frozen report artifact hash stable"** (§558). Storing the generated artifact and a hash so the
   same frozen report yields a byte-identical file is a real requirement, but it needs somewhere to
   keep the artefact. Doing it properly belongs with the job runner above. Not claimed as done.
3. **Exports of the OTHER reports** (aging, variance, portfolio). PRD Q8 says "formal exports all v1",
   so they are wanted; this part does the **Project Update Report** only, since that is the one
   TECH-SPEC line 522 names for PDF/XLSX. The other reports can reuse `src/lib/export-service.js` once
   it exists.

## 11. ✅ BUILT 2026-10-04

**Status: 8.11 COMPLETE — export service, two routes, download buttons, 7 tests (UPX8) green.
Suite 530 → 537.**

Builds what 8.10 flagged out of scope: PRD §5.4's **PDF + Excel export pack** with a light print
theme. TECH-SPEC **TS-18** named the libraries months ago ("pdfmake for PDF + exceljs for XLSX", pure
JS, no headless browser) — which matters on a 2 GB box where headless Chrome is unreliable, and it
rules out the cheaper hand-rolled-XLSX shortcut.

**Two libraries added** (approved 2026-10-04): `pdfmake` 0.3.11 + `exceljs` 4.4.0. `node_modules`
35 MB → 109 MB; the repo lives on the 52 GB volume, not the tight root. Both are pure JS.

**The design that matters:** the export reproduces the **STORED** report, never a live recompute —
otherwise the PDF handed to a client could disagree with the report that was approved, and nothing on
the file would say so. Draft → stamped **DRAFT — not approved**; frozen → the record's own figures
with who approved it. UPX8.2 stores deliberately-wrong figures and requires the FILE to carry them.

**Formula-injection guard (TS-204):** any cell text beginning `= + - @` is prefixed with an
apostrophe, so a certificate number or BCR title cannot execute as a formula. UPX8.4 reads the XLSX's
own XML back rather than trusting the in-memory string.

**`getBuffer()` is PROMISE-based in pdfmake 0.3.x** — the old callback form is *silently ignored* and
produces NO output at all. Cost an hour of "why is the PDF empty" probing.

**Measured cost:** first PDF render 1.9 s, later ~1.0 s; XLSX 0.7 s then 0.12 s; initial `require` of
`export-service.js` 4.4 s (pdfmake). Synchronous is fine for one small document — no job runner was
built, because wrapping this in TECH-SPEC §558's job state machine would be larger than the feature.

### Files

NEW `src/lib/export-service.js`; NEW `test/export.test.js` (UPX8, port 3931); MOD
`src/routes/reporting.js` (2 export routes), `src/db/queries.js` (`projectReportById`),
`views/report-update.ejs` (download buttons), `package.json` (`pdfmake`, `exceljs`),
`TEST_PLAN.md` §12v.

## Immediate next action

DONE except the full-suite run and the commit. Next: full suite (expect **537**), commit, **STOP for
approval**.

