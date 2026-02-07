// src/routes/auth.routes.js
const express = require("express");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcrypt");
const { admin } = require("../firebase");
const { requireAuth } = require("../auth");

const router = express.Router();

function isSuper(user) {
  return String(user?.role || "") === "super";
}

// GET /auth/ping
router.get("/ping", (req, res) => res.json({ ok: true, route: "/auth/ping" }));

// POST /auth/login
// body: { code, pin }
router.post("/login", async (req, res) => {
  try {
    const code = String(req.body?.code || "").trim();
    const pin = String(req.body?.pin || "").trim();

    if (!code || !pin) return res.status(400).json({ error: "Missing code or pin" });

    const ref = admin.firestore().collection("hunters").doc(code);
    const snap = await ref.get();
    if (!snap.exists) return res.status(401).json({ error: "Koda ne obstaja." });

    const data = snap.data() || {};
    if (data.enabled !== true) return res.status(403).json({ error: "Račun je onemogočen." });

    const pinHash = String(data.pinHash || "").trim();
    if (!pinHash) return res.status(500).json({ error: "Missing pinHash on hunter document." });

    const ok = await bcrypt.compare(pin, pinHash);
    if (!ok) return res.status(401).json({ error: "Neveljaven PIN." });

    const name = String(data.name || "Lovec").trim();
    const ldId = String(data.ldId || "").trim();
    const role = String(data.role || "member").trim();

    if (!ldId) return res.status(500).json({ error: "Hunter is missing ldId in Firestore." });
    if (!["member", "moderator", "super"].includes(role)) {
      return res.status(500).json({ error: "Invalid role on hunter document." });
    }

    const secret = process.env.JWT_SECRET;
    if (!secret) return res.status(500).json({ error: "Missing JWT_SECRET in .env" });

    // ✅ JWT za backend API
    const jwtPayload = { role, ldId, name, code };
    const token = jwt.sign(jwtPayload, secret, { expiresIn: "30d" });

    // ✅ Firebase custom token (UID = hunter code)
    const firebaseClaims = { ldId, role, name, hunterCode: code };
    const firebaseToken = await admin.auth().createCustomToken(code, firebaseClaims);

    return res.json({
      ok: true,
      token,          // backend JWT
      firebaseToken,  // Firebase custom token
      user: {
        code,
        name,
        ldId,
        role,
        enabled: true,
      },
    });
  } catch (e) {
    return res.status(500).json({ error: "Server error", detail: String(e?.stack || e?.message || e) });
  }
});

// GET /auth/me
router.get("/me", requireAuth, (req, res) => {
  return res.json({ ok: true, user: { role: req.user.role, ldId: req.user.ldId, name: req.user.name } });
});

// GET /auth/lds (super only)
router.get("/lds", requireAuth, async (req, res) => {
  try {
    if (!isSuper(req.user)) return res.status(403).json({ error: "Forbidden" });

    let lds = [];

    try {
      const snap = await admin.firestore().collection("lds").get();
      lds = snap.docs.map((d) => {
        const x = d.data() || {};
        return { id: d.id, name: x.name || x.title || d.id };
      });
    } catch {
      lds = [];
    }

    if (!lds.length) {
      const hs = await admin.firestore().collection("hunters").get();
      const set = new Set();
      hs.docs.forEach((d) => {
        const ldId = String(d.data()?.ldId || "").trim();
        if (ldId) set.add(ldId);
      });
      lds = Array.from(set).map((id) => ({ id, name: id }));
    }

    lds.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    return res.json({ ok: true, lds });
  } catch (e) {
    return res.status(500).json({ error: "Server error", detail: String(e?.stack || e?.message || e) });
  }
});

// POST /auth/switch-ld (super only)
router.post("/switch-ld", requireAuth, async (req, res) => {
  try {
    if (!isSuper(req.user)) return res.status(403).json({ error: "Forbidden" });

    const ldId = String(req.body?.ldId || "").trim();
    if (!ldId) return res.status(400).json({ error: "Missing ldId" });

    const secret = process.env.JWT_SECRET;
    if (!secret) return res.status(500).json({ error: "Missing JWT_SECRET in .env" });

    const payload = {
      role: "super",
      ldId,
      name: String(req.user?.name || "Admin"),
      code: String(req.user?.code || "super"),
    };

    const token = jwt.sign(payload, secret, { expiresIn: "30d" });

    return res.json({
      ok: true,
      token,
      user: { role: "super", ldId, name: payload.name },
    });
  } catch (e) {
    return res.status(500).json({ error: "Server error", detail: String(e?.stack || e?.message || e) });
  }
});

module.exports = router;
