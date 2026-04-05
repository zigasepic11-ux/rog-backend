const express = require("express");
const { admin } = require("../firebase");
const { requireAuth } = require("../auth");

const router = express.Router();

function safeStr(v) {
  return (v == null ? "" : String(v)).trim();
}

router.post("/register-token", requireAuth, async (req, res) => {
  try {
    const token = safeStr(req.body?.token);
    const hunterId = safeStr(req.body?.hunterId) || safeStr(req.user?.code);
    const ldId = safeStr(req.body?.ldId) || safeStr(req.user?.ldId);
    const platform = safeStr(req.body?.platform) || "android";

    if (!token) return res.status(400).json({ error: "Missing token" });
    if (!hunterId) return res.status(400).json({ error: "Missing hunterId" });
    if (!ldId) return res.status(400).json({ error: "Missing ldId" });

    const docId = Buffer.from(token).toString("base64url");

    await admin.firestore().collection("fcm_tokens").doc(docId).set(
      {
        token,
        hunterId,
        ldId,
        platform,
        enabled: true,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({
      error: "Server error",
      detail: String(e?.stack || e?.message || e),
    });
  }
});

router.post("/unregister-token", requireAuth, async (req, res) => {
  try {
    const token = safeStr(req.body?.token);
    if (!token) return res.status(400).json({ error: "Missing token" });

    const docId = Buffer.from(token).toString("base64url");

    await admin.firestore().collection("fcm_tokens").doc(docId).set(
      {
        enabled: false,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({
      error: "Server error",
      detail: String(e?.stack || e?.message || e),
    });
  }
});

module.exports = router;