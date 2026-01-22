const express = require("express");
const bcrypt = require("bcrypt");
const { admin } = require("../firebase");
const { requireAuth } = require("../auth");

const router = express.Router();

/* ================= HELPERS ================= */

function isSuper(req) {
  return String(req.user?.code || "") === "999999" ||
         String(req.user?.role || "") === "super";
}

function requireStaff(req, res, next) {
  const role = String(req.user?.role || "member");
  if (role === "admin" || role === "moderator" || isSuper(req)) return next();
  return res.status(403).json({ error: "Forbidden (staff only)" });
}

function genPin4() {
  return String(Math.floor(Math.random() * 10000)).padStart(4, "0");
}

/* ================= DASHBOARD ================= */

router.get("/dashboard", requireAuth, async (req, res) => {
  try {
    const ldId = String(req.user?.ldId || "");
    if (!ldId) return res.status(400).json({ error: "Missing ldId" });

    let ldName = ldId;
    const ldSnap = await admin.firestore().collection("lds").doc(ldId).get();
    if (ldSnap.exists) ldName = ldSnap.data()?.name || ldId;

    const usersSnap = await admin.firestore()
      .collection("hunters")
      .where("ldId", "==", ldId)
      .get();

    const startOfMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
    const logsSnap = await admin.firestore()
      .collection("hunt_logs")
      .where("ldId", "==", ldId)
      .where("createdAt", ">=", admin.firestore.Timestamp.fromDate(startOfMonth))
      .get();

    res.json({
      ok: true,
      ldId,
      ldName,
      usersCount: usersSnap.size,
      huntsThisMonth: logsSnap.size,
      lastSync: new Date().toISOString(),
    });
  } catch (e) {
    res.status(500).json({ error: "Server error", detail: String(e) });
  }
});

/* ================= USERS ================= */

router.get("/users", requireAuth, requireStaff, async (req, res) => {
  const ldId = String(req.user?.ldId || "");
  const snap = await admin.firestore()
    .collection("hunters")
    .where("ldId", "==", ldId)
    .get();

  res.json({
    ok: true,
    users: snap.docs.map(d => ({
      code: d.id,
      ...d.data(),
    })),
  });
});

router.post("/users", requireAuth, requireStaff, async (req, res) => {
  const { code, name, role = "member" } = req.body;
  const ldId = String(req.user?.ldId || "");

  const pin = genPin4();
  const pinHash = await bcrypt.hash(pin, 10);

  await admin.firestore().collection("hunters").doc(code).set({
    name,
    role,
    ldId,
    enabled: true,
    pinHash,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  res.json({ ok: true, code, pin });
});

/* ================= ACTIVE HUNTS (TO JE MANJKALO) ================= */

router.get("/active-hunts", requireAuth, requireStaff, async (req, res) => {
  try {
    const ldId = String(req.user?.ldId || "");
    if (!ldId) return res.status(400).json({ error: "Missing ldId" });

    const snap = await admin.firestore()
      .collection("active_hunts")
      .where("ldId", "==", ldId)
      .orderBy("startedAt", "desc")
      .get();

    const hunts = snap.docs.map(d => {
      const x = d.data();
      return {
        uid: d.id,
        hunterId: x.hunterId,
        hunterCode: x.hunterCode,
        hunterName: x.hunterName,
        ldId: x.ldId,
        locationMode: x.locationMode,
        locationName: x.locationName,
        lat: typeof x.lat === "number" ? x.lat : null,
        lng: typeof x.lng === "number" ? x.lng : null,
        approxLat: typeof x.approxLat === "number" ? x.approxLat : null,
        approxLng: typeof x.approxLng === "number" ? x.approxLng : null,
        approxRadiusM: typeof x.approxRadiusM === "number" ? x.approxRadiusM : null,
        poiName: x.poiName || null,
        poiType: x.poiType || null,
        startedAt: x.startedAt?.toDate
          ? x.startedAt.toDate().toISOString()
          : null,
      };
    });

    res.json({ ok: true, hunts });
  } catch (e) {
    res.status(500).json({ error: "Server error", detail: String(e) });
  }
});

/* ================= HUNT LOGS ================= */

router.get("/hunt-logs", requireAuth, requireStaff, async (req, res) => {
  const ldId = String(req.user?.ldId || "");
  const snap = await admin.firestore()
    .collection("hunt_logs")
    .where("ldId", "==", ldId)
    .orderBy("finishedAt", "desc")
    .limit(500)
    .get();

  res.json({
    ok: true,
    logs: snap.docs.map(d => ({
      id: d.id,
      ...d.data(),
    })),
  });
});

module.exports = router;
