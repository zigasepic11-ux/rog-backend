// src/auth.js
const jwt = require("jsonwebtoken");
const { admin } = require("./firebase");

function isAllowedRole(role) {
  return ["member", "moderator", "admin", "super"].includes(String(role || "").trim());
}

function isGlobalRole(role) {
  const r = String(role || "").trim();
  return r === "super" || r === "admin";
}

async function requireAuth(req, res, next) {
  try {
    const h = req.headers.authorization || "";
    const [type, token] = h.split(" ");

    if (type !== "Bearer" || !token) {
      return res.status(401).json({ error: "Missing Bearer token" });
    }

    const secret = process.env.JWT_SECRET;
    if (!secret) {
      return res.status(500).json({ error: "Missing JWT_SECRET in .env" });
    }

    const decoded = jwt.verify(token, secret);

    const code = String(decoded?.code || decoded?.uid || "").trim();
    if (!code) {
      return res.status(401).json({ error: "Invalid token payload" });
    }

    const snap = await admin.firestore().collection("hunters").doc(code).get();
    if (!snap.exists) {
      return res.status(401).json({ error: "User no longer exists" });
    }

    const data = snap.data() || {};
    if (data.enabled !== true) {
      return res.status(403).json({ error: "Account disabled" });
    }

    const dbRole = String(data.role || "member").trim();
    const dbLdId = String(data.ldId || "").trim();
    const dbName = String(data.name || "Lovec").trim();

    if (!isAllowedRole(dbRole)) {
      return res.status(403).json({ error: "Invalid account role" });
    }

    if (!dbLdId && !isGlobalRole(dbRole)) {
      return res.status(403).json({ error: "Account missing ldId" });
    }

    // super/admin lahko uporabljata ldId iz switch-ld tokena,
    // ostali vedno iz baze
    const effectiveLdId = isGlobalRole(dbRole)
      ? String(decoded?.ldId || dbLdId || "").trim()
      : dbLdId;

    req.user = {
      uid: code,
      code,
      name: dbName,
      role: dbRole,
      ldId: effectiveLdId,
      tokenIat: decoded?.iat || null,
      tokenExp: decoded?.exp || null,
    };

    return next();
  } catch (e) {
    return res.status(401).json({ error: "Invalid token" });
  }
}

module.exports = { requireAuth };