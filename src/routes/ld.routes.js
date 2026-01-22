// src/routes/ld.routes.js
const express = require("express");
const bcrypt = require("bcrypt");
const { admin } = require("../firebase");
const { requireAuth } = require("../auth");

const router = express.Router();

/* ================= HELPERS ================= */

function isSuper(req) {
  return String(req.user?.code || "") === "999999" || String(req.user?.role || "") === "super";
}

function requireStaff(req, res, next) {
  const role = String(req.user?.role || "member");
  if (role === "admin" || role === "moderator" || isSuper(req)) return next();
  return res.status(403).json({ error: "Forbidden (staff only)" });
}

function genPin4() {
  return String(Math.floor(Math.random() * 10000)).padStart(4, "0");
}

function toIsoMaybe(ts) {
  if (!ts) return null;
  if (ts?.toDate) return ts.toDate().toISOString();
  return null;
}

function numOrNull(v) {
  return typeof v === "number" ? v : null;
}

function tsFromDate(d) {
  return admin.firestore.Timestamp.fromDate(d);
}

function parseDateOrNull(v) {
  if (!v) return null;
  const d = new Date(String(v));
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

/* ================= DASHBOARD ================= */
/**
 * GET /ld/dashboard
 * ✅ NEVER crash portal: če Firestore query faila, vrne fallback.
 */
router.get("/dashboard", requireAuth, async (req, res) => {
  const ldId = String(req.user?.ldId || "");
  if (!ldId) return res.status(400).json({ error: "Missing ldId in token." });

  // Fallback values (da portal nikoli ne pade)
  let ldName = ldId;
  let usersCount = 0;
  let huntsThisMonth = 0;

  // 1) LD name
  try {
    const ldSnap = await admin.firestore().collection("lds").doc(ldId).get();
    if (ldSnap.exists) {
      const ldData = ldSnap.data() || {};
      ldName = ldData.name || ldData.title || ldId;
    }
  } catch (_) {
    // ignore
  }

  // 2) usersCount
  try {
    const huntersSnap = await admin.firestore().collection("hunters").where("ldId", "==", ldId).get();
    usersCount = huntersSnap.size;
  } catch (_) {
    usersCount = 0;
  }

  // 3) huntsThisMonth (lahko faila zaradi indexa / tipa createdAt)
  try {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    const startTs = tsFromDate(start);

    const logsSnap = await admin
      .firestore()
      .collection("hunt_logs")
      .where("ldId", "==", ldId)
      .where("createdAt", ">=", startTs)
      .get();

    huntsThisMonth = logsSnap.size;
  } catch (e) {
    // ✅ namesto 500 raje vrnemo 0 + optional debug
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
});

/* ================= USERS ================= */

router.get("/users", requireAuth, requireStaff, async (req, res) => {
  try {
    const ldId = String(req.user?.ldId || "");
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
          createdAt: toIsoMaybe(x.createdAt) || x.createdAt || null,
          updatedAt: toIsoMaybe(x.updatedAt) || x.updatedAt || null,
        };
      })
      .sort((a, b) => String(a.name).localeCompare(String(b.name)));

    return res.json({ ok: true, users });
  } catch (e) {
    return res.status(500).json({ error: "Server error", detail: String(e?.message || e) });
  }
});

router.post("/users", requireAuth, requireStaff, async (req, res) => {
  try {
    const ldId = String(req.user?.ldId || "");
    if (!ldId) return res.status(400).json({ error: "Missing ldId in token." });

    const code = String(req.body?.code || "").trim();
    const name = String(req.body?.name || "").trim();
    const role = String(req.body?.role || "member").trim();

    if (!code) return res.status(400).json({ error: "Missing code" });
    if (!name) return res.status(400).json({ error: "Missing name" });
    if (!["member", "moderator", "admin", "super"].includes(role)) {
      return res.status(400).json({ error: "Invalid role" });
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
      pin: admin.firestore.FieldValue.delete(),
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return res.json({ ok: true, user: { code, name, role, enabled: true, ldId }, pin });
  } catch (e) {
    return res.status(500).json({ error: "Server error", detail: String(e?.message || e) });
  }
});

router.patch("/users/:code", requireAuth, requireStaff, async (req, res) => {
  try {
    const ldId = String(req.user?.ldId || "");
    const code = String(req.params.code || "").trim();
    if (!ldId) return res.status(400).json({ error: "Missing ldId in token." });
    if (!code) return res.status(400).json({ error: "Missing code" });

    const ref = admin.firestore().collection("hunters").doc(code);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ error: "User not found" });

    const data = snap.data() || {};
    if (!isSuper(req) && String(data.ldId || "") !== ldId) {
      return res.status(403).json({ error: "Forbidden (other LD)" });
    }

    const patch = {};

    if (typeof req.body?.enabled === "boolean") patch.enabled = req.body.enabled;
    if (req.body?.name != null) patch.name = String(req.body.name).trim();
    if (req.body?.role != null) {
      const r = String(req.body.role).trim();
      if (!["member", "moderator", "admin", "super"].includes(r)) {
        return res.status(400).json({ error: "Invalid role" });
      }
      patch.role = r;
    }

    patch.updatedAt = admin.firestore.FieldValue.serverTimestamp();
    await ref.set(patch, { merge: true });

    return res.json({ ok: true, code, patch });
  } catch (e) {
    return res.status(500).json({ error: "Server error", detail: String(e?.message || e) });
  }
});

router.post("/users/:code/reset-pin", requireAuth, requireStaff, async (req, res) => {
  try {
    const ldId = String(req.user?.ldId || "");
    const code = String(req.params.code || "").trim();

    if (!ldId) return res.status(400).json({ error: "Missing ldId in token." });
    if (!code) return res.status(400).json({ error: "Missing code" });

    const ref = admin.firestore().collection("hunters").doc(code);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ error: "User not found" });

    const data = snap.data() || {};
    if (!isSuper(req) && String(data.ldId || "") !== ldId) {
      return res.status(403).json({ error: "Forbidden (other LD)" });
    }

    const newPin = genPin4();
    const newHash = await bcrypt.hash(newPin, 10);

    await ref.set(
      {
        pinHash: newHash,
        pin: admin.firestore.FieldValue.delete(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        lastPinResetAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    return res.json({ ok: true, code, pin: newPin });
  } catch (e) {
    return res.status(500).json({ error: "Server error", detail: String(e?.message || e) });
  }
});

/* ================= ACTIVE HUNTS ================= */
/**
 * GET /ld/active-hunts
 * Vrne: { ok:true, active:[...] }
 */
router.get("/active-hunts", requireAuth, requireStaff, async (req, res) => {
  try {
    const ldId = String(req.user?.ldId || "");
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
        hunterCode: x.hunterCode || null,
        hunterName: x.hunterName || null,
        ldId: x.ldId || null,

        locationMode: x.locationMode || "private_text",
        locationName: x.locationName || "",

        // poi exact
        lat: numOrNull(x.lat),
        lng: numOrNull(x.lng),
        poiName: x.poiName || null,
        poiType: x.poiType || null,

        // approx
        approxLat: numOrNull(x.approxLat),
        approxLng: numOrNull(x.approxLng),
        approxRadiusM: typeof x.approxRadiusM === "number" ? x.approxRadiusM : null,

        startedAt: toIsoMaybe(x.startedAt),
      };
    });

    return res.json({ ok: true, active });
  } catch (e) {
    return res.status(500).json({ error: "Server error", detail: String(e?.message || e) });
  }
});

/* ================= HUNT LOGS ================= */
/**
 * GET /ld/hunt-logs?from=...&to=...&limit=...
 */
router.get("/hunt-logs", requireAuth, requireStaff, async (req, res) => {
  try {
    const ldId = String(req.user?.ldId || "");
    if (!ldId) return res.status(400).json({ error: "Missing ldId in token." });

    const limit = Math.min(Number(req.query?.limit || 500), 2000);

    const from = parseDateOrNull(req.query?.from);
    const to = parseDateOrNull(req.query?.to);

    if (req.query?.from && !from) return res.status(400).json({ error: "Invalid 'from' date" });
    if (req.query?.to && !to) return res.status(400).json({ error: "Invalid 'to' date" });

    let q = admin.firestore().collection("hunt_logs").where("ldId", "==", ldId);
    if (from) q = q.where("finishedAt", ">=", tsFromDate(from));
    if (to) q = q.where("finishedAt", "<=", tsFromDate(to));
    q = q.orderBy("finishedAt", "desc").limit(limit);

    const snap = await q.get();

    const logs = snap.docs.map((d) => {
      const x = d.data() || {};
      return {
        id: d.id,
        hunterName: x.hunterName || "",
        hunterCode: x.hunterCode || "",
        hunterId: x.hunterId || "",
        ldId: x.ldId || "",

        startedAt: toIsoMaybe(x.startedAt),
        finishedAt: toIsoMaybe(x.finishedAt),

        harvest: !!x.harvest,
        species: x.species || "",
        notes: x.notes || "",
        endedReason: x.endedReason || "",

        locationName: x.locationName || "",
        lat: numOrNull(x.lat),
        lng: numOrNull(x.lng),

        createdAt: toIsoMaybe(x.createdAt),
      };
    });

    return res.json({ ok: true, logs });
  } catch (e) {
    return res.status(500).json({ error: "Server error", detail: String(e?.message || e) });
  }
});

module.exports = router;
