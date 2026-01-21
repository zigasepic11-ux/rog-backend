const express = require("express");
const { admin } = require("../firebase");
const { requireAuth } = require("../auth");

const router = express.Router();

// GET /ld/dashboard
router.get("/dashboard", requireAuth, async (req, res) => {
  try {
    const { ldId } = req.user || {};
    if (!ldId) return res.status(400).json({ error: "Missing ldId in token." });

    // 1) LD info (če imaš kolekcijo 'lds')
    let ldName = ldId;
    try {
      const ldSnap = await admin.firestore().collection("lds").doc(ldId).get();
      if (ldSnap.exists) {
        const ldData = ldSnap.data() || {};
        ldName = ldData.name || ldData.title || ldId;
      }
    } catch (_) {
      // če kolekcije lds še nimaš, ignoriramo
    }

    // 2) št. uporabnikov v LD
    const huntersSnap = await admin
      .firestore()
      .collection("hunters")
      .where("ldId", "==", ldId)
      .get();

    const usersCount = huntersSnap.size;

    // 3) dnevniki v tem mesecu (če kolekcije še nimaš, bo 0)
    let huntsThisMonth = 0;
    try {
      const now = new Date();
      const start = new Date(now.getFullYear(), now.getMonth(), 1);

      // Če boš imel hunt_logs in polje createdAt kot Firestore Timestamp,
      // potem raje shrani Timestamp in tukaj uporabi start (Date).
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

module.exports = router;
