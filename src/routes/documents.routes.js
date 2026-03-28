// src/routes/documents.routes.js
const express = require("express");
const path = require("path");
const { admin } = require("../firebase");
const { requireAuth } = require("../auth");

const router = express.Router();

const STAFF_ROLES = ["moderator", "admin", "super"];
const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;

const ALLOWED_DOC_MIME = new Set([
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);

const ALLOWED_DOC_EXT = new Set([
  ".pdf",
  ".doc",
  ".docx",
  ".xls",
  ".xlsx",
]);

function safeStr(v) {
  return (v == null ? "" : String(v)).trim();
}

function toIsoMaybe(ts) {
  if (!ts) return null;
  if (ts?.toDate) return ts.toDate().toISOString();
  return null;
}

function isSuper(req) {
  const r = String(req.user?.role || "").trim();
  return r === "super" || r === "admin";
}

function isStaff(req) {
  const r = String(req.user?.role || "").trim();
  return STAFF_ROLES.includes(r);
}

function requireStaff(req, res, next) {
  if (isStaff(req)) return next();
  return res.status(403).json({ error: "Forbidden (staff only)" });
}

function getExt(filename) {
  return path.extname(String(filename || "")).toLowerCase();
}

function sanitizeFileName(filename) {
  const base = path.basename(String(filename || "")).replace(/[^a-zA-Z0-9._-]/g, "_");
  return base.replace(/_+/g, "_").replace(/^_+|_+$/g, "") || "file";
}

function estimateBase64Bytes(b64) {
  const s = String(b64 || "").replace(/\s+/g, "");
  if (!s) return 0;
  const padding = s.endsWith("==") ? 2 : s.endsWith("=") ? 1 : 0;
  return Math.floor((s.length * 3) / 4) - padding;
}

function assertBase64UnderLimit(b64, maxBytes, label = "File") {
  const bytes = estimateBase64Bytes(b64);
  if (bytes <= 0) {
    const err = new Error(`${label} is empty`);
    err.status = 400;
    throw err;
  }
  if (bytes > maxBytes) {
    const err = new Error(`${label} is too large (max ${Math.round(maxBytes / 1024 / 1024)} MB)`);
    err.status = 400;
    throw err;
  }
}

function assertAllowedDocument(filename, mime) {
  const safeName = sanitizeFileName(filename);
  const ext = getExt(safeName);
  const mm = String(mime || "").trim().toLowerCase();

  if (!ALLOWED_DOC_EXT.has(ext)) {
    const err = new Error("Unsupported file extension");
    err.status = 400;
    throw err;
  }

  if (!ALLOWED_DOC_MIME.has(mm)) {
    const err = new Error("Unsupported file type");
    err.status = 400;
    throw err;
  }

  const matrix = {
    ".pdf": ["application/pdf"],
    ".doc": ["application/msword"],
    ".docx": ["application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
    ".xls": ["application/vnd.ms-excel"],
    ".xlsx": ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  };

  if (!matrix[ext] || !matrix[ext].includes(mm)) {
    const err = new Error("Filename extension and MIME type do not match");
    err.status = 400;
    throw err;
  }

  return { safeName, mime: mm };
}

/* ================= LIST DOCUMENTS ================= */
router.get("/documents", requireAuth, async (req, res) => {
  try {
    const ldId = safeStr(req.user?.ldId);
    if (!ldId) return res.status(400).json({ error: "Missing ldId in token." });

    const snap = await admin
      .firestore()
      .collection("ld_documents")
      .where("ldId", "==", ldId)
      .get();

    const documents = snap.docs
      .map((d) => {
        const x = d.data() || {};
        return {
          id: d.id,
          ldId: safeStr(x.ldId),
          title: safeStr(x.title),
          category: safeStr(x.category || "Splošno"),
          description: safeStr(x.description),
          filename: safeStr(x.filename),
          mime: safeStr(x.mime),
          path: safeStr(x.path),
          url: safeStr(x.url),
          uploadedBy: safeStr(x.uploadedBy),
          createdAt: toIsoMaybe(x.createdAt),
          updatedAt: toIsoMaybe(x.updatedAt),
        };
      })
      .sort((a, b) => {
        const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0;
        const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0;
        return tb - ta;
      });

    return res.json({ ok: true, ldId, documents });
  } catch (e) {
    return res.status(500).json({
      error: "Server error",
      detail: String(e?.stack || e?.message || e),
    });
  }
});

/* ================= CREATE DOCUMENT ================= */
router.post("/documents", requireAuth, requireStaff, async (req, res) => {
  try {
    const ldId = safeStr(req.user?.ldId);
    if (!ldId) return res.status(400).json({ error: "Missing ldId in token." });

    const title = safeStr(req.body?.title);
    const category = safeStr(req.body?.category || "Splošno");
    const description = safeStr(req.body?.description);
    const filename = safeStr(req.body?.filename);
    const mime = safeStr(req.body?.mime);
    const b64 = safeStr(req.body?.contentBase64);

    if (!title) return res.status(400).json({ error: "Missing title" });
    if (!filename) return res.status(400).json({ error: "Missing filename" });
    if (!mime) return res.status(400).json({ error: "Missing mime" });
    if (!b64) return res.status(400).json({ error: "Missing contentBase64" });

    assertBase64UnderLimit(b64, MAX_DOCUMENT_BYTES, "Document");
    const { safeName, mime: safeMime } = assertAllowedDocument(filename, mime);

    const db = admin.firestore();
    const bucket = admin.storage().bucket();

    const ref = db.collection("ld_documents").doc();
    const objectPath = `ld_documents/${ldId}/${ref.id}_${safeName}`;
    const buf = Buffer.from(b64, "base64");
    const file = bucket.file(objectPath);

    await file.save(buf, {
      metadata: {
        contentType: safeMime,
        metadata: {
          uploadedBy: safeStr(req.user?.uid || req.user?.code || ""),
          ldId,
          documentId: ref.id,
          title,
          category,
        },
      },
      resumable: false,
      validation: "crc32c",
    });

    await ref.set({
      ldId,
      title,
      category,
      description,
      filename: safeName,
      mime: safeMime,
      path: objectPath,
      url: `/ld/documents/${ref.id}/download`,
      uploadedBy: safeStr(req.user?.uid || req.user?.code || ""),
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return res.json({
      ok: true,
      id: ref.id,
      title,
    });
  } catch (e) {
    return res.status(e?.status || 500).json({
      error: e?.status ? e.message : "Server error",
      detail: e?.status ? undefined : String(e?.stack || e?.message || e),
    });
  }
});

/* ================= DOWNLOAD DOCUMENT ================= */
router.get("/documents/:id/download", requireAuth, async (req, res) => {
  try {
    const ldId = safeStr(req.user?.ldId);
    const id = safeStr(req.params.id);

    if (!ldId) return res.status(400).json({ error: "Missing ldId in token." });
    if (!id) return res.status(400).json({ error: "Missing document id" });

    const ref = admin.firestore().collection("ld_documents").doc(id);
    const snap = await ref.get();

    if (!snap.exists) {
      return res.status(404).json({ error: "Document not found" });
    }

    const doc = snap.data() || {};
    if (!isSuper(req) && safeStr(doc.ldId) !== ldId) {
      return res.status(403).json({ error: "Forbidden (other LD)" });
    }

    const objectPath = safeStr(doc.path);
    if (!objectPath) {
      return res.status(404).json({ error: "Document file path missing" });
    }

    const bucket = admin.storage().bucket();
    const file = bucket.file(objectPath);

    const [exists] = await file.exists();
    if (!exists) {
      return res.status(404).json({ error: "Document file not found in storage" });
    }

    res.setHeader("Content-Type", safeStr(doc.mime) || "application/octet-stream");
    res.setHeader(
      "Content-Disposition",
      `inline; filename="${sanitizeFileName(doc.filename || "document")}"`
    );

    file
      .createReadStream()
      .on("error", (err) => {
        if (!res.headersSent) {
          res.status(500).json({
            error: "Failed to stream file",
            detail: String(err?.message || err),
          });
        } else {
          try {
            res.end();
          } catch {}
        }
      })
      .pipe(res);
  } catch (e) {
    return res.status(500).json({
      error: "Server error",
      detail: String(e?.stack || e?.message || e),
    });
  }
});

/* ================= DELETE DOCUMENT ================= */
router.delete("/documents/:id", requireAuth, requireStaff, async (req, res) => {
  try {
    const ldId = safeStr(req.user?.ldId);
    const id = safeStr(req.params.id);

    if (!ldId) return res.status(400).json({ error: "Missing ldId in token." });
    if (!id) return res.status(400).json({ error: "Missing document id" });

    const ref = admin.firestore().collection("ld_documents").doc(id);
    const snap = await ref.get();

    if (!snap.exists) {
      return res.status(404).json({ error: "Document not found" });
    }

    const doc = snap.data() || {};
    if (!isSuper(req) && safeStr(doc.ldId) !== ldId) {
      return res.status(403).json({ error: "Forbidden (other LD)" });
    }

    const objectPath = safeStr(doc.path);
    if (objectPath) {
      try {
        await admin.storage().bucket().file(objectPath).delete();
      } catch {}
    }

    await ref.delete();

    return res.json({
      ok: true,
      id,
      deleted: true,
    });
  } catch (e) {
    return res.status(500).json({
      error: "Server error",
      detail: String(e?.stack || e?.message || e),
    });
  }
});

module.exports = router;