const express = require("express");
const { admin } = require("../firebase");
const { requireAuth } = require("../auth");
const { sendToLd } = require("../services/push.service");

const router = express.Router();

function safeStr(v) {
  return (v == null ? "" : String(v)).trim();
}

function numOrNull(v) {
  if (v == null || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const n = Number(String(v).trim().replace(",", "."));
  return Number.isFinite(n) ? n : null;
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

router.post("/hunt-started", requireAuth, async (req, res) => {
  try {
    const firebaseUid = safeStr(req.body?.firebaseUid);
    const hunterName = safeStr(req.body?.hunterName) || safeStr(req.user?.name) || "Lovec";
    const ldId = safeStr(req.body?.ldId) || safeStr(req.user?.ldId);
    const locationName = safeStr(req.body?.locationName);
    const locationMode = safeStr(req.body?.locationMode) || "private_text";

    const poiName = safeStr(req.body?.poiName);
    const poiType = safeStr(req.body?.poiType);
    const lat = numOrNull(req.body?.lat);
    const lng = numOrNull(req.body?.lng);

    const approxLat = numOrNull(req.body?.approxLat);
    const approxLng = numOrNull(req.body?.approxLng);
    const approxRadiusM = numOrNull(req.body?.approxRadiusM);

    if (!firebaseUid) return res.status(400).json({ error: "Missing firebaseUid" });
    if (!ldId) return res.status(400).json({ error: "Missing ldId" });
    if (!locationName) return res.status(400).json({ error: "Missing locationName" });

    const data = {
      hunterId: firebaseUid,
      hunterName,
      ldId,
      locationName,
      locationMode,
      startedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    if (locationMode === "poi") {
      data.poiName = poiName || "";
      data.poiType = poiType || "";
      data.lat = lat;
      data.lng = lng;
      data.approxLat = admin.firestore.FieldValue.delete();
      data.approxLng = admin.firestore.FieldValue.delete();
      data.approxRadiusM = admin.firestore.FieldValue.delete();
    } else if (locationMode === "approx") {
      data.approxLat = approxLat;
      data.approxLng = approxLng;
      data.approxRadiusM = approxRadiusM ?? 1000.0;
      data.lat = admin.firestore.FieldValue.delete();
      data.lng = admin.firestore.FieldValue.delete();
      data.poiName = admin.firestore.FieldValue.delete();
      data.poiType = admin.firestore.FieldValue.delete();
    } else {
      data.lat = admin.firestore.FieldValue.delete();
      data.lng = admin.firestore.FieldValue.delete();
      data.poiName = admin.firestore.FieldValue.delete();
      data.poiType = admin.firestore.FieldValue.delete();
      data.approxLat = admin.firestore.FieldValue.delete();
      data.approxLng = admin.firestore.FieldValue.delete();
      data.approxRadiusM = admin.firestore.FieldValue.delete();
    }

    await admin.firestore().collection("active_hunts").doc(firebaseUid).set(data, { merge: true });

    try {
      await sendToLd({
        ldId,
        title: "Začetek lova",
        body: `${hunterName} je začel lov${locationName ? " – " + locationName : ""}`,
        data: {
          type: "hunt_started",
          ldId,
          firebaseUid,
          hunterName,
          locationName,
        },
      });
    } catch (pushError) {
      console.error("hunt_started push failed:", pushError);
    }

    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({
      error: "Server error",
      detail: String(e?.stack || e?.message || e),
    });
  }
});

module.exports = router;