// src/routes/ld.routes.js
const express = require("express");
const bcrypt = require("bcrypt");
const XLSX = require("xlsx"); // ✅ NEW (npm i xlsx)
const { admin } = require("../firebase");
const { requireAuth } = require("../auth");

const router = express.Router();

/* ================= HELPERS ================= */

function isSuper(req) {
  return String(req.user?.role || "") === "super";
}

function isStaff(req) {
  const role = String(req.user?.role || "member");
  return role === "super" || role === "moderator";
}

function requireStaff(req, res, next) {
  if (isStaff(req)) return next();
  return res.status(403).json({ error: "Forbidden (staff only)" });
}

function genPin4() {
  return String(Math.floor(Math.random() * 10000)).padStart(4, "0");
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

function numOrNull(v) {
  return typeof v === "number" ? v : null;
}

function safeStr(v) {
  return (v == null ? "" : String(v)).trim();
}

function num(v) {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

function pct(n, d) {
  const nn = Number(n || 0);
  const dd = Number(d || 0);
  if (!dd || dd <= 0) return "—";
  return `${Math.round((nn / dd) * 100)}%`;
}

// Pretvori excel row v normaliziran key (da se ujema z app harvestItems.key)
// primer: species="srna", class="mladiči moškega spola" -> "SRNA__MLADICI_MOSKEGA_SPOLA"
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

/* ================= DASHBOARD ================= */

router.get("/dashboard", requireAuth, async (req, res) => {
  try {
    const ldId = String(req.user?.ldId || "").trim();
    if (!ldId) return res.status(400).json({ error: "Missing ldId in token." });

    // LD name
    let ldName = ldId;
    try {
      const ldSnap = await admin.firestore().collection("lds").doc(ldId).get();
      if (ldSnap.exists) {
        const d = ldSnap.data() || {};
        ldName = d.name || d.title || ldId;
      }
    } catch (_) {}

    // users count
    const huntersSnap = await admin.firestore().collection("hunters").where("ldId", "==", ldId).get();
    const usersCount = huntersSnap.size;

    // hunts this month
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
    } catch (_) {
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
    return res.status(500).json({ error: "Server error", detail: String(e?.stack || e?.message || e) });
  }
});

/* ================= USERS (hunters) ================= */

// Staff (moderator/super) vidi uporabnike svoje LD
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
      .sort((a, b) => String(a.name).localeCompare(String(b.name)));

    return res.json({ ok: true, users });
  } catch (e) {
    return res.status(500).json({ error: "Server error", detail: String(e?.stack || e?.message || e) });
  }
});

// Staff: ustvari lovca v svoji LD
router.post("/users", requireAuth, requireStaff, async (req, res) => {
  try {
    const ldId = String(req.user?.ldId || "").trim();
    if (!ldId) return res.status(400).json({ error: "Missing ldId in token." });

    const code = String(req.body?.code || "").trim();
    const name = String(req.body?.name || "").trim();
    const role = String(req.body?.role || "member").trim();

    if (!code) return res.status(400).json({ error: "Missing code" });
    if (!name) return res.status(400).json({ error: "Missing name" });
    if (!["member", "moderator", "super"].includes(role)) return res.status(400).json({ error: "Invalid role" });

    // moderator ne sme ustvariti super
    if (!isSuper(req) && role === "super") return res.status(403).json({ error: "Forbidden (cannot create super)" });

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
    return res.status(500).json({ error: "Server error", detail: String(e?.stack || e?.message || e) });
  }
});

// Staff: spremeni uporabnika (enabled/name/role) - samo v svoji LD
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
    if (!isSuper(req) && String(data.ldId || "") !== ldId) return res.status(403).json({ error: "Forbidden (other LD)" });

    const patch = {};

    if (typeof req.body?.enabled === "boolean") patch.enabled = req.body.enabled;
    if (req.body?.name != null) patch.name = String(req.body.name).trim();

    if (req.body?.role != null) {
      const r = String(req.body.role).trim();
      if (!["member", "moderator", "super"].includes(r)) return res.status(400).json({ error: "Invalid role" });
      if (!isSuper(req) && r === "super") return res.status(403).json({ error: "Forbidden (cannot set super)" });
      patch.role = r;
    }

    patch.updatedAt = admin.firestore.FieldValue.serverTimestamp();
    await ref.set(patch, { merge: true });

    return res.json({ ok: true, code, patch });
  } catch (e) {
    return res.status(500).json({ error: "Server error", detail: String(e?.stack || e?.message || e) });
  }
});

// ✅ Staff: trajno izbriši uporabnika
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

    // moderator ne sme brisat druge LD
    if (!isSuper(req) && String(data.ldId || "") !== ldId) {
      return res.status(403).json({ error: "Forbidden (other LD)" });
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

// Staff: reset PIN (vrne nov pin)
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
    if (!isSuper(req) && String(data.ldId || "") !== ldId) return res.status(403).json({ error: "Forbidden (other LD)" });

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
    return res.status(500).json({ error: "Server error", detail: String(e?.stack || e?.message || e) });
  }
});

/* ================= ACTIVE HUNTS ================= */

// GET /ld/active-hunts
// member + moderator + super: read (samo svoj LD)
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
        hunterId: x.hunterId || null, // firebase uid owner
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
    return res.status(500).json({ error: "Server error", detail: String(e?.stack || e?.message || e) });
  }
});

/* ================= LD POINTS ================= */

// GET /ld/points (member+)
router.get("/points", requireAuth, async (req, res) => {
  try {
    const ldId = String(req.user?.ldId || "").trim();
    if (!ldId) return res.status(400).json({ error: "Missing ldId in token." });

    const snap = await admin.firestore().collection("ld_points").where("ldId", "==", ldId).get();

    const points = snap.docs.map((d) => {
      const x = d.data() || {};
      return {
        id: d.id,
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
    return res.status(500).json({ error: "Server error", detail: String(e?.stack || e?.message || e) });
  }
});

/* ================= ODVZEM: IMPORT PLAN + VIEW ================= */

// POST /ld/odvzem-plan/import-excel?year=2025  (staff only)
// body: { filename, contentBase64 }
router.post("/odvzem-plan/import-excel", requireAuth, requireStaff, async (req, res) => {
  try {
    const ldId = String(req.user?.ldId || "").trim();
    if (!ldId) return res.status(400).json({ error: "Missing ldId in token." });

    const year = Number(req.query?.year || 0);
    if (!year || year < 2020 || year > 2100) return res.status(400).json({ error: "Invalid year" });

    const b64 = safeStr(req.body?.contentBase64);
    if (!b64) return res.status(400).json({ error: "Missing contentBase64" });

    const buf = Buffer.from(b64, "base64");

    const wb = XLSX.read(buf, { type: "buffer" });
    const first = wb.SheetNames?.[0];
    if (!first) return res.status(400).json({ error: "XLSX has no sheets" });

    const ws = wb.Sheets[first];

    // matrix (headerless)
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false });

    // Tvoj excel ima headerje v prvih vrsticah.
    // Kolone (po tvojem file-u):
    // 0 divjad, 1 strukturni razred, 2 načrt, 3 izvršeni odstrel, ... , 13 skupaj odvzem, 14 odstotek
    let currentSpecies = "";
    const items = [];

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i] || [];

      const c0 = r[0];
      const c1 = r[1];

      const s0 = safeStr(c0);
      const s1 = safeStr(c1);

      // skip header line "divjad"
      if (s0.toLowerCase() === "divjad") continue;

      // če je v col0 ime divjadi -> set currentSpecies
      // (ignoriramo title/metadata)
      if (
        s0 &&
        s0.toLowerCase() !== "realizacija odvzema" &&
        !s0.toLowerCase().startsWith("datum zadnjega") &&
        !s0.toLowerCase().startsWith("datum zadnje")
      ) {
        currentSpecies = s0;
      }

      const plan = num(r[2]);
      const executedFromExcel = num(r[3]); // samo informativno
      const total = num(r[13]);
      const percentExcel = num(r[14]);

      if (!safeStr(currentSpecies)) continue;

      // če ni class in ni nobene številke -> skip
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
    await admin.firestore().collection("odvzem_plans").doc(id).set(
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
    return res.status(500).json({ error: "Server error", detail: String(e?.stack || e?.message || e) });
  }
});

// GET /ld/odvzem-view?year=2025
// Vrne view (plan rows iz excel + avtomatska realizacija iz hunt_logs.harvestItems)
router.get("/odvzem-view", requireAuth, async (req, res) => {
  try {
    const ldId = String(req.user?.ldId || "").trim();
    if (!ldId) return res.status(400).json({ error: "Missing ldId in token." });

    const year = Number(req.query?.year || 0);
    if (!year || year < 2020 || year > 2100) return res.status(400).json({ error: "Invalid year" });

    // 1) load plan
    const planId = `${ldId}_${year}`;
    const planSnap = await admin.firestore().collection("odvzem_plans").doc(planId).get();

    const plan = planSnap.exists ? planSnap.data() || {} : {};
    const items = Array.isArray(plan.items) ? plan.items : [];

    // 2) compute realizacija from hunt_logs
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

    // 3) build rows like excel
    const rows = items.map((it) => {
      const key = safeStr(it?.key);
      const planCount = Number(it?.plan || 0);
      const executed = Number(byKey[key] || 0);
      const pending = Number(pendingByKey[key] || 0);
      const total = executed; // pending se ne šteje v realizacijo (zaenkrat)
      return {
        key,
        species: safeStr(it?.species),
        classLabel: safeStr(it?.classLabel),
        plan: planCount,
        executed,
        pending,
        total,
        percent: pct(executed, planCount),
      };
    });

    return res.json({
      ok: true,
      view: {
        ldId,
        year,
        title: plan.title || `Realizacija odvzema – ${ldId}, ${year}`,
        updatedAt: plan.updatedAt?.toDate ? plan.updatedAt.toDate().toISOString() : null,
        rows,
      },
    });
  } catch (e) {
    return res.status(500).json({ error: "Server error", detail: String(e?.stack || e?.message || e) });
  }
});

/* ================= HUNT LOGS ================= */

// GET /ld/hunt-logs (member+)
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
        hunterId: x.hunterId || "", // firebase uid (ni “code”)
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

        // ✅ NEW (ko Flutter doda)
        harvestItems: Array.isArray(x.harvestItems) ? x.harvestItems : [],
        pendingItems: Array.isArray(x.pendingItems) ? x.pendingItems : [],
      };
    });

    return res.json({ ok: true, logs });
  } catch (e) {
    return res.status(500).json({ error: "Server error", detail: String(e?.stack || e?.message || e) });
  }
});

module.exports = router;

// ================= IMPORT LD POINTS (staff only) =================

router.post("/points/import-csv", requireAuth, requireStaff, async (req, res) => {
  try {
    const ldId = String(req.user?.ldId || "").trim();
    if (!ldId) return res.status(400).json({ error: "Missing ldId in token." });

    const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
    if (!rows.length) return res.status(400).json({ error: "Missing rows[]" });

    const batch = admin.firestore().batch();
    const col = admin.firestore().collection("ld_points");

    let processed = 0;

    for (const r of rows) {
      const pointId = String(r.pointId || "").trim();
      if (!pointId) continue;

      const ref = col.doc(pointId);

      batch.set(
        ref,
        {
          ldId,
          ldName: r.ldName || "",
          name: r.name || "",
          type: r.type || "",
          lat: Number(r.lat),
          lng: Number(r.lng),
          notes: r.notes || "",
          status: r.status || "active",
          source: r.source || "",
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true } // 👈 KLJUČNO (brez brisanja)
      );

      processed++;
    }

    await batch.commit();

    return res.json({ ok: true, processed });
  } catch (e) {
    return res.status(500).json({ error: "Server error", detail: String(e?.message || e) });
  }
});

