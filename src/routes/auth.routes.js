const express = require("express");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcrypt");

const { admin } = require("../firebase");
const { requireAuth } = require("../auth");

const router = express.Router();

function isSuper(user) {
  // ✅ trenutno: 999999 je super (dokler nimaš več adminov)
  return String(user?.code || "") === "999999" || String(user?.role || "") === "super";
}

// ✅ sanity ping
router.get("/ping", (req, res) => res.json({ ok: true, route: "/auth/ping" }));

// POST /auth/login
router.post("/login", async (req, res) => {
  try {
    const { code, pin } = req.body || {};
    if (!code || !pin) return res.status(400).json({ error: "Missing code or pin" });

    const hunterCode = String(code).trim();
    const pinInput = String(pin).trim();

    const ref = admin.firestore().collection("hunters").doc(hunterCode);
    const snap = await ref.get();
    if (!snap.exists) return res.status(401).json({ error: "Koda ne obstaja." });

    const data = snap.data() || {};
    if (data.enabled !== true) return res.status(403).json({ error: "Račun je onemogočen." });

    const pinHash = String(data.pinHash || "").trim();
    if (!pinHash) return res.status(500).json({ error: "Missing pinHash on hunter document." });

    const ok = await bcrypt.compare(pinInput, pinHash);
    if (!ok) return res.status(401).json({ error: "Neveljaven PIN." });

    const name = String(data.name || "Lovec");
    const ldId = String(data.ldId || "");
    const role = String(data.role || "member");

    if (!ldId) return res.status(500).json({ error: "Hunter is missing ldId in Firestore." });

    const secret = process.env.JWT_SECRET;
    if (!secret) return res.status(500).json({ error: "Missing JWT_SECRET in .env" });

    const payload = { code: hunterCode, ldId, role, name };
    const token = jwt.sign(payload, secret, { expiresIn: "30d" });

    return res.json({ token, user: payload });
  } catch (e) {
    return res.status(500).json({ error: "Server error", detail: String(e?.stack || e?.message || e) });
  }
});

// GET /auth/me
router.get("/me", requireAuth, (req, res) => res.json({ user: req.user }));

// GET /auth/lds (super only)
router.get("/lds", requireAuth, async (req, res) => {
  try {
    if (!isSuper(req.user)) return res.status(403).json({ error: "Forbidden" });

    let lds = [];

    // 1) collection('lds')
    try {
      const snap = await admin.firestore().collection("lds").get();
      lds = snap.docs.map((d) => {
        const x = d.data() || {};
        return { id: d.id, name: x.name || x.title || d.id };
      });
    } catch {
      lds = [];
    }

    // 2) fallback iz hunters
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

// POST /auth/switch-ld (super only)
router.post("/switch-ld", requireAuth, async (req, res) => {
  try {
    if (!isSuper(req.user)) return res.status(403).json({ error: "Forbidden" });

    const ldId = String(req.body?.ldId || "").trim();
    if (!ldId) return res.status(400).json({ error: "Missing ldId" });

    const secret = process.env.JWT_SECRET;
    if (!secret) return res.status(500).json({ error: "Missing JWT_SECRET in .env" });

    const payload = {
      code: String(req.user.code),
      name: String(req.user.name || "Admin"),
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
