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

    const db = admin.firestore();

    // 1. Najprej poskusi STAR sistem (hunters kolekcija) - nespremenjeno
    // vedenje za obstoječe uporabnike.
    const hunterSnap = await db.collection("hunters").doc(code).get();

    let dbRole, dbLdId, dbName, dbEnabled;

    if (hunterSnap.exists) {
      const data = hunterSnap.data() || {};
      dbEnabled = data.enabled === true;
      dbRole = String(data.role || "member").trim();
      dbLdId = String(data.ldId || "").trim();
      dbName = String(data.name || "Lovec").trim();
    } else {
      // 2. NI najden v starem sistemu - poskusi NOV sistem
      // (memberships + users kolekcija). ldId je že vsebovan v JWT-u
      // (nastavljen ob /auth/login-firebase), ker en uporabnik lahko
      // pripada več LD - preverimo membership za točno to LD.
      const tokenLdId = String(decoded?.ldId || "").trim();
      if (!tokenLdId) {
        return res.status(401).json({ error: "User no longer exists" });
      }

      const membershipSnap = await db
        .collection("memberships")
        .doc(`${code}_${tokenLdId}`)
        .get();

      if (!membershipSnap.exists) {
        return res.status(401).json({ error: "User no longer exists" });
      }

      const membership = membershipSnap.data() || {};
      dbEnabled = membership.status === "active";
      dbRole = String(membership.role || "member").trim();
      dbLdId = String(membership.ldId || "").trim();

      const userSnap = await db.collection("users").doc(code).get();
      dbName = userSnap.exists
        ? String(userSnap.data().name || "Lovec").trim()
        : "Lovec";
    }

    if (!dbEnabled) {
      return res.status(403).json({ error: "Account disabled" });
    }
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