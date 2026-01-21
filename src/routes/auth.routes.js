const express = require("express");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcrypt");

const { admin } = require("../firebase");
const { requireAuth } = require("../auth");

const router = express.Router();

// POST /auth/login
router.post("/login", async (req, res) => {
  try {
    const { code, pin } = req.body || {};
    if (!code || !pin) return res.status(400).json({ error: "Missing code or pin" });

    const ref = admin.firestore().collection("hunters").doc(String(code).trim());
    const snap = await ref.get();

    if (!snap.exists) return res.status(401).json({ error: "Koda ne obstaja." });

    const data = snap.data() || {};
    if (data.enabled !== true) return res.status(403).json({ error: "Račun je onemogočen." });

    const pinInput = String(pin).trim();

    // 1) preferred: bcrypt hash
    const pinHash = (data.pinHash || "").toString().trim();
    if (pinHash) {
      const ok = await bcrypt.compare(pinInput, pinHash);
      if (!ok) return res.status(401).json({ error: "Neveljaven PIN." });
    } else {
      // 2) fallback: plaintext pin
      const storedPin = (data.pin || "").toString().trim();
      if (!storedPin || storedPin !== pinInput) return res.status(401).json({ error: "Neveljaven PIN." });

      // auto-migrate plaintext → pinHash
      const newHash = await bcrypt.hash(pinInput, 10);
      await ref.set({ pinHash: newHash }, { merge: true });
    }

    const name = (data.name || "Lovec").toString();
    const ldId = (data.ldId || "").toString();
    const role = (data.role || "member").toString();

    if (!ldId) return res.status(500).json({ error: "Hunter is missing ldId in Firestore." });

    const secret = process.env.JWT_SECRET;
    if (!secret) return res.status(500).json({ error: "Missing JWT_SECRET in .env" });

    const payload = { code: String(code).trim(), ldId, role, name };
    const token = jwt.sign(payload, secret, { expiresIn: "30d" });

    return res.json({
      token,
      user: { code: payload.code, name, ldId, role },
    });
  } catch (e) {
    return res.status(500).json({ error: "Server error", detail: String(e?.message || e) });
  }
});

// GET /auth/me
router.get("/me", requireAuth, async (req, res) => {
  return res.json({ user: req.user });
});

/* =========================================
   SUPERADMIN (code === "999999") LD SWITCH
   ========================================= */

// GET /auth/lds
// 1) poskusi prebrat kolekcijo 'lds'
// 2) če je prazna/ne obstaja -> fallback: unikaten seznam ldId iz 'hunters'
router.get("/lds", requireAuth, async (req, res) => {
  try {
    if (String(req.user?.code || "") !== "999999") {
      return res.status(403).json({ error: "Forbidden" });
    }

    let lds = [];

    // 1) poskus: collection('lds')
    try {
      const snap = await admin.firestore().collection("lds").get();
      lds = snap.docs.map((d) => {
        const x = d.data() || {};
        return { id: d.id, name: x.name || x.title || d.id };
      });
    } catch {
      lds = [];
    }

    // 2) fallback: zbiranje unikatnih ldId iz 'hunters'
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
    return res.status(500).json({ error: "Server error", detail: String(e?.message || e) });
  }
});

// POST /auth/switch-ld  body:{ ldId }
router.post("/switch-ld", requireAuth, async (req, res) => {
  try {
    if (String(req.user?.code || "") !== "999999") {
      return res.status(403).json({ error: "Forbidden" });
    }

    const ldId = String(req.body?.ldId || "").trim();
    if (!ldId) return res.status(400).json({ error: "Missing ldId" });

    const secret = process.env.JWT_SECRET;
    if (!secret) return res.status(500).json({ error: "Missing JWT_SECRET in .env" });

    const payload = {
      code: String(req.user.code),
      name: String(req.user.name || "Superadmin"),
      role: String(req.user.role || "admin"),
      ldId,
    };

    const token = jwt.sign(payload, secret, { expiresIn: "30d" });

    return res.json({ ok: true, token, user: payload });
  } catch (e) {
    return res.status(500).json({ error: "Server error", detail: String(e?.message || e) });
  }
});

module.exports = router;
