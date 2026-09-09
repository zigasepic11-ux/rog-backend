// src/routes/auth.routes.js
const express = require("express");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcrypt");
const { admin } = require("../firebase");
const { requireAuth } = require("../auth");

const router = express.Router();

function isSuper(user) {
  const r = String(user?.role || "").trim();
  return r === "super" || r === "admin";
}

function validRole(role) {
  return ["member", "moderator", "admin", "super"].includes(String(role || "").trim());
}

// GET /auth/ping
router.get("/ping", (req, res) => res.json({ ok: true, route: "/auth/ping" }));

// POST /auth/login
// body: { code, pin }
router.post("/login", async (req, res) => {
  try {
    const code = String(req.body?.code || "").trim();
    const pin = String(req.body?.pin || "").trim();

    if (!code || !pin) {
      return res.status(400).json({ error: "Missing code or pin" });
    }

    const ref = admin.firestore().collection("hunters").doc(code);
    const snap = await ref.get();
    if (!snap.exists) {
      return res.status(401).json({ error: "Koda ne obstaja." });
    }

    const data = snap.data() || {};
    if (data.enabled !== true) {
      return res.status(403).json({ error: "Račun je onemogočen." });
    }

    const pinHash = String(data.pinHash || "").trim();
    if (!pinHash) {
      return res.status(500).json({ error: "Missing pinHash on hunter document." });
    }

    const ok = await bcrypt.compare(pin, pinHash);
    if (!ok) {
      return res.status(401).json({ error: "Neveljaven PIN." });
    }

    const name = String(data.name || "Lovec").trim();
    const ldId = String(data.ldId || "").trim();
    const role = String(data.role || "member").trim();

    if (!validRole(role)) {
      return res.status(500).json({ error: "Invalid role on hunter document." });
    }
    if (!ldId && role !== "super" && role !== "admin") {
      return res.status(500).json({ error: "Hunter is missing ldId in Firestore." });
    }

    const secret = process.env.JWT_SECRET;
    if (!secret) {
      return res.status(500).json({ error: "Missing JWT_SECRET in .env" });
    }

    // Backend JWT
    const jwtPayload = {
      uid: code,
      code,
      role,
      ldId,
      name,
    };
    const token = jwt.sign(jwtPayload, secret, { expiresIn: "30d" });

    // Firebase custom token (UID = hunter code)
    const firebaseClaims = { ldId, role, name, hunterCode: code };
    const firebaseToken = await admin.auth().createCustomToken(code, firebaseClaims);

    return res.json({
      ok: true,
      token,
      firebaseToken,
      user: {
        code,
        name,
        ldId,
        role,
        enabled: true,
      },
    });
   } catch (e) {
    console.error("========== LOGIN ERROR ==========");
    console.error(e);
    console.error("message:", e?.message);
    console.error("code:", e?.code);
    console.error("details:", e?.details);
    console.error("stack:", e?.stack);

    return res.status(500).json({
      error: "Server error",
      detail: e?.message || String(e),
      code: e?.code || null,
      details: e?.details || null,
    });
  }
});

// GET /auth/me
router.get("/me", requireAuth, (req, res) => {
  return res.json({
    ok: true,
    user: {
      code: req.user.code,
      role: req.user.role,
      ldId: req.user.ldId,
      name: req.user.name,
    },
  });
});

// GET /auth/lds (super/admin only)
router.get("/lds", requireAuth, async (req, res) => {
  try {
    if (!isSuper(req.user)) {
      return res.status(403).json({ error: "Forbidden" });
    }

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

    lds.sort((a, b) => String(a.name).localeCompare(String(b.name), "sl"));
    return res.json({ ok: true, lds });
  } catch (e) {
    return res.status(500).json({
      error: "Server error",
      detail: String(e?.stack || e?.message || e),
    });
  }
});

// POST /auth/switch-ld (super/admin only)
router.post("/switch-ld", requireAuth, async (req, res) => {
  try {
    if (!isSuper(req.user)) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const ldId = String(req.body?.ldId || "").trim();
    if (!ldId) {
      return res.status(400).json({ error: "Missing ldId" });
    }

    const secret = process.env.JWT_SECRET;
    if (!secret) {
      return res.status(500).json({ error: "Missing JWT_SECRET in .env" });
    }

    const payload = {
      uid: String(req.user?.uid || req.user?.code || "super"),
      code: String(req.user?.code || req.user?.uid || "super"),
      role: String(req.user?.role || "super"),
      ldId,
      name: String(req.user?.name || "Admin"),
    };

    const token = jwt.sign(payload, secret, { expiresIn: "30d" });

    return res.json({
      ok: true,
      token,
      user: {
        code: payload.code,
        role: payload.role,
        ldId,
        name: payload.name,
      },
    });
  } catch (e) {
    return res.status(500).json({
      error: "Server error",
      detail: String(e?.stack || e?.message || e),
    });
  }
});
// POST /auth/login-firebase
// body: { idToken, ldId? }
// Sprejme Firebase Auth ID token (od email+PIN prijave preko novega
// invite/reset sistema), poišče aktiven membership, in izda STARI
// JWT format - tako da Portal.jsx in vse ostale strani delujejo nespremenjene.
router.post("/login-firebase", async (req, res) => {
  try {
    const idToken = String(req.body?.idToken || "").trim();
    if (!idToken) {
      return res.status(400).json({ error: "Missing idToken" });
    }

    let decoded;
    try {
      decoded = await admin.auth().verifyIdToken(idToken);
    } catch (e) {
      return res.status(401).json({ error: "Neveljaven ali potekel token." });
    }

    const uid = decoded.uid;

    const userDoc = await admin.firestore().collection("users").doc(uid).get();
    if (!userDoc.exists) {
      return res.status(404).json({ error: "Uporabniški profil ne obstaja." });
    }
    const userData = userDoc.data() || {};
    const name = String(userData.name || "Lovec").trim();

    // Poišči aktivne memberships za tega uporabnika
    const membershipsSnap = await admin
      .firestore()
      .collection("memberships")
      .where("uid", "==", uid)
      .where("status", "==", "active")
      .get();

    if (membershipsSnap.empty) {
      return res.status(403).json({ error: "Ni aktivnih članstev za ta račun." });
    }

    const memberships = membershipsSnap.docs.map((d) => d.data());

    // Če ima uporabnik samo eno aktivno LD, prijavi ga direktno vanjo
    let selected;
    const requestedLdId = String(req.body?.ldId || "").trim();

    if (requestedLdId) {
      selected = memberships.find((m) => m.ldId === requestedLdId);
      if (!selected) {
        return res.status(403).json({ error: "Nimate dostopa do te lovske družine." });
      }
    } else if (memberships.length === 1) {
      selected = memberships[0];
    } else {
      // Več LD-jev - vrni seznam, naj uporabnik izbere (podobno kot switch-ld)
      return res.json({
        ok: true,
        needsLdSelection: true,
        lds: memberships.map((m) => ({ ldId: m.ldId, role: m.role })),
      });
    }

    const role = String(selected.role || "member").trim();
    const ldId = String(selected.ldId || "").trim();

    if (!validRole(role)) {
      return res.status(500).json({ error: "Invalid role on membership document." });
    }

    const secret = process.env.JWT_SECRET;
    if (!secret) {
      return res.status(500).json({ error: "Missing JWT_SECRET in .env" });
    }

    // Isti JWT format kot stari /auth/login, da Portal.jsx deluje nespremenjeno
    const jwtPayload = {
      uid,
      code: uid,
      role,
      ldId,
      name,
    };
    const token = jwt.sign(jwtPayload, secret, { expiresIn: "30d" });

    const firebaseClaims = { ldId, role, name };
    const firebaseToken = await admin.auth().createCustomToken(uid, firebaseClaims);

    return res.json({
      ok: true,
      token,
      firebaseToken,
      user: { code: uid, name, ldId, role, enabled: true },
    });
  } catch (e) {
    console.error("========== LOGIN-FIREBASE ERROR ==========");
    console.error(e);
    return res.status(500).json({
      error: "Server error",
      detail: e?.message || String(e),
    });
  }
});
module.exports = router;