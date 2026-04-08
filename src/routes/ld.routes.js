// src/routes/ld.routes.js
const express = require("express");
const bcrypt = require("bcrypt");
const XLSX = require("xlsx");
const ExcelJS = require("exceljs");
const PDFDocument = require("pdfkit");
const fs = require("fs");
const path = require("path");

const { admin } = require("../firebase");
const { requireAuth } = require("../auth");
const { sendToLd, sendToHunter } = require("../services/push.service");

const router = express.Router();

/* ================= HELPERS ================= */

const VALID_ROLES = ["member", "moderator", "admin", "super"];
const STAFF_ROLES = ["moderator", "admin", "super"];

const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024; // 10 MB
const MAX_IMPORT_BYTES = 10 * 1024 * 1024; // 10 MB
const MAX_EVENT_ATTACHMENTS = 20;

const ALLOWED_ATTACHMENT_MIME = new Set([
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);

const ALLOWED_ATTACHMENT_EXT = new Set([
  ".pdf",
  ".doc",
  ".docx",
  ".xls",
  ".xlsx",
]);

function isSuper(req) {
  const r = String(req.user?.role || "");
  return r === "super" || r === "admin";
}

function isStaff(req) {
  const role = String(req.user?.role || "member");
  return STAFF_ROLES.includes(role);
}

function requireStaff(req, res, next) {
  if (isStaff(req)) return next();
  return res.status(403).json({ error: "Forbidden (staff only)" });
}

function requireSuper(req, res, next) {
  if (isSuper(req)) return next();
  return res.status(403).json({ error: "Forbidden (super only)" });
}

function canAssignRole(req, newRole) {
  const role = String(newRole || "").trim();
  if (!VALID_ROLES.includes(role)) return false;
  if (isSuper(req)) return true;
  return role === "member";
}

function canManageTargetRole(req, targetRole) {
  const role = String(targetRole || "member").trim();
  if (!VALID_ROLES.includes(role)) return false;
  if (isSuper(req)) return true;
  return role === "member";
}

function genPin4() {
  return String(Math.floor(Math.random() * 10000)).padStart(4, "0");
}

function safeStr(v) {
  return (v == null ? "" : String(v)).trim();
}

function resolveTargetLdId(req) {
  const tokenLdId = String(req.user?.ldId || "").trim();
  const bodyLdId = safeStr(req.body?.ldId);
  const queryLdId = safeStr(req.query?.ldId);

  if (isSuper(req)) {
    return String(bodyLdId || queryLdId || tokenLdId || "").trim();
  }

  return tokenLdId;
}

function numOrNull(v) {
  if (v == null || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const n = Number(String(v).trim().replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

function num(v) {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

function tsFromQuery(v) {
  if (!v) return null;
  const d = new Date(String(v));
  if (Number.isNaN(d.getTime())) return null;
  return admin.firestore.Timestamp.fromDate(d);
}

function toIsoMaybe(ts) {
  if (!ts) return null;
  if (ts?.toDate) return ts.toDate().toISOString();
  return null;
}

function pct(n, d) {
  const nn = Number(n || 0);
  const dd = Number(d || 0);
  if (!dd || dd <= 0) return "—";
  return `${Math.round((nn / dd) * 100)}%`;
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

function assertAllowedAttachment(filename, mime) {
  const safeName = sanitizeFileName(filename);
  const ext = getExt(safeName);
  const mm = String(mime || "").trim().toLowerCase();

  if (!ALLOWED_ATTACHMENT_EXT.has(ext)) {
    const err = new Error("Unsupported file extension");
    err.status = 400;
    throw err;
  }

  if (!ALLOWED_ATTACHMENT_MIME.has(mm)) {
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

  return { safeName, ext, mime: mm };
}

function makeKey(species, cls) {
  const clean = (s) =>
    safeStr(s)
      .toUpperCase()
      .replace(/\s+/g, "_")
      .replace(/Č/g, "C")
      .replace(/Š/g, "S")
      .replace(/Ž/g, "Z")
      .replace(/Đ/g, "D")
      .replace(/Ć/g, "C")
      .replace(/[^A-Z0-9_]+/g, "_")
      .replace(/_+/g, "_")
      .replace(/^_+|_+$/g, "");

  const a = clean(species);
  const b = clean(cls);
  return `${a}__${b || "SKUPAJ"}`;
}

/* ================= PDF STYLE (ROG TOKENS) ================= */

const ROG = {
  green: "#3F5E4B",
  brown: "#6B4E2E",
  text: "#222222",
  muted: "#444444",
  headerBeige: "#EFE6D6",
  zebra: "#FAF5EC",
  border: "#C9D2C9",
};

function getPdfFontsOrThrow() {
  const fontReg = path.join(__dirname, "..", "assets", "fonts", "DejaVuSans.ttf");
  const fontBold = path.join(__dirname, "..", "assets", "fonts", "DejaVuSans-Bold.ttf");

  if (!fs.existsSync(fontReg) || !fs.existsSync(fontBold)) {
    const err = new Error("Missing PDF fonts");
    err.code = "MISSING_PDF_FONTS";
    err.detail =
      `Manjkajo fonti za šumnike:\n` +
      `- ${fontReg}\n` +
      `- ${fontBold}\n\n` +
      `Rešitev:\n` +
      `1) Ustvari mapo: src/assets/fonts/\n` +
      `2) Kopiraj notri: DejaVuSans.ttf in DejaVuSans-Bold.ttf\n`;
    throw err;
  }

  return { fontReg, fontBold };
}

function setPdfHeaders(res, filename) {
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
}

function cleanPdfText(v) {
  const s = String(v ?? "");
  return s.replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim();
}

function fmtDtSI(iso) {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "—";
    return d.toLocaleString("sl-SI");
  } catch {
    return "—";
  }
}

function fmtNum6(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  return String(Math.round(n * 1e6) / 1e6);
}

/* ================= ODVZEM: VIEW HELPERS ================= */

function isTrueTotalLabel(label) {
  const s = String(label || "").trim().toLowerCase();
  if (!s) return false;

  if (s.includes("moški") || s.includes("moski")) return false;
  if (s.includes("ženski") || s.includes("zenski")) return false;
  if (s.includes("mladi")) return false;

  if (s === "skupaj") return true;
  if (s.endsWith(" skupaj")) return true;
  return false;
}

function isHiddenSubtotal(label) {
  const s = String(label || "").trim().toLowerCase();
  if (!s) return false;

  const hasTogether = s.includes("skupaj");
  const isSexSubtotal =
    s.includes("moški") ||
    s.includes("moski") ||
    s.includes("ženski") ||
    s.includes("zenski");
  const isYoungSubtotal = s.includes("mladi");

  return hasTogether && (isSexSubtotal || isYoungSubtotal) && !isTrueTotalLabel(label);
}

function statusIcon(plan, executed) {
  const p = numOrNull(plan);
  const e = numOrNull(executed);
  if (p == null || p === 0 || e == null) return "";
  const ratio = e / p;
  if (ratio >= 0.9 && ratio <= 1.1) return "🟢";
  if (ratio >= 0.7 && ratio < 0.9) return "🟡";
  return "🔴";
}

function buildDisplayRows(viewRows) {
  const rows = Array.isArray(viewRows) ? viewRows : [];

  const bySpecies = new Map();
  for (const r of rows) {
    const sp = String(r?.species || "").trim();
    if (!sp) continue;
    if (!bySpecies.has(sp)) bySpecies.set(sp, []);
    bySpecies.get(sp).push(r);
  }

  const speciesList = Array.from(bySpecies.keys()).sort((a, b) =>
    a.localeCompare(b, "sl")
  );
  const out = [];

  for (const sp of speciesList) {
    const list = bySpecies.get(sp) || [];
    const total = list.find((x) => isTrueTotalLabel(x?.classLabel));

    const details = list
      .filter((x) => {
        const label = String(x?.classLabel || "");
        if (isHiddenSubtotal(label)) return false;
        if (isTrueTotalLabel(label)) return false;
        return true;
      })
      .map((d) => ({
        _type: "detail",
        key: safeStr(d?.key),
        species: sp,
        classLabel: String(d?.classLabel || "").trim() || "—",
        plan: numOrNull(d?.plan),
        executed: numOrNull(d?.executed) ?? 0,
        executedAuto: numOrNull(d?.executedAuto) ?? 0,
        executedDelta: numOrNull(d?.executedDelta) ?? 0,
        override: d?.override || null,
        pending: numOrNull(d?.pending) ?? 0,
      }));

    out.push({ _type: "header", species: sp });
    for (const d of details) out.push(d);

    const computedExec = details.reduce((s, x) => s + (numOrNull(x.executed) ?? 0), 0);
    const computedPend = details.reduce((s, x) => s + (numOrNull(x.pending) ?? 0), 0);

    out.push({
      _type: "total",
      key: safeStr(total?.key),
      species: sp,
      classLabel: "Skupaj",
      plan: total ? numOrNull(total?.plan) : null,
      executed: total ? (numOrNull(total?.executed) ?? computedExec) : computedExec,
      executedAuto: total ? (numOrNull(total?.executedAuto) ?? computedExec) : computedExec,
      executedDelta: total ? (numOrNull(total?.executedDelta) ?? 0) : 0,
      override: total?.override || null,
      pending: total ? (numOrNull(total?.pending) ?? computedPend) : computedPend,
    });
  }

  return out;
}

/* ================= ODVZEM: OVERRIDES ================= */

async function loadOdvzemOverridesMap(ldId, year) {
  const planId = `${ldId}_${year}`;
  const snap = await admin
    .firestore()
    .collection("odvzem_plans")
    .doc(planId)
    .collection("overrides")
    .get();

  const map = {};
  for (const d of snap.docs) {
    const x = d.data() || {};
    const key = safeStr(x.key) || d.id;
    map[key] = {
      key,
      executedDelta: numOrNull(x.executedDelta) ?? 0,
      reason: safeStr(x.reason),
      updatedBy: safeStr(x.updatedBy),
      updatedAt: x.updatedAt?.toDate ? x.updatedAt.toDate().toISOString() : null,
    };
  }
  return map;
}

async function computeAutoExecutedForKey(ldId, year, key) {
  const start = admin.firestore.Timestamp.fromDate(new Date(year, 0, 1, 0, 0, 0));
  const end = admin.firestore.Timestamp.fromDate(new Date(year + 1, 0, 1, 0, 0, 0));

  const logsSnap = await admin
    .firestore()
    .collection("hunt_logs")
    .where("ldId", "==", ldId)
    .where("finishedAt", ">=", start)
    .where("finishedAt", "<", end)
    .get();

  let sum = 0;
  for (const doc of logsSnap.docs) {
    const d = doc.data() || {};
    const harvestItems = Array.isArray(d.harvestItems) ? d.harvestItems : [];
    for (const it of harvestItems) {
      if (safeStr(it?.key) !== key) continue;
      const cnt = Number(it?.count || 0);
      if (Number.isFinite(cnt) && cnt > 0) sum += cnt;
    }
  }
  return sum;
}

/* ================= ODVZEM: LOAD VIEW ================= */

async function loadOdvzemViewRows(ldId, year) {
  const planId = `${ldId}_${year}`;
  const planSnap = await admin
    .firestore()
    .collection("odvzem_plans")
    .doc(planId)
    .get();

  const plan = planSnap.exists ? planSnap.data() || {} : {};
  const items = Array.isArray(plan.items) ? plan.items : [];

  const start = admin.firestore.Timestamp.fromDate(new Date(year, 0, 1, 0, 0, 0));
  const end = admin.firestore.Timestamp.fromDate(new Date(year + 1, 0, 1, 0, 0, 0));

  const logsSnap = await admin
    .firestore()
    .collection("hunt_logs")
    .where("ldId", "==", ldId)
    .where("finishedAt", ">=", start)
    .where("finishedAt", "<", end)
    .get();

  const byKey = {};
  const pendingByKey = {};

  for (const doc of logsSnap.docs) {
    const d = doc.data() || {};

    const harvestItems = Array.isArray(d.harvestItems) ? d.harvestItems : [];
    for (const it of harvestItems) {
      const key = safeStr(it?.key);
      const cnt = Number(it?.count || 0);
      if (!key || !Number.isFinite(cnt) || cnt <= 0) continue;
      byKey[key] = (byKey[key] || 0) + cnt;
    }

    const pendingItems = Array.isArray(d.pendingItems) ? d.pendingItems : [];
    for (const it of pendingItems) {
      const key = safeStr(it?.key) || "PENDING_OTHER";
      const cnt = Number(it?.count || 0);
      if (!Number.isFinite(cnt) || cnt <= 0) continue;
      pendingByKey[key] = (pendingByKey[key] || 0) + cnt;
    }
  }

  const overrides = await loadOdvzemOverridesMap(ldId, year);

  const rows = items.map((it) => {
    const key = safeStr(it?.key);
    const planCount = Number(it?.plan || 0);

    const executedAuto = Number(byKey[key] || 0);
    const pending = Number(pendingByKey[key] || 0);

    const ov = overrides[key];
    const executedDelta = ov ? (numOrNull(ov.executedDelta) ?? 0) : 0;
    const executed = executedAuto + executedDelta;

    return {
      key,
      species: safeStr(it?.species),
      classLabel: safeStr(it?.classLabel),
      plan: planCount,
      executedAuto,
      executedDelta,
      executed,
      override: ov
        ? {
            reason: safeStr(ov.reason),
            updatedBy: safeStr(ov.updatedBy),
            updatedAt: ov.updatedAt || null,
          }
        : null,
      pending,
      percent: pct(executed, planCount),
    };
  });

  return { plan, rows };
}

/* ================= DASHBOARD ================= */

router.get("/dashboard", requireAuth, async (req, res) => {
  try {
    const ldId = String(req.user?.ldId || "").trim();
    if (!ldId) return res.status(400).json({ error: "Missing ldId in token." });

    let ldName = ldId;
    try {
      const ldSnap = await admin.firestore().collection("lds").doc(ldId).get();
      if (ldSnap.exists) {
        const d = ldSnap.data() || {};
        ldName = d.name || d.title || ldId;
      }
    } catch {}

    const huntersSnap = await admin
      .firestore()
      .collection("hunters")
      .where("ldId", "==", ldId)
      .get();
    const usersCount = huntersSnap.size;

    let huntsThisMonth = 0;
    try {
      const now = new Date();
      const start = new Date(now.getFullYear(), now.getMonth(), 1);
      const startTs = admin.firestore.Timestamp.fromDate(start);

      const logsSnap = await admin
        .firestore()
        .collection("hunt_logs")
        .where("ldId", "==", ldId)
        .where("createdAt", ">=", startTs)
        .get();

      huntsThisMonth = logsSnap.size;
    } catch {
      huntsThisMonth = 0;
    }

    return res.json({
      ok: true,
      ldId,
      ldName,
      usersCount,
      huntsThisMonth,
      lastSync: new Date().toISOString(),
    });
  } catch (e) {
    return res.status(500).json({
      error: "Server error",
      detail: String(e?.stack || e?.message || e),
    });
  }
});

/* ================= USERS ================= */

router.get("/users", requireAuth, requireStaff, async (req, res) => {
  try {
    const ldId = String(req.user?.ldId || "").trim();
    if (!ldId) return res.status(400).json({ error: "Missing ldId in token." });

    const snap = await admin.firestore().collection("hunters").where("ldId", "==", ldId).get();

    const users = snap.docs
      .map((d) => {
        const x = d.data() || {};
        return {
          code: d.id,
          name: x.name || "",
          role: x.role || "member",
          enabled: x.enabled === true,
          createdAt: toIsoMaybe(x.createdAt) || null,
          updatedAt: toIsoMaybe(x.updatedAt) || null,
        };
      })
      .sort((a, b) => String(a.name).localeCompare(String(b.name), "sl"));

    return res.json({ ok: true, users });
  } catch (e) {
    return res.status(500).json({
      error: "Server error",
      detail: String(e?.stack || e?.message || e),
    });
  }
});

router.post("/users", requireAuth, requireStaff, async (req, res) => {
  try {
    const ldId = String(req.user?.ldId || "").trim();
    if (!ldId) return res.status(400).json({ error: "Missing ldId in token." });

    const code = String(req.body?.code || "").trim();
    const name = String(req.body?.name || "").trim();
    const role = String(req.body?.role || "member").trim();

    if (!code) return res.status(400).json({ error: "Missing code" });
    if (!name) return res.status(400).json({ error: "Missing name" });
    if (!VALID_ROLES.includes(role)) return res.status(400).json({ error: "Invalid role" });

    if (!canAssignRole(req, role)) {
      return res.status(403).json({ error: "Forbidden (cannot create this role)" });
    }

    const ref = admin.firestore().collection("hunters").doc(code);
    const existing = await ref.get();
    if (existing.exists) return res.status(409).json({ error: "User code already exists" });

    const pin = genPin4();
    const pinHash = await bcrypt.hash(pin, 10);

    await ref.set({
      name,
      role,
      ldId,
      enabled: true,
      pinHash,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return res.json({
      ok: true,
      user: { code, name, role, enabled: true, ldId },
      pin,
    });
  } catch (e) {
    return res.status(500).json({
      error: "Server error",
      detail: String(e?.stack || e?.message || e),
    });
  }
});

router.patch("/users/:code", requireAuth, requireStaff, async (req, res) => {
  try {
    const ldId = String(req.user?.ldId || "").trim();
    const code = String(req.params.code || "").trim();
    if (!ldId) return res.status(400).json({ error: "Missing ldId in token." });
    if (!code) return res.status(400).json({ error: "Missing code" });

    const ref = admin.firestore().collection("hunters").doc(code);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ error: "User not found" });

    const data = snap.data() || {};
    const targetRole = String(data.role || "member").trim();

    if (!isSuper(req) && String(data.ldId || "") !== ldId) {
      return res.status(403).json({ error: "Forbidden (other LD)" });
    }

    if (!canManageTargetRole(req, targetRole)) {
      return res.status(403).json({ error: "Forbidden (cannot manage this user)" });
    }

    const patch = {};

    if (typeof req.body?.enabled === "boolean") patch.enabled = req.body.enabled;
    if (req.body?.name != null) patch.name = String(req.body.name).trim();

    if (req.body?.role != null) {
      const r = String(req.body.role).trim();
      if (!VALID_ROLES.includes(r)) {
        return res.status(400).json({ error: "Invalid role" });
      }
      if (!canAssignRole(req, r)) {
        return res.status(403).json({ error: "Forbidden (cannot set this role)" });
      }
      patch.role = r;
    }

    patch.updatedAt = admin.firestore.FieldValue.serverTimestamp();
    await ref.set(patch, { merge: true });

    return res.json({ ok: true, code, patch });
  } catch (e) {
    return res.status(500).json({
      error: "Server error",
      detail: String(e?.stack || e?.message || e),
    });
  }
});

router.delete("/users/:code", requireAuth, requireStaff, async (req, res) => {
  try {
    const ldId = String(req.user?.ldId || "").trim();
    const code = String(req.params.code || "").trim();

    if (!ldId) return res.status(400).json({ error: "Missing ldId in token." });
    if (!code) return res.status(400).json({ error: "Missing code" });

    const ref = admin.firestore().collection("hunters").doc(code);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ error: "User not found" });

    const data = snap.data() || {};
    const targetRole = String(data.role || "member").trim();

    if (!isSuper(req) && String(data.ldId || "") !== ldId) {
      return res.status(403).json({ error: "Forbidden (other LD)" });
    }

    if (!canManageTargetRole(req, targetRole)) {
      return res.status(403).json({ error: "Forbidden (cannot delete this user)" });
    }

    await ref.delete();
    return res.json({ ok: true, deleted: code });
  } catch (e) {
    return res.status(500).json({
      error: "Server error",
      detail: String(e?.stack || e?.message || e),
    });
  }
});

router.post("/users/:code/reset-pin", requireAuth, requireStaff, async (req, res) => {
  try {
    const ldId = String(req.user?.ldId || "").trim();
    const code = String(req.params.code || "").trim();
    if (!ldId) return res.status(400).json({ error: "Missing ldId in token." });
    if (!code) return res.status(400).json({ error: "Missing code" });

    const ref = admin.firestore().collection("hunters").doc(code);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ error: "User not found" });

    const data = snap.data() || {};
    const targetRole = String(data.role || "member").trim();

    if (!isSuper(req) && String(data.ldId || "") !== ldId) {
      return res.status(403).json({ error: "Forbidden (other LD)" });
    }

    if (!canManageTargetRole(req, targetRole)) {
      return res.status(403).json({ error: "Forbidden (cannot reset PIN for this user)" });
    }

    const newPin = genPin4();
    const newHash = await bcrypt.hash(newPin, 10);

    await ref.set(
      {
        pinHash: newHash,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        lastPinResetAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    return res.json({ ok: true, code, pin: newPin });
  } catch (e) {
    return res.status(500).json({
      error: "Server error",
      detail: String(e?.stack || e?.message || e),
    });
  }
});

/* ================= ACTIVE HUNTS ================= */

router.get("/active-hunts", requireAuth, async (req, res) => {
  try {
    const ldId = String(req.user?.ldId || "").trim();
    if (!ldId) return res.status(400).json({ error: "Missing ldId in token." });

    const snap = await admin
      .firestore()
      .collection("active_hunts")
      .where("ldId", "==", ldId)
      .orderBy("startedAt", "desc")
      .get();

    const active = snap.docs.map((d) => {
      const x = d.data() || {};
      return {
        uid: d.id,
        hunterId: x.hunterId || null,
        hunterName: x.hunterName || null,
        ldId: x.ldId || null,
        locationMode: x.locationMode || "private_text",
        locationName: x.locationName || "",
        poiName: x.poiName || null,
        poiType: x.poiType || null,
        lat: numOrNull(x.lat),
        lng: numOrNull(x.lng),
        approxLat: numOrNull(x.approxLat),
        approxLng: numOrNull(x.approxLng),
        approxRadiusM: numOrNull(x.approxRadiusM),
        startedAt: toIsoMaybe(x.startedAt),
      };
    });

    return res.json({ ok: true, active });
  } catch (e) {
    return res.status(500).json({
      error: "Server error",
      detail: String(e?.stack || e?.message || e),
    });
  }
});

/* ================= LD POINTS ================= */

router.get("/points", requireAuth, async (req, res) => {
  try {
    const ldId = String(req.user?.ldId || "").trim();
    if (!ldId) return res.status(400).json({ error: "Missing ldId in token." });

    const snap = await admin.firestore().collection("ld_points").where("ldId", "==", ldId).get();

    const points = snap.docs.map((d) => {
      const x = d.data() || {};
      return {
        id: d.id,
        pointId: x.pointId || null,
        lat: numOrNull(x.lat),
        lng: numOrNull(x.lng),
        ldId: x.ldId || null,
        ldName: x.ldName || null,
        name: x.name || "",
        type: x.type || "",
        notes: x.notes || "",
        status: x.status || "",
        source: x.source || "",
        createdAt: toIsoMaybe(x.createdAt),
        updatedAt: toIsoMaybe(x.updatedAt),
      };
    });

    return res.json({ ok: true, points });
  } catch (e) {
    return res.status(500).json({
      error: "Server error",
      detail: String(e?.stack || e?.message || e),
    });
  }
});

/* ================= POINTS IMPORT ================= */

function normalizeHeaderKey(k) {
  return String(k || "")
    .trim()
    .toLowerCase()
    .replace(/\*/g, "")
    .replace(/\s+/g, "")
    .replace(/č/g, "c")
    .replace(/š/g, "s")
    .replace(/ž/g, "z");
}

function safeDocId(s) {
  return String(s || "")
    .trim()
    .replace(/\s+/g, "_")
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function parseLatLng(v) {
  if (v == null) return null;

  if (typeof v === "number" && Number.isFinite(v)) {
    if (Math.abs(v) > 1000) return v / 1_000_000;
    return v;
  }

  const s0 = String(v).trim();
  if (!s0) return null;

  const s = s0.replace(/\s+/g, "").replace(",", ".");
  const n = Number(s);
  if (!Number.isFinite(n)) return null;

  if (Math.abs(n) > 1000) return n / 1_000_000;
  return n;
}

function normalizePointType(t) {
  return String(t || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/č/g, "c")
    .replace(/š/g, "s")
    .replace(/ž/g, "z");
}

async function importPointsFromBase64(req, res) {
  try {
    const ldId = String(req.user?.ldId || "").trim();
    if (!ldId) return res.status(400).json({ error: "Missing ldId in token." });

    const filename = safeStr(req.body?.filename) || "points.xlsx";
    const b64 = safeStr(req.body?.contentBase64);
    if (!b64) return res.status(400).json({ error: "Missing contentBase64" });

    assertBase64UnderLimit(b64, MAX_IMPORT_BYTES, "Import file");

    const buf = Buffer.from(b64, "base64");

    const wb = XLSX.read(buf, { type: "buffer" });
    const first = wb.SheetNames?.[0];
    if (!first) return res.status(400).json({ error: "File has no sheets" });

    const ws = wb.Sheets[first];
    const raw = XLSX.utils.sheet_to_json(ws, { defval: "" });

    if (!Array.isArray(raw) || raw.length === 0) {
      return res.status(400).json({ error: "File has no data rows" });
    }

    const normalizedRows = raw.map((row) => {
      const out = {};
      for (const k of Object.keys(row || {})) out[normalizeHeaderKey(k)] = row[k];
      return out;
    });

    const db = admin.firestore();
    const col = db.collection("ld_points");

    const BATCH_LIMIT = 450;
    let batch = db.batch();
    let ops = 0;

    let processed = 0;
    let skipped = 0;

    const seen = new Set();

    for (const r of normalizedRows) {
      const rowLdId = safeStr(r.ldid);
      const pointId = safeStr(r.pointid);
      const name = safeStr(r.name);

      const latRaw = safeStr(r.lat);
      const lngRaw = safeStr(r.lng);

      if (
        rowLdId.toLowerCase().includes("id lovi") ||
        latRaw.toLowerCase().includes("latitude") ||
        lngRaw.toLowerCase().includes("longitude") ||
        pointId.toLowerCase().includes("interni")
      ) {
        skipped++;
        continue;
      }

      if (!rowLdId && !pointId && !name) {
        skipped++;
        continue;
      }

      if (!rowLdId) {
        skipped++;
        continue;
      }

      if (rowLdId !== ldId) {
        return res.status(400).json({
          error: `LD mismatch: file row ldId="${rowLdId}", token ldId="${ldId}". (Najprej switch-ld na pravo LD)`,
        });
      }

      if (!pointId) {
        skipped++;
        continue;
      }

      const docId = safeDocId(`${ldId}__${pointId}`);
      if (!docId) {
        skipped++;
        continue;
      }

      if (seen.has(docId)) {
        skipped++;
        continue;
      }
      seen.add(docId);

      const lat = parseLatLng(r.lat);
      const lng = parseLatLng(r.lng);

      if (lat == null || lng == null) {
        skipped++;
        continue;
      }

      const ref = col.doc(docId);

      const data = {
        pointId,
        ldId,
        ldName: safeStr(r.ldime) || "",
        type: normalizePointType(r.type) || "",
        name: name || "",
        lat,
        lng,
        notes: safeStr(r.notes) || "",
        status: safeStr(r.status) || "active",
        source: safeStr(r.source) || "import",
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      };

      batch.set(ref, data, { merge: true });

      ops++;
      processed++;

      if (ops >= BATCH_LIMIT) {
        await batch.commit();
        batch = db.batch();
        ops = 0;
      }
    }

    if (ops > 0) await batch.commit();

    return res.json({
      ok: true,
      filename,
      ldId,
      processed,
      skipped,
      message: "Import OK (robusten način, template vrstice ignorirane).",
    });
  } catch (e) {
    return res.status(e?.status || 500).json({
      error: e?.status ? e.message : "Server error",
      detail: e?.status ? undefined : String(e?.stack || e?.message || e),
    });
  }
}

router.post("/points/import-file", requireAuth, requireSuper, importPointsFromBase64);
router.post("/points/import", requireAuth, requireSuper, importPointsFromBase64);

/* ================= ODVZEM ================= */

router.post("/odvzem-plan/import-excel", requireAuth, requireStaff, async (req, res) => {
  try {
    const ldId = String(req.user?.ldId || "").trim();
    if (!ldId) return res.status(400).json({ error: "Missing ldId in token." });

    const year = Number(req.query?.year || 0);
    if (!year || year < 2020 || year > 2100) return res.status(400).json({ error: "Invalid year" });

    const b64 = safeStr(req.body?.contentBase64);
    if (!b64) return res.status(400).json({ error: "Missing contentBase64" });

    assertBase64UnderLimit(b64, MAX_IMPORT_BYTES, "Excel file");

    const buf = Buffer.from(b64, "base64");

    const wb = XLSX.read(buf, { type: "buffer" });
    const first = wb.SheetNames?.[0];
    if (!first) return res.status(400).json({ error: "XLSX has no sheets" });

    const ws = wb.Sheets[first];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false });

    let currentSpecies = "";
    const items = [];

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i] || [];
      const s0 = safeStr(r[0]);
      const s1 = safeStr(r[1]);

      if (s0.toLowerCase() === "divjad") continue;

      if (
        s0 &&
        s0.toLowerCase() !== "realizacija odvzema" &&
        !s0.toLowerCase().startsWith("datum zadnjega") &&
        !s0.toLowerCase().startsWith("datum zadnje")
      ) {
        currentSpecies = s0;
      }

      const plan = num(r[2]);
      const executedFromExcel = num(r[3]);
      const total = num(r[13]);
      const percentExcel = num(r[14]);

      if (!safeStr(currentSpecies)) continue;
      if (!s1 && plan == null && executedFromExcel == null && total == null && percentExcel == null) continue;

      const classLabel = s1 || "skupaj";
      const key = makeKey(currentSpecies, classLabel);

      items.push({
        key,
        species: currentSpecies,
        classLabel,
        plan: plan ?? 0,
        executedExcel: executedFromExcel ?? 0,
        percentExcel: percentExcel ?? null,
        totalExcel: total ?? null,
      });
    }

    const id = `${ldId}_${year}`;
    await admin
      .firestore()
      .collection("odvzem_plans")
      .doc(id)
      .set(
        {
          ldId,
          year,
          title: `Realizacija odvzema – ${ldId}, ${year}`,
          source: {
            filename: safeStr(req.body?.filename) || "plan.xlsx",
            importedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          items,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

    return res.json({ ok: true, imported: items.length });
  } catch (e) {
    return res.status(e?.status || 500).json({
      error: e?.status ? e.message : "Server error",
      detail: e?.status ? undefined : String(e?.stack || e?.message || e),
    });
  }
});

router.get("/odvzem-view", requireAuth, async (req, res) => {
  try {
    const ldId = String(req.user?.ldId || "").trim();
    if (!ldId) return res.status(400).json({ error: "Missing ldId in token." });

    const year = Number(req.query?.year || 0);
    if (!year || year < 2020 || year > 2100) return res.status(400).json({ error: "Invalid year" });

    const { plan, rows } = await loadOdvzemViewRows(ldId, year);

    return res.json({
      ok: true,
      view: {
        ldId,
        year,
        canEdit: isStaff(req),
        title: plan.title || `Realizacija odvzema – ${ldId}, ${year}`,
        updatedAt: plan.updatedAt?.toDate ? plan.updatedAt.toDate().toISOString() : null,
        rows,
      },
    });
  } catch (e) {
    return res.status(500).json({ error: "Server error", detail: String(e?.stack || e?.message || e) });
  }
});

router.patch("/odvzem/override", requireAuth, requireStaff, async (req, res) => {
  try {
    const ldId = String(req.user?.ldId || "").trim();
    if (!ldId) return res.status(400).json({ error: "Missing ldId in token." });

    const year = Number(req.query?.year || 0);
    if (!year || year < 2020 || year > 2100) return res.status(400).json({ error: "Invalid year" });

    const key = safeStr(req.query?.key);
    if (!key) return res.status(400).json({ error: "Missing key" });

    const reason = safeStr(req.body?.reason);

    const planId = `${ldId}_${year}`;
    const ovRef = admin.firestore().collection("odvzem_plans").doc(planId).collection("overrides").doc(key);

    let delta = null;

    if (req.body?.executed != null) {
      const desired = numOrNull(req.body.executed);
      if (desired == null || desired < 0) return res.status(400).json({ error: "Invalid executed" });

      const auto = await computeAutoExecutedForKey(ldId, year, key);
      delta = desired - auto;
    } else if (req.body?.delta != null) {
      const d = numOrNull(req.body.delta);
      if (d == null) return res.status(400).json({ error: "Invalid delta" });
      delta = d;
    } else {
      return res.status(400).json({ error: "Missing executed or delta" });
    }

    if (delta === 0) {
      await ovRef.delete().catch(() => {});
      return res.json({ ok: true, key, removed: true });
    }

    await ovRef.set(
      {
        key,
        executedDelta: delta,
        reason,
        updatedBy: String(req.user?.uid || req.user?.code || ""),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    return res.json({ ok: true, key, executedDelta: delta });
  } catch (e) {
    return res.status(500).json({ error: "Server error", detail: String(e?.stack || e?.message || e) });
  }
});

router.delete("/odvzem/override", requireAuth, requireStaff, async (req, res) => {
  try {
    const ldId = String(req.user?.ldId || "").trim();
    if (!ldId) return res.status(400).json({ error: "Missing ldId in token." });

    const year = Number(req.query?.year || 0);
    if (!year || year < 2020 || year > 2100) return res.status(400).json({ error: "Invalid year" });

    const key = safeStr(req.query?.key);
    if (!key) return res.status(400).json({ error: "Missing key" });

    const planId = `${ldId}_${year}`;
    await admin.firestore().collection("odvzem_plans").doc(planId).collection("overrides").doc(key).delete();

    return res.json({ ok: true, key, deleted: true });
  } catch (e) {
    return res.status(500).json({ error: "Server error", detail: String(e?.stack || e?.message || e) });
  }
});

/* ================= ODVZEM EXPORT PDF ================= */

router.get("/odvzem/export-pdf", requireAuth, async (req, res) => {
  let finished = false;
  const safeEnd = () => {
    if (finished) return;
    finished = true;
    try {
      res.end();
    } catch {}
  };

  try {
    const ldId = String(req.user?.ldId || "").trim();
    const year = Number(req.query?.year || 0);

    if (!ldId) return res.status(400).json({ error: "Missing ldId in token." });
    if (!year || year < 2020 || year > 2100) return res.status(400).json({ error: "Invalid year" });

    const { rows } = await loadOdvzemViewRows(ldId, year);
    const displayRows = buildDisplayRows(rows);

    let fontReg, fontBold;
    try {
      ({ fontReg, fontBold } = getPdfFontsOrThrow());
    } catch (e) {
      return res.status(500).json({ error: "Missing PDF fonts", detail: e.detail || String(e.message) });
    }

    setPdfHeaders(res, `odvzem_${year}.pdf`);

    res.on("error", (err) => {
      console.error("res stream error:", err);
      safeEnd();
    });

    const doc = new PDFDocument({ size: "A4", layout: "landscape", margin: 28 });

    doc.on("error", (err) => {
      console.error("PDFKit error:", err);
      safeEnd();
    });

    res.on("close", () => {
      safeEnd();
      try {
        doc.end();
      } catch {}
    });

    doc.registerFont("D", fontReg);
    doc.registerFont("DB", fontBold);
    doc.pipe(res);

    const page = {
      left: doc.page.margins.left,
      top: doc.page.margins.top,
      bottom: doc.page.height - doc.page.margins.bottom,
      width: doc.page.width - doc.page.margins.left - doc.page.margins.right,
    };

    const cols = [
      { label: "Divjad", w: 140, align: "left" },
      { label: "Razred", w: 320, align: "left" },
      { label: "Plan", w: 70, align: "center" },
      { label: "Odstrel", w: 70, align: "center" },
      { label: "Pending", w: 70, align: "center" },
      { label: "%", w: 55, align: "center" },
      { label: "Status", w: 65, align: "center" },
    ];

    const rowH = 18;
    const headH = 22;

    doc.fillColor(ROG.green).font("DB").fontSize(18).text("REALIZACIJA ODVZEMA", page.left, page.top);
    doc.moveDown(0.25);
    doc.fillColor(ROG.muted).font("D").fontSize(10).text(`LD: ${ldId}     Leto: ${year}`, page.left);

    let y = doc.y + 10;

    const drawTableHeader = () => {
      doc.save();
      doc.fillColor(ROG.headerBeige).rect(page.left, y, page.width, headH).fill();
      doc.restore();

      doc.save();
      doc.lineWidth(0.8).strokeColor(ROG.border).rect(page.left, y, page.width, headH).stroke();
      doc.restore();

      let x = page.left;
      doc.fillColor(ROG.green).font("DB").fontSize(10);
      for (const c of cols) {
        doc.text(c.label, x + 6, y + 6, { width: c.w - 12, align: c.align });
        x += c.w;
      }
      y += headH;
    };

    const ensureSpace = (needH) => {
      if (y + needH <= page.bottom) return;

      doc.addPage();
      y = page.top;
      doc.fillColor(ROG.green).font("DB").fontSize(12).text(`REALIZACIJA ODVZEMA – ${ldId}, ${year}`, page.left, y);
      y = doc.y + 10;
      drawTableHeader();
    };

    const drawRow = (cells, opts = {}) => {
      ensureSpace(rowH);

      if (opts.zebra) {
        doc.save();
        doc.fillColor(ROG.zebra).rect(page.left, y, page.width, rowH).fill();
        doc.restore();
      }

      doc.save();
      doc.strokeColor(ROG.border).lineWidth(0.6);
      doc.rect(page.left, y, page.width, rowH).stroke();

      let xx = page.left;
      for (const c of cols) {
        doc.moveTo(xx, y).lineTo(xx, y + rowH).stroke();
        xx += c.w;
      }
      doc.moveTo(page.left + page.width, y).lineTo(page.left + page.width, y + rowH).stroke();
      doc.restore();

      let x = page.left;
      doc
        .fillColor(opts.bold ? ROG.green : ROG.text)
        .font(opts.bold ? "DB" : "D")
        .fontSize(9.5);

      for (let i = 0; i < cols.length; i++) {
        const c = cols[i];
        const v = cells[i] ?? "";
        doc.text(String(v), x + 6, y + 4, { width: c.w - 12, align: c.align, ellipsis: true });
        x += c.w;
      }

      y += rowH;
    };

    drawTableHeader();

    let zebra = false;
    for (const r of displayRows) {
      if (finished) break;

      if (r._type === "header") {
        zebra = false;
        drawRow([String(r.species || ""), "", "", "", "", "", ""], { bold: true, zebra: true });
        continue;
      }

      zebra = !zebra;

      const plan = r.plan == null ? "" : String(r.plan);
      const exec = r.executed == null ? "" : String(r.executed);
      const pend = r.pending == null ? "" : String(r.pending);

      const pctStr = (() => {
        const p = numOrNull(r.plan);
        const e = numOrNull(r.executed);
        if (!p || p <= 0 || e == null) return "";
        return `${Math.round((e / p) * 100)}`;
      })();

      const st = statusIcon(r.plan, r.executed);

      drawRow(["", r.classLabel || "", plan, exec, pend, pctStr, st], { bold: r._type === "total", zebra });
    }

    doc.end();
    finished = true;
  } catch (e) {
    console.error("odvzem export-pdf failed:", e);
    if (!res.headersSent)
      return res.status(500).json({ error: "Server error", detail: String(e?.stack || e?.message || e) });
    safeEnd();
  }
});

router.get("/odvzem/export-excel", requireAuth, async (req, res) => {
  try {
    const ldId = String(req.user?.ldId || "").trim();
    if (!ldId) return res.status(400).json({ error: "Missing ldId in token." });

    const year = Number(req.query?.year || 0);
    if (!year || year < 2020 || year > 2100) return res.status(400).json({ error: "Invalid year" });

    const { rows } = await loadOdvzemViewRows(ldId, year);
    const displayRows = buildDisplayRows(rows);

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Realizacija odvzema", {
      views: [{ showGridLines: false, state: "frozen", ySplit: 6 }],
    });

    ws.columns = [
      { header: "Divjad", key: "species", width: 18 },
      { header: "Razred", key: "classLabel", width: 40 },
      { header: "Plan", key: "plan", width: 12 },
      { header: "Odstrel", key: "executed", width: 12 },
      { header: "Pending", key: "pending", width: 12 },
      { header: "% realizacije", key: "pct", width: 14 },
      { header: "Status", key: "status", width: 12 },
    ];

    ws.mergeCells("A1:G1");
    ws.getCell("A1").value = "REALIZACIJA ODVZEMA";
    ws.getCell("A1").font = { name: "Cambria", size: 18, bold: true, color: { argb: "FF3F5E4B" } };

    ws.mergeCells("A2:G2");
    ws.getCell("A2").value = `LD: ${ldId}     Leto: ${year}`;
    ws.getCell("A2").font = { name: "Calibri", size: 11, bold: true, color: { argb: "FF3F5E4B" } };

    ws.mergeCells("A3:G3");
    ws.getCell("A3").value = "Datum zadnjega ažuriranja: __________     Vir: Dnevnik lova / Avtomatsko";
    ws.getCell("A3").font = { name: "Calibri", size: 10, color: { argb: "FF444444" } };

    ws.getRow(4).border = { bottom: { style: "medium", color: { argb: "FF3F5E4B" } } };

    const headerRow = ws.getRow(6);
    headerRow.values = ["Divjad", "Razred", "Plan", "Odstrel", "Pending", "% realizacije", "Status"];
    headerRow.height = 22;
    headerRow.eachCell((cell) => {
      cell.font = { name: "Calibri", size: 11, bold: true, color: { argb: "FF3F5E4B" } };
      cell.alignment = { vertical: "middle", horizontal: "center" };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEFE6D6" } };
      cell.border = {
        top: { style: "thin", color: { argb: "FF6B846B" } },
        left: { style: "thin", color: { argb: "FF6B846B" } },
        bottom: { style: "thin", color: { argb: "FF6B846B" } },
        right: { style: "thin", color: { argb: "FF6B846B" } },
      };
    });

    let rowIdx = 7;
    let zebra = false;

    for (const r of displayRows) {
      if (r._type === "header") {
        ws.mergeCells(`A${rowIdx}:G${rowIdx}`);
        const c = ws.getCell(`A${rowIdx}`);
        c.value = String(r.species || "");
        c.font = { name: "Calibri", size: 12, bold: true, color: { argb: "FF3F5E4B" } };
        c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF6F0E6" } };
        c.alignment = { vertical: "middle", horizontal: "left" };
        rowIdx++;
        zebra = false;
        continue;
      }

      zebra = !zebra;
      const isTotal = r._type === "total";

      const p = numOrNull(r.plan);
      const e = numOrNull(r.executed);
      const pend = numOrNull(r.pending);

      const row = ws.getRow(rowIdx);
      row.values = ["", r.classLabel || "", p == null ? null : p, e == null ? null : e, pend == null ? null : pend, null, statusIcon(p, e)];

      ws.getCell(`F${rowIdx}`).value = { formula: `IF(C${rowIdx}>0,D${rowIdx}/C${rowIdx}*100,"")` };
      ws.getCell(`F${rowIdx}`).numFmt = "0";

      row.eachCell((cell) => {
        cell.border = {
          top: { style: "thin", color: { argb: "FFC9D2C9" } },
          left: { style: "thin", color: { argb: "FFC9D2C9" } },
          bottom: { style: "thin", color: { argb: "FFC9D2C9" } },
          right: { style: "thin", color: { argb: "FFC9D2C9" } },
        };
        if (zebra) cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFAF5EC" } };
        if (isTotal) cell.font = { name: "Calibri", bold: true, color: { argb: "FF6B4E2E" } };
        cell.alignment = { vertical: "middle", horizontal: "center" };
      });

      rowIdx++;
    }

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="odvzem_${year}.xlsx"`);

    await wb.xlsx.write(res);
    res.end();
  } catch (e) {
    return res.status(500).json({ error: "Server error", detail: String(e?.stack || e?.message || e) });
  }
});

/* ================= HUNT LOGS ================= */

router.get("/hunt-logs", requireAuth, async (req, res) => {
  try {
    const ldId = String(req.user?.ldId || "").trim();
    if (!ldId) return res.status(400).json({ error: "Missing ldId in token." });

    const limit = Math.min(Number(req.query?.limit || 500), 2000);

    const fromRaw = String(req.query?.from || "").trim();
    const toRaw = String(req.query?.to || "").trim();

    const fromTs = fromRaw ? tsFromQuery(fromRaw) : null;
    const toTs = toRaw ? tsFromQuery(toRaw) : null;

    if (fromRaw && !fromTs) return res.status(400).json({ error: "Invalid 'from' date" });
    if (toRaw && !toTs) return res.status(400).json({ error: "Invalid 'to' date" });

    let q = admin.firestore().collection("hunt_logs").where("ldId", "==", ldId);

    if (fromTs) q = q.where("finishedAt", ">=", fromTs);
    if (toTs) q = q.where("finishedAt", "<=", toTs);

    q = q.orderBy("finishedAt", "desc").limit(limit);

    const snap = await q.get();

    const logs = snap.docs.map((d) => {
      const x = d.data() || {};
      return {
        id: d.id,
        hunterName: x.hunterName || "",
        hunterId: x.hunterId || "",
        ldId: x.ldId || "",
        startedAt: toIsoMaybe(x.startedAt),
        finishedAt: toIsoMaybe(x.finishedAt),
        harvest: !!x.harvest,
        species: x.species || "",
        notes: x.notes || "",
        endedReason: x.endedReason || "",
        locationName: x.locationName || "",
        createdAt: toIsoMaybe(x.createdAt),

        locationMode: x.locationMode || null,
        poiType: x.poiType || null,
        poiName: x.poiName || null,
        lat: numOrNull(x.lat),
        lng: numOrNull(x.lng),
        approxLat: numOrNull(x.approxLat),
        approxLng: numOrNull(x.approxLng),
        approxRadiusM: numOrNull(x.approxRadiusM),

        harvestItems: Array.isArray(x.harvestItems) ? x.harvestItems : [],
        pendingItems: Array.isArray(x.pendingItems) ? x.pendingItems : [],
      };
    });

    return res.json({ ok: true, logs });
  } catch (e) {
    return res.status(500).json({ error: "Server error", detail: String(e?.stack || e?.message || e) });
  }
});

function matchesHuntFilter(log, filter) {
  const h = !!log.harvest;
  if (filter === "harvest") return h;
  if (filter === "noharvest") return !h;
  return true;
}

function huntLogsToDisplayRows(logs) {
  return (Array.isArray(logs) ? logs : []).map((x) => {
    const harvestLabel = x.harvest ? "UPLEN" : "BREZ";
    const species = x.harvest ? (x.species || "—") : "—";
    const reason = x.endedReason || "manual";

    let location = x.locationName || "—";
    if (x.locationMode && String(x.locationMode).includes("approx")) {
      const km = x.approxRadiusM ? Math.max(1, Math.round(Number(x.approxRadiusM) / 1000)) : 1;
      location = `Približno območje (~${km} km)`;
    }

    return {
      Lovec: cleanPdfText(x.hunterName || "—"),
      "Začetek": cleanPdfText(fmtDtSI(x.startedAt)),
      Konec: cleanPdfText(fmtDtSI(x.finishedAt)),
      Uplen: harvestLabel,
      Vrsta: cleanPdfText(species),
      Razlog: cleanPdfText(reason),
      Lokacija: cleanPdfText(location),
      Lat: x.lat != null ? fmtNum6(x.lat) : "—",
      Lng: x.lng != null ? fmtNum6(x.lng) : "—",
      Opombe: cleanPdfText(x.notes || "—"),
    };
  });
}

router.get("/hunt-logs/export-pdf", requireAuth, async (req, res) => {
  let finished = false;
  const safeEnd = () => {
    if (finished) return;
    finished = true;
    try {
      res.end();
    } catch {}
  };

  try {
    const ldId = String(req.user?.ldId || "").trim();
    if (!ldId) return res.status(400).json({ error: "Missing ldId in token." });

    const from = String(req.query?.from || "").trim();
    const to = String(req.query?.to || "").trim();
    const filter = String(req.query?.filter || "all").trim();
    const limit = Math.min(Number(req.query?.limit || 2000), 2000);

    const fromTs = from ? tsFromQuery(from) : null;
    const toTs = to ? tsFromQuery(to) : null;

    if (from && !fromTs) return res.status(400).json({ error: "Invalid 'from' date" });
    if (to && !toTs) return res.status(400).json({ error: "Invalid 'to' date" });

    let q = admin.firestore().collection("hunt_logs").where("ldId", "==", ldId);
    if (fromTs) q = q.where("finishedAt", ">=", fromTs);
    if (toTs) q = q.where("finishedAt", "<=", toTs);
    q = q.orderBy("finishedAt", "desc").limit(limit);

    const snap = await q.get();

    const logs = snap.docs.map((d) => {
      const x = d.data() || {};
      return {
        hunterName: x.hunterName || "",
        startedAt: toIsoMaybe(x.startedAt),
        finishedAt: toIsoMaybe(x.finishedAt),
        harvest: !!x.harvest,
        species: x.species || "",
        endedReason: x.endedReason || "",
        locationName: x.locationName || "",
        locationMode: x.locationMode || null,
        lat: numOrNull(x.lat),
        lng: numOrNull(x.lng),
        approxRadiusM: numOrNull(x.approxRadiusM),
        notes: x.notes || "",
      };
    });

    const filtered = logs.filter((x) => matchesHuntFilter(x, filter));
    const rows = huntLogsToDisplayRows(filtered);

    const total = rows.length;
    const harvestCount = filtered.filter((x) => !!x.harvest).length;

    let fontReg, fontBold;
    try {
      ({ fontReg, fontBold } = getPdfFontsOrThrow());
    } catch (e) {
      return res.status(500).json({ error: "Missing PDF fonts", detail: e.detail || String(e.message) });
    }

    setPdfHeaders(res, `hunt_logs_${from || "all"}_${to || "all"}_${filter}.pdf`);

    res.on("error", (err) => {
      console.error("res stream error:", err);
      safeEnd();
    });

    const doc = new PDFDocument({ size: "A4", layout: "landscape", margin: 28 });

    doc.on("error", (err) => {
      console.error("PDFKit error:", err);
      safeEnd();
    });

    res.on("close", () => {
      safeEnd();
      try {
        doc.end();
      } catch {}
    });

    doc.registerFont("D", fontReg);
    doc.registerFont("DB", fontBold);
    doc.pipe(res);

    const page = {
      left: doc.page.margins.left,
      top: doc.page.margins.top,
      bottom: doc.page.height - doc.page.margins.bottom,
      width: doc.page.width - doc.page.margins.left - doc.page.margins.right,
    };

    doc.fillColor(ROG.green).font("DB").fontSize(18).text("DNEVNIKI LOVA", page.left, page.top);
    doc.moveDown(0.25);
    doc
      .fillColor(ROG.muted)
      .font("D")
      .fontSize(10)
      .text(`LD: ${ldId}     Obdobje: ${from || "—"} – ${to || "—"}     Filter: ${filter}`, page.left);

    doc.moveDown(0.15);
    doc
      .fillColor(ROG.green)
      .font("DB")
      .fontSize(10)
      .text(`Skupaj: ${total}     Uplen: ${harvestCount}`, page.left);

    let y = doc.y + 10;

    const cols = [
      { label: "Lovec", key: "Lovec", w: 120, align: "left" },
      { label: "Začetek", key: "Začetek", w: 120, align: "left" },
      { label: "Konec", key: "Konec", w: 120, align: "left" },
      { label: "Uplen", key: "Uplen", w: 65, align: "center" },
      { label: "Vrsta", key: "Vrsta", w: 120, align: "left" },
      { label: "Razlog", key: "Razlog", w: 90, align: "left" },
      { label: "Lokacija", key: "Lokacija", w: 190, align: "left" },
      { label: "Lat", key: "Lat", w: 85, align: "right" },
      { label: "Lng", key: "Lng", w: 85, align: "right" },
      { label: "Opombe", key: "Opombe", w: 210, align: "left" },
    ];

    const rowH = 18;
    const headH = 22;

    const drawHeader = () => {
      doc.save();
      doc.fillColor(ROG.headerBeige).rect(page.left, y, page.width, headH).fill();
      doc.restore();

      doc.save();
      doc.lineWidth(0.8).strokeColor(ROG.border).rect(page.left, y, page.width, headH).stroke();
      doc.restore();

      let x = page.left;
      doc.fillColor(ROG.green).font("DB").fontSize(10);
      for (const c of cols) {
        doc.text(c.label, x + 6, y + 6, { width: c.w - 12, align: c.align });
        x += c.w;
      }
      y += headH;
    };

    const ensureSpace = (needH) => {
      if (y + needH <= page.bottom) return;
      doc.addPage();
      y = page.top;
      doc.fillColor(ROG.green).font("DB").fontSize(12).text(`DNEVNIKI LOVA – ${ldId}`, page.left, y);
      y = doc.y + 10;
      drawHeader();
    };

    const drawRow = (cells, zebra) => {
      ensureSpace(rowH);

      if (zebra) {
        doc.save();
        doc.fillColor(ROG.zebra).rect(page.left, y, page.width, rowH).fill();
        doc.restore();
      }

      doc.save();
      doc.strokeColor(ROG.border).lineWidth(0.6);
      doc.rect(page.left, y, page.width, rowH).stroke();

      let xx = page.left;
      for (const c of cols) {
        doc.moveTo(xx, y).lineTo(xx, y + rowH).stroke();
        xx += c.w;
      }
      doc.moveTo(page.left + page.width, y).lineTo(page.left + page.width, y + rowH).stroke();
      doc.restore();

      let x = page.left;
      doc.fillColor(ROG.text).font("D").fontSize(9.5);

      for (let i = 0; i < cols.length; i++) {
        const c = cols[i];
        const v = cells[i] ?? "";
        doc.text(String(v), x + 6, y + 4, { width: c.w - 12, align: c.align, ellipsis: true });
        x += c.w;
      }

      y += rowH;
    };

    drawHeader();

    let zebra = false;
    for (const r of rows) {
      zebra = !zebra;
      drawRow(
        [
          r["Lovec"],
          r["Začetek"],
          r["Konec"],
          r["Uplen"],
          r["Vrsta"],
          r["Razlog"],
          r["Lokacija"],
          r["Lat"],
          r["Lng"],
          r["Opombe"],
        ],
        zebra
      );
    }

    doc.end();
    finished = true;
  } catch (e) {
    console.error("hunt-logs export-pdf failed:", e);
    if (!res.headersSent)
      return res.status(500).json({ error: "Server error", detail: String(e?.stack || e?.message || e) });
    safeEnd();
  }
});

router.get("/hunt-logs/export-csv", requireAuth, async (req, res) => {
  try {
    const ldId = String(req.user?.ldId || "").trim();
    if (!ldId) return res.status(400).json({ error: "Missing ldId in token." });

    const from = String(req.query?.from || "").trim();
    const to = String(req.query?.to || "").trim();
    const filter = String(req.query?.filter || "all").trim();
    const limit = Math.min(Number(req.query?.limit || 2000), 2000);

    const fromTs = from ? tsFromQuery(from) : null;
    const toTs = to ? tsFromQuery(to) : null;

    if (from && !fromTs) return res.status(400).json({ error: "Invalid 'from' date" });
    if (to && !toTs) return res.status(400).json({ error: "Invalid 'to' date" });

    let q = admin.firestore().collection("hunt_logs").where("ldId", "==", ldId);
    if (fromTs) q = q.where("finishedAt", ">=", fromTs);
    if (toTs) q = q.where("finishedAt", "<=", toTs);
    q = q.orderBy("finishedAt", "desc").limit(limit);

    const snap = await q.get();

    const logs = snap.docs.map((d) => {
      const x = d.data() || {};
      return {
        hunterName: x.hunterName || "",
        startedAt: toIsoMaybe(x.startedAt),
        finishedAt: toIsoMaybe(x.finishedAt),
        harvest: !!x.harvest,
        species: x.species || "",
        endedReason: x.endedReason || "",
        notes: x.notes || "",
        locationName: x.locationName || "",
        lat: numOrNull(x.lat),
        lng: numOrNull(x.lng),
      };
    });

    const filtered = logs.filter((x) => matchesHuntFilter(x, filter));

    const headers = ["Lovec", "Začetek", "Konec", "Uplen", "Vrsta", "Razlog", "Lokacija", "Lat", "Lng", "Opombe"];

    const escapeCsv = (v) => {
      const s = String(v ?? "");
      const needs = /[;"\n\r]/.test(s);
      const qv = s.replace(/"/g, '""');
      return needs ? `"${qv}"` : qv;
    };

    const rows = huntLogsToDisplayRows(filtered);

    let csv = headers.join(";") + "\r\n";
    for (const r of rows) {
      csv += headers.map((h) => escapeCsv(r[h] ?? "")).join(";") + "\r\n";
    }

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="hunt_logs_${from || "all"}_${to || "all"}_${filter}.csv"`
    );

    const bom = "\uFEFF";
    res.send(bom + csv);
  } catch (e) {
    return res.status(500).json({ error: "Server error", detail: String(e?.stack || e?.message || e) });
  }
});

/* ================= EVENTS ================= */

router.get("/events", requireAuth, async (req, res) => {
  try {
    const ldId = resolveTargetLdId(req);
    if (!ldId) return res.status(400).json({ error: "Missing ldId" });

    const limit = Math.min(Number(req.query?.limit || 500), 2000);
    const fromRaw = safeStr(req.query?.from);
    const toRaw = safeStr(req.query?.to);
    const future = safeStr(req.query?.future) === "1";

    const fromD = fromRaw ? new Date(fromRaw) : null;
    const toD = toRaw ? new Date(toRaw) : null;

    if (fromRaw && (!fromD || Number.isNaN(fromD.getTime()))) {
      return res.status(400).json({ error: "Invalid from" });
    }
    if (toRaw && (!toD || Number.isNaN(toD.getTime()))) {
      return res.status(400).json({ error: "Invalid to" });
    }

    const snap = await admin
      .firestore()
      .collection("ld_events")
      .where("ldId", "==", ldId)
      .limit(2000)
      .get();

    let events = snap.docs.map((d) => {
      const x = d.data() || {};
      const startsAtIso = x.startsAt?.toDate ? x.startsAt.toDate().toISOString() : null;
      const attachments = Array.isArray(x.attachments) ? x.attachments : [];

      return {
        id: d.id,
        ldId: x.ldId || "",
        title: x.title || "",
        startsAt: startsAtIso,
        location: x.location || "",
        description: x.description || "",
        attachments: attachments.map((a) => ({
          attachmentId: a.attachmentId || null,
          filename: a.filename || "",
          mime: a.mime || "",
          path: a.path || "",
          url: a.url || null,
          uploadedAt: toIsoMaybe(a.uploadedAt),
          uploadedBy: a.uploadedBy || "",
        })),
        createdAt: toIsoMaybe(x.createdAt),
        updatedAt: toIsoMaybe(x.updatedAt),
      };
    });

    events.sort((a, b) => {
      const ta = a.startsAt ? new Date(a.startsAt).getTime() : 0;
      const tb = b.startsAt ? new Date(b.startsAt).getTime() : 0;
      return ta - tb;
    });

    if (future) {
      const now = Date.now();
      events = events.filter((e) => {
        const t = e.startsAt ? new Date(e.startsAt).getTime() : 0;
        return t && t >= now - 60 * 60 * 1000;
      });
    }

    if (fromD) {
      const t0 = fromD.getTime();
      events = events.filter((e) => (e.startsAt ? new Date(e.startsAt).getTime() : 0) >= t0);
    }

    if (toD) {
      const t1 = toD.getTime();
      events = events.filter((e) => (e.startsAt ? new Date(e.startsAt).getTime() : 0) <= t1);
    }

    events = events.slice(0, limit);

    return res.json({ ok: true, ldId, events });
  } catch (e) {
    return res.status(500).json({ error: "Server error", detail: String(e?.stack || e?.message || e) });
  }
});

router.post("/events", requireAuth, requireStaff, async (req, res) => {
  try {
    const ldId = resolveTargetLdId(req);
    if (!ldId) return res.status(400).json({ error: "Missing ldId" });

    const title = safeStr(req.body?.title);
    const startsAtRaw = safeStr(req.body?.startsAt);
    const location = safeStr(req.body?.location);
    const description = safeStr(req.body?.description);

    if (!title) return res.status(400).json({ error: "Missing title" });
    if (!startsAtRaw) return res.status(400).json({ error: "Missing startsAt" });

    const d = new Date(startsAtRaw);
    if (Number.isNaN(d.getTime())) return res.status(400).json({ error: "Invalid startsAt" });

    const ref = admin.firestore().collection("ld_events").doc();

    await ref.set(
      {
        ldId,
        title,
        startsAt: admin.firestore.Timestamp.fromDate(d),
        location,
        description,
        attachments: [],
        createdBy: String(req.user?.uid || req.user?.code || ""),
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    try {
      await sendToLd({
        ldId,
        title: "Nov dogodek",
        body: `Dodan je bil nov dogodek: ${title}`,
        data: {
          type: "event_created",
          ldId,
          eventId: ref.id,
        },
      });
    } catch (pushError) {
      console.error("event_created push failed:", pushError);
    }

    return res.json({ ok: true, id: ref.id, ldId });
  } catch (e) {
    return res.status(500).json({
      error: "Server error",
      detail: String(e?.stack || e?.message || e),
    });
  }
});

router.patch("/events/:id", requireAuth, requireStaff, async (req, res) => {
  try {
    const tokenLdId = String(req.user?.ldId || "").trim();
    const requestedLdId = resolveTargetLdId(req);
    const id = String(req.params.id || "").trim();

    if (!tokenLdId) return res.status(400).json({ error: "Missing ldId in token." });
    if (!id) return res.status(400).json({ error: "Missing id" });

    const ref = admin.firestore().collection("ld_events").doc(id);
    const snap = await ref.get();

    if (!snap.exists) {
      return res.status(404).json({ error: "Event not found" });
    }

    const data = snap.data() || {};
    const eventLdId = String(data.ldId || "").trim();

    if (!isSuper(req) && eventLdId !== tokenLdId) {
      return res.status(403).json({ error: "Forbidden (other LD)" });
    }

    const patch = {};

    if (req.body?.title != null) patch.title = safeStr(req.body.title);
    if (req.body?.location != null) patch.location = safeStr(req.body.location);
    if (req.body?.description != null) patch.description = safeStr(req.body.description);

    if (req.body?.startsAt != null) {
      const d = new Date(String(req.body.startsAt));
      if (Number.isNaN(d.getTime())) {
        return res.status(400).json({ error: "Invalid startsAt" });
      }
      patch.startsAt = admin.firestore.Timestamp.fromDate(d);
    }

    if (isSuper(req) && requestedLdId && requestedLdId !== eventLdId) {
      patch.ldId = requestedLdId;
    }

    patch.updatedAt = admin.firestore.FieldValue.serverTimestamp();

    await ref.set(patch, { merge: true });

    const finalLdId = patch.ldId || eventLdId || tokenLdId;
    const mergedTitle = patch.title || data.title || "Dogodek";

    try {
      await sendToLd({
        ldId: finalLdId,
        title: "Sprememba dogodka",
        body: `Dogodek "${mergedTitle}" je bil posodobljen.`,
        data: {
          type: "event_updated",
          ldId: finalLdId,
          eventId: id,
        },
      });
    } catch (pushError) {
      console.error("event_updated push failed:", pushError);
    }

    return res.json({ ok: true, id, ldId: finalLdId, patch });
  } catch (e) {
    return res.status(500).json({
      error: "Server error",
      detail: String(e?.stack || e?.message || e),
    });
  }
});

router.delete("/events/:id", requireAuth, requireStaff, async (req, res) => {
  try {
    const tokenLdId = String(req.user?.ldId || "").trim();
    const id = String(req.params.id || "").trim();
    if (!tokenLdId) return res.status(400).json({ error: "Missing ldId in token." });
    if (!id) return res.status(400).json({ error: "Missing id" });

    const ref = admin.firestore().collection("ld_events").doc(id);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ error: "Event not found" });

    const ev = snap.data() || {};
    const eventLdId = String(ev.ldId || "").trim();

    if (!isSuper(req) && eventLdId !== tokenLdId) return res.status(403).json({ error: "Forbidden (other LD)" });

    const attachments = Array.isArray(ev.attachments) ? ev.attachments : [];
    const bucket = admin.storage().bucket();

    for (const a of attachments) {
      if (a?.path) {
        try {
          await bucket.file(a.path).delete();
        } catch {}
      }
    }

    await ref.delete();
    return res.json({ ok: true, id, ldId: eventLdId, deleted: true });
  } catch (e) {
    return res.status(500).json({ error: "Server error", detail: String(e?.stack || e?.message || e) });
  }
});

/* ================= EVENTS IMPORT HELPERS ================= */

function parseCsvLine(line) {
  const out = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (q && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        q = !q;
      }
      continue;
    }
    if (!q && (ch === ";" || ch === ",")) {
      out.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur.trim());
  return out;
}

function parseEventsFromCsv(text) {
  const lines = String(text || "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((x) => x.trim())
    .filter(Boolean);

  if (lines.length === 0) return [];

  const header = parseCsvLine(lines[0]).map((h) => normalizeHeaderKey(h));
  const idx = (name) => header.indexOf(normalizeHeaderKey(name));

  const iTitle = idx("title") >= 0 ? idx("title") : idx("naslov");
  const iStartsAt = idx("startsAt") >= 0 ? idx("startsAt") : idx("zacetek");
  const iLocation = idx("location") >= 0 ? idx("location") : idx("lokacija");
  const iDescription = idx("description") >= 0 ? idx("description") : idx("opis");

  const items = [];
  for (let li = 1; li < lines.length; li++) {
    const row = parseCsvLine(lines[li]);
    const title = safeStr(row[iTitle]);
    const startsRaw = safeStr(row[iStartsAt]);
    if (!title || !startsRaw) continue;

    let d = new Date(startsRaw);

    if (Number.isNaN(d.getTime())) {
      const m = startsRaw.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})\s+(\d{1,2}):(\d{2})$/);
      if (m) {
        const [, dd, mm, yyyy, hh, min] = m;
        d = new Date(
          `${yyyy}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}T${String(hh).padStart(2, "0")}:${min}:00`
        );
      }
    }

    if (Number.isNaN(d.getTime())) continue;

    items.push({
      title,
      startsAt: d.toISOString(),
      location: safeStr(row[iLocation]),
      description: safeStr(row[iDescription]),
    });
  }
  return items;
}

function parseEventsFromJson(text) {
  const j = JSON.parse(String(text || ""));
  const arr = Array.isArray(j) ? j : Array.isArray(j?.events) ? j.events : [];
  return arr
    .map((x) => ({
      title: safeStr(x?.title || x?.naslov),
      startsAt: x?.startsAt || x?.zacetek || null,
      location: safeStr(x?.location || x?.lokacija),
      description: safeStr(x?.description || x?.opis),
    }))
    .filter((x) => {
      if (!x.title || !x.startsAt) return false;
      const d = new Date(String(x.startsAt));
      return !Number.isNaN(d.getTime());
    })
    .map((x) => {
      const d = new Date(String(x.startsAt));
      return { ...x, startsAt: d.toISOString() };
    });
}

/* ================= EVENTS IMPORT ================= */

router.post("/events/import", requireAuth, requireStaff, async (req, res) => {
  try {
    const ldId = resolveTargetLdId(req);
    if (!ldId) return res.status(400).json({ error: "Missing ldId" });

    const filename = safeStr(req.body?.filename) || "events.csv";
    const b64 = safeStr(req.body?.contentBase64);
    if (!b64) return res.status(400).json({ error: "Missing contentBase64" });

    assertBase64UnderLimit(b64, MAX_IMPORT_BYTES, "Import file");

    const buf = Buffer.from(b64, "base64");
    const text = buf.toString("utf8");

    let items = [];
    const lower = filename.toLowerCase();

    if (lower.endsWith(".json")) items = parseEventsFromJson(text);
    else items = parseEventsFromCsv(text);

    if (!items.length) {
      return res.status(400).json({
        error: "No valid events in file",
        hint: "CSV header: title;startsAt;location;description (ali: naslov;zacetek;lokacija;opis)",
      });
    }

    const db = admin.firestore();
    const col = db.collection("ld_events");

    const BATCH_LIMIT = 450;
    let batch = db.batch();
    let ops = 0;
    let created = 0;

    for (const it of items) {
      const ref = col.doc();
      batch.set(ref, {
        ldId,
        title: it.title,
        startsAt: admin.firestore.Timestamp.fromDate(new Date(it.startsAt)),
        location: it.location || "",
        description: it.description || "",
        attachments: [],
        source: { type: "import", filename },
        createdBy: String(req.user?.uid || req.user?.code || ""),
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      ops++;
      created++;

      if (ops >= BATCH_LIMIT) {
        await batch.commit();
        batch = db.batch();
        ops = 0;
      }
    }

    if (ops > 0) await batch.commit();

    return res.json({ ok: true, filename, ldId, created });
  } catch (e) {
    return res.status(e?.status || 500).json({
      error: e?.status ? e.message : "Server error",
      detail: e?.status ? undefined : String(e?.stack || e?.message || e),
    });
  }
});

/* ================= EVENTS ATTACHMENTS ================= */

router.post("/events/:id/attachment", requireAuth, requireStaff, async (req, res) => {
  try {
    const tokenLdId = String(req.user?.ldId || "").trim();
    if (!tokenLdId) return res.status(400).json({ error: "Missing ldId in token." });

    const id = String(req.params.id || "").trim();
    if (!id) return res.status(400).json({ error: "Missing event id" });

    const filename = safeStr(req.body?.filename);
    const mime = safeStr(req.body?.mime);
    const b64 = safeStr(req.body?.contentBase64);

    if (!filename) return res.status(400).json({ error: "Missing filename" });
    if (!mime) return res.status(400).json({ error: "Missing mime" });
    if (!b64) return res.status(400).json({ error: "Missing contentBase64" });

    const evRef = admin.firestore().collection("ld_events").doc(id);
    const evSnap = await evRef.get();
    if (!evSnap.exists) return res.status(404).json({ error: "Event not found" });

    const ev = evSnap.data() || {};
    const eventLdId = String(ev.ldId || "").trim();

    if (!isSuper(req) && eventLdId !== tokenLdId) {
      return res.status(403).json({ error: "Forbidden (other LD)" });
    }

    const currentAttachments = Array.isArray(ev.attachments) ? ev.attachments : [];
    if (currentAttachments.length >= MAX_EVENT_ATTACHMENTS) {
      return res.status(400).json({ error: `Too many attachments (max ${MAX_EVENT_ATTACHMENTS})` });
    }

    assertBase64UnderLimit(b64, MAX_ATTACHMENT_BYTES, "Attachment");
    const { safeName, mime: safeMime } = assertAllowedAttachment(filename, mime);

    const bucket = admin.storage().bucket();
    const attachmentId = admin.firestore().collection("_").doc().id;
    const objectPath = `ld_events/${eventLdId}/${id}/${attachmentId}_${safeName}`;

    const buf = Buffer.from(b64, "base64");
    const file = bucket.file(objectPath);

    await file.save(buf, {
      metadata: {
        contentType: safeMime,
        metadata: {
          uploadedBy: String(req.user?.uid || req.user?.code || ""),
          ldId: eventLdId,
          eventId: id,
          attachmentId,
        },
      },
      resumable: false,
      validation: "crc32c",
    });

    const attachment = {
      attachmentId,
      filename: safeName,
      mime: safeMime,
      path: objectPath,
      url: `/ld/events/${id}/attachments/${attachmentId}/download`,
      uploadedAt: admin.firestore.Timestamp.now(),
      uploadedBy: String(req.user?.uid || req.user?.code || ""),
    };

    await evRef.set(
      {
        attachments: admin.firestore.FieldValue.arrayUnion(attachment),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    return res.json({
      ok: true,
      id,
      ldId: eventLdId,
      attachment: {
        attachmentId,
        filename: safeName,
        mime: safeMime,
        url: attachment.url,
      },
    });
  } catch (e) {
    return res.status(e?.status || 500).json({
      error: e?.status ? e.message : "Server error",
      detail: e?.status ? undefined : String(e?.stack || e?.message || e),
    });
  }
});

router.get("/events/:id/attachments/:attachmentId/download", requireAuth, async (req, res) => {
  try {
    const tokenLdId = String(req.user?.ldId || "").trim();
    const id = String(req.params.id || "").trim();
    const attachmentId = String(req.params.attachmentId || "").trim();

    if (!tokenLdId) return res.status(400).json({ error: "Missing ldId in token." });
    if (!id) return res.status(400).json({ error: "Missing event id" });
    if (!attachmentId) return res.status(400).json({ error: "Missing attachmentId" });

    const evRef = admin.firestore().collection("ld_events").doc(id);
    const evSnap = await evRef.get();
    if (!evSnap.exists) return res.status(404).json({ error: "Event not found" });

    const ev = evSnap.data() || {};
    const eventLdId = String(ev.ldId || "").trim();

    if (!isSuper(req) && eventLdId !== tokenLdId) {
      return res.status(403).json({ error: "Forbidden (other LD)" });
    }

    const attachments = Array.isArray(ev.attachments) ? ev.attachments : [];
    const att = attachments.find((a) => String(a?.attachmentId || "") === attachmentId);

    if (!att || !att.path) {
      return res.status(404).json({ error: "Attachment not found" });
    }

    const bucket = admin.storage().bucket();
    const file = bucket.file(att.path);

    const [exists] = await file.exists();
    if (!exists) {
      return res.status(404).json({ error: "Attachment file not found in storage" });
    }

    res.setHeader("Content-Type", att.mime || "application/octet-stream");
    res.setHeader("Content-Disposition", `inline; filename="${sanitizeFileName(att.filename || "file")}"`);

    file.createReadStream()
      .on("error", (err) => {
        if (!res.headersSent) {
          res.status(500).json({ error: "Failed to stream file", detail: String(err?.message || err) });
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

/* ================= MY HUNT STATS ================= */

router.get("/hunt-stats/me", requireAuth, async (req, res) => {
  try {
    const ldId = String(req.user?.ldId || "").trim();
    const hunterId = String(req.user?.code || req.user?.hunterId || req.user?.id || "").trim();

    if (!ldId) {
      return res.status(400).json({ error: "Missing ldId in token." });
    }

    if (!hunterId) {
      return res.status(400).json({ error: "Missing hunterId in token." });
    }

    const year = Number(req.query?.year || new Date().getFullYear());
    if (!year || year < 2020 || year > 2100) {
      return res.status(400).json({ error: "Invalid year" });
    }

    const start = admin.firestore.Timestamp.fromDate(
      new Date(year, 0, 1, 0, 0, 0)
    );
    const end = admin.firestore.Timestamp.fromDate(
      new Date(year + 1, 0, 1, 0, 0, 0)
    );

    const snap = await admin
      .firestore()
      .collection("hunt_logs")
      .where("ldId", "==", ldId)
      .where("hunterId", "==", hunterId)
      .get();

    const logs = snap.docs.map((d) => {
      const x = d.data() || {};
      return {
        id: d.id,
        hunterId: x.hunterId || "",
        hunterName: x.hunterName || "",
        startedAt: x.startedAt || null,
        finishedAt: x.finishedAt || null,
        harvest: x.harvest === true,
        species: x.species || "",
        notes: x.notes || "",
        endedReason: x.endedReason || "",
      };
    });

    const totalHunts = logs.length;

    const huntsThisYear = logs.filter((log) => {
      if (!log.startedAt?.toDate) return false;
      const d = log.startedAt.toDate();
      return d.getFullYear() === year;
    });

    const finishedThisYear = logs.filter((log) => {
      if (!log.finishedAt?.toDate) return false;
      const d = log.finishedAt.toDate();
      return d >= start.toDate() && d < end.toDate();
    });

    const successfulThisYear = finishedThisYear.filter((log) => log.harvest);

    const finishedHunts = finishedThisYear.length;
    const successfulHunts = successfulThisYear.length;
    const successRate =
      finishedHunts > 0 ? (successfulHunts / finishedHunts) * 100 : 0;

    const sortedFinished = [...finishedThisYear].sort((a, b) => {
      const ta = a.finishedAt?.toDate ? a.finishedAt.toDate().getTime() : 0;
      const tb = b.finishedAt?.toDate ? b.finishedAt.toDate().getTime() : 0;
      return tb - ta;
    });

    const lastHunt = sortedFinished[0] || null;

    let lastHuntLabel = null;
    if (lastHunt?.finishedAt?.toDate) {
      const d = lastHunt.finishedAt.toDate();
      const dateStr = d.toLocaleDateString("sl-SI");
      if (lastHunt.harvest) {
        lastHuntLabel = lastHunt.species
          ? `${lastHunt.species} - ${dateStr}`
          : `Uspešen lov - ${dateStr}`;
      } else {
        lastHuntLabel = `Brez uplena - ${dateStr}`;
      }
    }

    return res.json({
      ok: true,
      ldId,
      hunterId,
      year,
      totalHunts,
      huntsThisYear: huntsThisYear.length,
      successfulHunts,
      finishedHunts,
      successRate: Number(successRate.toFixed(1)),
      lastHuntLabel,
    });
  } catch (e) {
    return res.status(500).json({
      error: "Server error",
      detail: String(e?.stack || e?.message || e),
    });
  }
});

/* ================= HUNTER ASSIGNMENTS ================= */

router.get("/hunter-assignments", requireAuth, requireStaff, async (req, res) => {
  try {
    const ldId = String(req.user?.ldId || "").trim();
    if (!ldId) {
      return res.status(400).json({ error: "Missing ldId in token." });
    }

    const snap = await admin
      .firestore()
      .collection("hunter_assignments")
      .where("ldId", "==", ldId)
      .get();

    const assignments = snap.docs.map((d) => {
      const x = d.data() || {};
      return {
        id: d.id,
        hunterId: x.hunterId || "",
        hunterName: x.hunterName || "",
        title: x.title || "",
        description: x.description || "",
        location: x.location || "",
        category: x.category || "",
        status: x.status || "active",
        createdAt: toIsoMaybe(x.createdAt),
        updatedAt: toIsoMaybe(x.updatedAt),
      };
    });

    assignments.sort((a, b) => {
      const h = String(a.hunterName).localeCompare(String(b.hunterName), "sl");
      if (h !== 0) return h;
      return String(a.title).localeCompare(String(b.title), "sl");
    });

    return res.json({ ok: true, assignments });
  } catch (e) {
    return res.status(500).json({
      error: "Server error",
      detail: String(e?.stack || e?.message || e),
    });
  }
});

router.get("/hunter-assignments/me", requireAuth, async (req, res) => {
  try {
    const ldId = String(req.user?.ldId || "").trim();
    const hunterId = String(req.user?.code || req.user?.hunterId || req.user?.id || "").trim();

    if (!ldId) {
      return res.status(400).json({ error: "Missing ldId in token." });
    }

    if (!hunterId) {
      return res.status(400).json({ error: "Missing hunterId in token." });
    }

    const snap = await admin
      .firestore()
      .collection("hunter_assignments")
      .where("ldId", "==", ldId)
      .where("hunterId", "==", hunterId)
      .get();

    const assignments = snap.docs
      .map((d) => {
        const x = d.data() || {};
        return {
          id: d.id,
          title: x.title || "",
          description: x.description || "",
          location: x.location || "",
          category: x.category || "",
          status: x.status || "active",
          createdAt: toIsoMaybe(x.createdAt),
          updatedAt: toIsoMaybe(x.updatedAt),
        };
      })
      .sort((a, b) => String(a.title).localeCompare(String(b.title), "sl"));

    return res.json({
      ok: true,
      ldId,
      hunterId,
      assignments,
    });
  } catch (e) {
    return res.status(500).json({
      error: "Server error",
      detail: String(e?.stack || e?.message || e),
    });
  }
});

router.post("/hunter-assignments", requireAuth, requireStaff, async (req, res) => {
  try {
    const ldId = String(req.user?.ldId || "").trim();
    if (!ldId) {
      return res.status(400).json({ error: "Missing ldId in token." });
    }

    const hunterId = safeStr(req.body?.hunterId);
    const title = safeStr(req.body?.title);
    const description = safeStr(req.body?.description);
    const location = safeStr(req.body?.location);
    const category = safeStr(req.body?.category);
    const status = safeStr(req.body?.status || "active");

    if (!hunterId) return res.status(400).json({ error: "Missing hunterId" });
    if (!title) return res.status(400).json({ error: "Missing title" });

    const hunterRef = admin.firestore().collection("hunters").doc(hunterId);
    const hunterSnap = await hunterRef.get();

    if (!hunterSnap.exists) {
      return res.status(404).json({ error: "Hunter not found" });
    }

    const hunter = hunterSnap.data() || {};
    if (!isSuper(req) && String(hunter.ldId || "") !== ldId) {
      return res.status(403).json({ error: "Forbidden (other LD)" });
    }

    const ref = admin.firestore().collection("hunter_assignments").doc();

    await ref.set({
      ldId,
      hunterId,
      hunterName: safeStr(hunter.name),
      title,
      description,
      location,
      category,
      status,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      createdBy: String(req.user?.uid || req.user?.code || ""),
      updatedBy: String(req.user?.uid || req.user?.code || ""),
    });

    try {
      await sendToHunter({
        hunterId,
        title: "Nova zadolžitev",
        body: `Dodeljena ti je bila nova zadolžitev: ${title}`,
        data: {
          type: "assignment_created",
          ldId,
          assignmentId: ref.id,
        },
      });
    } catch (pushError) {
      console.error("assignment_created push failed:", pushError);
    }

    return res.json({
      ok: true,
      id: ref.id,
    });
  } catch (e) {
    return res.status(500).json({
      error: "Server error",
      detail: String(e?.stack || e?.message || e),
    });
  }
});

router.patch("/hunter-assignments/:id", requireAuth, requireStaff, async (req, res) => {
  try {
    const ldId = String(req.user?.ldId || "").trim();
    const id = String(req.params.id || "").trim();

    if (!ldId) return res.status(400).json({ error: "Missing ldId in token." });
    if (!id) return res.status(400).json({ error: "Missing id" });

    const ref = admin.firestore().collection("hunter_assignments").doc(id);
    const snap = await ref.get();

    if (!snap.exists) {
      return res.status(404).json({ error: "Assignment not found" });
    }

    const data = snap.data() || {};
    if (!isSuper(req) && String(data.ldId || "") !== ldId) {
      return res.status(403).json({ error: "Forbidden (other LD)" });
    }

    const patch = {};

    if (req.body?.title != null) patch.title = safeStr(req.body.title);
    if (req.body?.description != null) patch.description = safeStr(req.body.description);
    if (req.body?.location != null) patch.location = safeStr(req.body.location);
    if (req.body?.category != null) patch.category = safeStr(req.body.category);
    if (req.body?.status != null) patch.status = safeStr(req.body.status);

    patch.updatedAt = admin.firestore.FieldValue.serverTimestamp();
    patch.updatedBy = String(req.user?.uid || req.user?.code || "");

    await ref.set(patch, { merge: true });

    return res.json({ ok: true, id, patch });
  } catch (e) {
    return res.status(500).json({
      error: "Server error",
      detail: String(e?.stack || e?.message || e),
    });
  }
});

router.delete("/hunter-assignments/:id", requireAuth, requireStaff, async (req, res) => {
  try {
    const ldId = String(req.user?.ldId || "").trim();
    const id = String(req.params.id || "").trim();

    if (!ldId) return res.status(400).json({ error: "Missing ldId in token." });
    if (!id) return res.status(400).json({ error: "Missing id" });

    const ref = admin.firestore().collection("hunter_assignments").doc(id);
    const snap = await ref.get();

    if (!snap.exists) {
      return res.status(404).json({ error: "Assignment not found" });
    }

    const data = snap.data() || {};
    if (!isSuper(req) && String(data.ldId || "") !== ldId) {
      return res.status(403).json({ error: "Forbidden (other LD)" });
    }

    await ref.delete();

    return res.json({ ok: true, deleted: id });
  } catch (e) {
    return res.status(500).json({
      error: "Server error",
      detail: String(e?.stack || e?.message || e),
    });
  }
});

module.exports = router;