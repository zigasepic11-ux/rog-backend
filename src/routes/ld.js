// src/ld.js
const express = require("express");
const { admin } = require("./firebase");
const { requireAuth } = require("./auth");

const router = express.Router();

// GET /ld/dashboard
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
    return res.status(500).json({
      error: "Server error",
      detail: String(e?.stack || e?.message || e),
    });
  }
});

module.exports = router;