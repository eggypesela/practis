// TS-04/TS-24 import endpoints (TECH-SPEC §6.2).
//
//   POST /api/imports                     multipart CSV → stage (never writes the ledger)
//   GET  /api/imports/:batchId/preview    read-only counts: new vs skipped vs invalid
//   POST /api/imports/:batchId/confirm    commit the staged rows (idempotent per batch)
//
// These are JSON endpoints because the upload is driven by fetch (the CSRF token
// travels in the x-csrf-token header — the lib accepts header or body field).
// A multipart body cannot be parsed by express.urlencoded, so the global CSRF
// middleware sees no `_csrf` field: the header path is what makes this safe.
//
// The service layer owns the rules; this file owns HTTP: auth, the multipart
// read, status codes and the JSON shape. Nothing here writes ledger rows.

'use strict';

const express = require('express');
const Busboy = require('busboy');

const svc = require('../lib/import-service');
const { requireAuth, requireApiCapability } = require('../middleware/auth');

const router = express.Router();

// Every import endpoint writes (or stages a write to) the ledger, so all of them
// are gated on canImportLedger — audit blocker B4. `preview` only reads, but it
// exposes staged batch contents, so it stays behind the same capability rather
// than letting any signed-in user enumerate other people's uploads.
const canImport = requireApiCapability('canImportLedger', 'Importing the ledger is a Finance task.');

const MAX_BYTES = 10 * 1024 * 1024;              // 10 MB (TECH-SPEC §3.7)
// `.tsv` is not optional: Excel's "Save as text" on the real ledger export produces a
// TAB-separated file with that extension, which is precisely what db/fixture-ledger-export.tsv
// is. Rejecting it meant the canonical real-world file could not be imported at all, while
// the parser happily handled tabs — the barrier was the extension check, not the parser.
const ALLOWED_EXT = /\.(csv|tsv|txt)$/i;

// Parse one multipart/form-data request into { fields, file }.
// Rejects oversize files (413-ish → 400 with a clear code) and non-CSV names.
function readMultipart(req) {
  return new Promise((resolve, reject) => {
    let bb;
    try {
      bb = Busboy({ headers: req.headers, limits: { fileSize: MAX_BYTES, files: 1, fields: 10 } });
    } catch (err) {
      return reject(Object.assign(err, { code: 'BAD_MULTIPART' }));
    }

    const fields = {};
    let file = null;
    let tooLarge = false;

    bb.on('field', (name, val) => { fields[name] = val; });

    bb.on('file', (name, stream, info) => {
      if (name !== 'file') { stream.resume(); return; }
      const chunks = [];
      file = { filename: info.filename, mimeType: info.mimeType, buffer: null };
      stream.on('data', (d) => chunks.push(d));
      stream.on('limit', () => { tooLarge = true; stream.resume(); });
      stream.on('close', () => { file.buffer = Buffer.concat(chunks); });
    });

    bb.on('error', (err) => reject(Object.assign(err, { code: 'BAD_MULTIPART' })));
    bb.on('close', () => {
      if (tooLarge) {
        return reject(Object.assign(new Error('file exceeds the 10 MB limit'),
          { code: 'TOO_LARGE', status: 413 }));
      }
      resolve({ fields, file });
    });

    req.pipe(bb);
  });
}

const fail = (res, status, code, message, extra = {}) =>
  res.status(status).json({ error: { code, message, ...extra } });

// ---- stage --------------------------------------------------------------------

router.post('/api/imports', requireAuth, canImport, async (req, res) => {
  let parsed;
  try {
    parsed = await readMultipart(req);
  } catch (err) {
    const status = err.status || 400;
    return fail(res, status, err.code || 'BAD_UPLOAD', err.message);
  }

  const { fields, file } = parsed;
  if (!file || !file.buffer || file.buffer.length === 0) {
    return fail(res, 400, 'NO_FILE', 'Attach a CSV file in the "file" field.');
  }
  if (file.filename && !ALLOWED_EXT.test(file.filename)) {
    return fail(res, 400, 'BAD_EXTENSION', 'Only .csv files are accepted.');
  }

  // project context: explicit field, else the caller's current project header
  let projectId = fields.project_id ? Number(fields.project_id) : null;
  if (!projectId) {
    const first = require('../db/queries').projects()[0];
    projectId = first ? first.id : null;
  }
  if (!projectId) return fail(res, 400, 'NO_PROJECT', 'No project context.');

  try {
    const out = svc.stage({
      buffer: file.buffer,
      filename: file.filename || 'upload.csv',
      projectId,
      actorId: req.user.id,
    });
    return res.status(201).json({
      batchId: out.batchId,
      rowCount: out.rowCount,
      newCount: out.newCount,
      skippedCount: out.skipped,
      invalidCount: out.invalid.length,
      status: 'staged',
    });
  } catch (err) {
    // header-level / parse-level failure = nothing was staged worth keeping
    return fail(res, 400, 'STAGE_FAILED', err.message);
  }
});

// ---- preview ------------------------------------------------------------------

router.get('/api/imports/:batchId/preview', requireAuth, canImport, (req, res) => {
  const batchId = Number(req.params.batchId);
  if (!Number.isInteger(batchId) || batchId < 1) {
    return fail(res, 400, 'BAD_BATCH_ID', 'batchId must be a positive integer.');
  }
  const p = svc.preview(batchId);
  if (!p) return fail(res, 404, 'NOT_FOUND', 'No such import batch.');
  return res.json(p);
});

// ---- confirm ------------------------------------------------------------------

router.post('/api/imports/:batchId/confirm', requireAuth, canImport, (req, res) => {
  const batchId = Number(req.params.batchId);
  if (!Number.isInteger(batchId) || batchId < 1) {
    return fail(res, 400, 'BAD_BATCH_ID', 'batchId must be a positive integer.');
  }

  const out = svc.confirm(batchId, req.user.id);
  if (out.error === 'NOT_FOUND') return fail(res, 404, 'NOT_FOUND', 'No such import batch.');
  if (out.error === 'EXPIRED') return fail(res, 410, 'EXPIRED', 'This staged batch has expired.');
  if (out.error === 'NOT_STAGED') return fail(res, 409, 'NOT_STAGED', 'This batch was never staged.');

  return res.json({
    batchId,
    status: 'confirmed',
    inserted: out.inserted,
    skipped: out.skipped,
    alreadyConfirmed: !!out.alreadyConfirmed,
    invalidCount: (out.invalid || []).length,
    failedCount: (out.failed || []).length,
  });
});

module.exports = router;
