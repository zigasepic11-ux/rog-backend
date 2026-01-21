const express = require("express");
const bcrypt = require("bcrypt");
const { admin } = require("../firebase");
const { requireAuth } = require("../auth");

const router = express.Router();

function requireStaff(req, res, next) {
  const role = String(req.user?.role || "member");
  if (role === "admin" || role === "moderator") return next();
  return res.status(403).json({ error: "Forbidden (staff only)" });
}

function genPin4() {
  // 4-mestni PIN, tudi z ničlami (0000–9999)
  return String(Math.floor(Math.random() * 10000)).padStart(4, "0");
}

/**
 * GET /ld/dashboard
 */
router.get("/dashboard", requireAuth, async (req, res) => {
  try {
    const { ldId } = req.user || {};
    if (!ldId) return res.status(400).json({ error: "Missing ldId in token." });

    let ldName = ldId;
    try {
      const ldSnap = await admin.firestore().collection("lds").doc(ldId).get();
      if (ldSnap.exists) {
        const ldData = ldSnap.data() || {};
        ldName = ldData.name || ldData.title || ldId;
      }
    } catch (_) {}

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

      const logsSnap = await admin
        .firestore()
        .collection("hunt_logs")
        .where("ldId", "==", ldId)
        .where("createdAt", ">=", start.toISOString())
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
    return res.status(500).json({ error: "Server error", detail: String(e?.message || e) });
  }
});

/**
 * GET /ld/users
 * Vrne vse hunters za ldId iz tokena
 */
router.get("/users", requireAuth, requireStaff, async (req, res) => {
  try {
    const ldId = String(req.user?.ldId || "");
    if (!ldId) return res.status(400).json({ error: "Missing ldId in token." });

    const snap = await admin
      .firestore()
      .collection("hunters")
      .where("ldId", "==", ldId)
      .get();

    const users = snap.docs.map((d) => {
      const x = d.data() || {};
      return {
        code: d.id,
        name: x.name || "",
        role: x.role || "member",
        enabled: x.enabled === true,
        createdAt: x.createdAt || null,
      };
    });

    users.sort((a, b) => String(a.name).localeCompare(String(b.name)));

    return res.json({ ok: true, users });
  } catch (e) {
    return res.status(500).json({ error: "Server error", detail: String(e?.message || e) });
  }
});

/**
 * POST /ld/users
 * body: { code, name, role }
 * Ustvari hunterja v isti LD. Ustvari pinHash. Vrne začetni PIN (samo enkrat).
 */
router.post("/users", requireAuth, requireStaff, async (req, res) => {
  try {
    const ldId = String(req.user?.ldId || "");
    if (!ldId) return res.status(400).json({ error: "Missing ldId in token." });

    const code = String(req.body?.code || "").trim();
    const name = String(req.body?.name || "").trim();
    const role = String(req.body?.role || "member").trim();

    if (!code) return res.status(400).json({ error: "Missing code" });
    if (!name) return res.status(400).json({ error: "Missing name" });

    if (!["member", "moderator", "admin"].includes(role)) {
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
      pin: admin.firestore.FieldValue.delete(), // če obstaja star plaintext pin, ga pobrišemo
      createdAt: new Date().toISOString(),
    });

    return res.json({
      ok: true,
      user: { code, name, role, enabled: true, ldId },
      pin, // pokažeš adminu, potem ga posreduje uporabniku
    });
  } catch (e) {
    return res.status(500).json({ error: "Server error", detail: String(e?.message || e) });
  }
});

/**
 * PATCH /ld/users/:code/enabled
 * body: { enabled: true/false }
 */
router.patch("/users/:code/enabled", requireAuth, requireStaff, async (req, res) => {
  try {
    const ldId = String(req.user?.ldId || "");
    const code = String(req.params.code || "").trim();
    const enabled = !!req.body?.enabled;

    if (!ldId) return res.status(400).json({ error: "Missing ldId in token." });
    if (!code) return res.status(400).json({ error: "Missing code" });

    const ref = admin.firestore().collection("hunters").doc(code);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ error: "User not found" });

    const data = snap.data() || {};
    if (String(data.ldId || "") !== ldId) return res.status(403).json({ error: "Forbidden (other LD)" });

    await ref.set({ enabled }, { merge: true });

    return res.json({ ok: true, code, enabled });
  } catch (e) {
    return res.status(500).json({ error: "Server error", detail: String(e?.message || e) });
  }
});

/**
 * POST /ld/users/:code/reset-pin
 * Generira nov PIN, shrani pinHash, vrne PIN (samo adminu)
 */
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
    if (String(data.ldId || "") !== ldId) return res.status(403).json({ error: "Forbidden (other LD)" });

    const newPin = genPin4();
    const newHash = await bcrypt.hash(newPin, 10);

    await ref.set(
      {
        pinHash: newHash,
        pin: admin.firestore.FieldValue.delete(),
      },
      { merge: true }
    );

    return res.json({ ok: true, code, pin: newPin });
  } catch (e) {
    return res.status(500).json({ error: "Server error", detail: String(e?.message || e) });
  }
});

module.exports = router;
