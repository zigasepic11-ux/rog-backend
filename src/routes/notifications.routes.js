const express = require("express");
const { admin } = require("../firebase");
const { requireAuth } = require("../auth");
const { sendToLd } = require("../services/push.service");

const router = express.Router();

const REMINDER_AFTER_MS = 6 * 60 * 60 * 1000; // 6h
const MODERATOR_ALERT_AFTER_MS = 15 * 60 * 1000; // 15 min
const AUTO_END_AFTER_MS = 60 * 60 * 1000; // 60 min od opomnika

function safeStr(v) {
  return v == null ? "" : String(v).trim();
}

function numOrNull(v) {
  if (v == null || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;

  const n = Number(String(v).trim().replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

function tsToDate(v) {
  if (!v) return null;
  if (typeof v.toDate === "function") return v.toDate();
  if (v instanceof Date) return v;

  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function dayKey(d) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function toBool(v) {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    return s === "true" || s === "1" || s === "yes";
  }
  if (typeof v === "number") return v !== 0;
  return false;
}

function sanitizeHarvestItems(items) {
  if (!Array.isArray(items)) return [];

  return items
    .map((x) => {
      const key = safeStr(x?.key);
      const species = safeStr(x?.species);
      const classLabel = safeStr(x?.classLabel);
      const count = Number.isFinite(Number(x?.count)) ? Number(x.count) : 0;

      if (!key || !species || !classLabel || count <= 0) return null;

      return {
        key,
        species,
        classLabel,
        count,
      };
    })
    .filter(Boolean);
}

function sanitizePendingItems(items) {
  if (!Array.isArray(items)) return [];

  return items
    .map((x) => {
      const key = safeStr(x?.key) || "PENDING_OTHER";
      const label = safeStr(x?.label);
      const count = Number.isFinite(Number(x?.count)) ? Number(x.count) : 0;

      if (!label || count <= 0) return null;

      return {
        key,
        label,
        count,
      };
    })
    .filter(Boolean);
}

async function sendToUserTokens({ title, body, data, tokens }) {
  const cleanTokens = (tokens || []).filter(Boolean);
  if (!cleanTokens.length) {
    return { ok: true, sent: 0, failed: 0 };
  }

  const msg = {
    notification: { title, body },
    data: Object.fromEntries(
      Object.entries(data || {}).map(([k, v]) => [k, v == null ? "" : String(v)])
    ),
    tokens: cleanTokens,
  };

  const resp = await admin.messaging().sendEachForMulticast(msg);

  return {
    ok: true,
    sent: resp.successCount,
    failed: resp.failureCount,
  };
}

async function getEnabledTokensForFirebaseUid(firebaseUid) {
  const snap = await admin
    .firestore()
    .collection("fcm_tokens")
    .where("enabled", "==", true)
    .where("firebaseUid", "==", firebaseUid)
    .get();

  const tokens = [];
  for (const d of snap.docs) {
    const x = d.data() || {};
    const token = safeStr(x.token);
    if (token) tokens.push(token);
  }

  return tokens;
}

async function getModeratorTokensForLd(ldId) {
  const usersSnap = await admin
    .firestore()
    .collection("users")
    .where("ldId", "==", ldId)
    .where("enabled", "==", true)
    .get();

  const moderatorUids = new Set();

  for (const d of usersSnap.docs) {
    const u = d.data() || {};
    const role = safeStr(u.role);
    if (role === "moderator" || role === "super") {
      moderatorUids.add(d.id);
    }
  }

  if (!moderatorUids.size) return [];

  const tokenSnap = await admin
    .firestore()
    .collection("fcm_tokens")
    .where("enabled", "==", true)
    .where("ldId", "==", ldId)
    .get();

  const tokens = [];
  for (const d of tokenSnap.docs) {
    const x = d.data() || {};
    const firebaseUid = safeStr(x.firebaseUid);
    const token = safeStr(x.token);

    if (moderatorUids.has(firebaseUid) && token) {
      tokens.push(token);
    }
  }

  return tokens;
}

async function addFinishedLogFromActiveHunt({
  firebaseUid,
  data,
  finishedAt,
  endedReason,
  notes,
  harvest,
  species,
  harvestItems,
  pendingItems,
}) {
  const startedAt = tsToDate(data.startedAt) || finishedAt;
  const locationMode = safeStr(data.locationMode) || "private_text";

  const cleanHarvestItems = sanitizeHarvestItems(harvestItems);
  const cleanPendingItems = sanitizePendingItems(pendingItems);
  const cleanHarvest = toBool(harvest);
  const cleanSpecies = safeStr(species);
  const cleanNotes = safeStr(notes);
  const safeEndedReason = safeStr(endedReason);

  const logData = {
    hunterId: firebaseUid,
    hunterName: safeStr(data.hunterName) || "Lovec",
    ldId: safeStr(data.ldId).toLowerCase(),
    year: finishedAt.getFullYear(),

    locationName: safeStr(data.locationName),
    locationMode,

    startedAt: admin.firestore.Timestamp.fromDate(startedAt),
    finishedAt: admin.firestore.Timestamp.fromDate(finishedAt),

    harvest: cleanHarvest,
    species: cleanSpecies,
    notes: cleanNotes,
    endedReason: safeEndedReason,

    dayKey: dayKey(finishedAt),
    createdAt: admin.firestore.FieldValue.serverTimestamp(),

    harvestItems: cleanHarvest ? cleanHarvestItems : [],
    pendingItems: cleanHarvest ? cleanPendingItems : [],
  };

  if (locationMode === "poi") {
    logData.lat = numOrNull(data.lat);
    logData.lng = numOrNull(data.lng);
    logData.poiName = safeStr(data.poiName);
    logData.poiType = safeStr(data.poiType);
  } else if (locationMode === "approx") {
    logData.approxLat = numOrNull(data.approxLat);
    logData.approxLng = numOrNull(data.approxLng);
    logData.approxRadiusM = numOrNull(data.approxRadiusM) ?? 1000.0;
  }

  await admin.firestore().collection("hunt_logs").add(logData);
}

async function finishActiveHuntAndLog({
  firebaseUid,
  endedReason,
  notes,
  harvest = false,
  species = "",
  harvestItems = [],
  pendingItems = [],
}) {
  const ref = admin.firestore().collection("active_hunts").doc(firebaseUid);
  const snap = await ref.get();

  if (!snap.exists) {
    return { ok: true, missing: true };
  }

  const data = snap.data() || {};
  const finishedAt = new Date();

  await addFinishedLogFromActiveHunt({
    firebaseUid,
    data,
    finishedAt,
    endedReason,
    notes,
    harvest,
    species,
    harvestItems,
    pendingItems,
  });

  await ref.delete();

  return { ok: true };
}

router.post("/register-token", requireAuth, async (req, res) => {
  try {
    const token = safeStr(req.body?.token);
    const hunterId = safeStr(req.user?.uid);
    const firebaseUid = safeStr(req.body?.firebaseUid) || safeStr(req.user?.uid);
    const ldId = safeStr(req.body?.ldId) || safeStr(req.user?.ldId);
    const platform = safeStr(req.body?.platform) || "android";

    if (!token) return res.status(400).json({ error: "Missing token" });
    if (!hunterId) return res.status(400).json({ error: "Missing hunterId" });
    if (!firebaseUid) return res.status(400).json({ error: "Missing firebaseUid" });
    if (!ldId) return res.status(400).json({ error: "Missing ldId" });

    const docId = Buffer.from(token).toString("base64url");

    await admin.firestore().collection("fcm_tokens").doc(docId).set(
      {
        token,
        hunterId,
        firebaseUid,
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

    const nowTs = admin.firestore.FieldValue.serverTimestamp();

    const data = {
      hunterId: firebaseUid,
      hunterName,
      ldId,
      locationName,
      locationMode,
      startedAt: nowTs,
      status: "active",
      lastSeenAt: nowTs,
      lastConfirmedAt: nowTs,
      reminderSentAt: null,
      moderatorAlertSentAt: null,
      lastAppOpenAt: nowTs,
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

router.post("/hunt-heartbeat", requireAuth, async (req, res) => {
  try {
    const firebaseUid = safeStr(req.user?.uid || req.body?.firebaseUid);
    if (!firebaseUid) return res.status(400).json({ error: "Missing firebaseUid" });

    await admin.firestore().collection("active_hunts").doc(firebaseUid).set(
      {
        lastSeenAt: admin.firestore.FieldValue.serverTimestamp(),
        lastAppOpenAt: admin.firestore.FieldValue.serverTimestamp(),
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

router.post("/hunt-still-active", requireAuth, async (req, res) => {
  try {
    const firebaseUid = safeStr(req.user?.uid || req.body?.firebaseUid);
    if (!firebaseUid) return res.status(400).json({ error: "Missing firebaseUid" });

    await admin.firestore().collection("active_hunts").doc(firebaseUid).set(
      {
        status: "active",
        lastSeenAt: admin.firestore.FieldValue.serverTimestamp(),
        lastConfirmedAt: admin.firestore.FieldValue.serverTimestamp(),
        reminderSentAt: null,
        moderatorAlertSentAt: null,
        lastAppOpenAt: admin.firestore.FieldValue.serverTimestamp(),
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

router.post("/hunt-end-by-user", requireAuth, async (req, res) => {
  try {
    const firebaseUid = safeStr(req.user?.uid || req.body?.firebaseUid);
    if (!firebaseUid) return res.status(400).json({ error: "Missing firebaseUid" });

    const endedReason = safeStr(req.body?.endedReason) || "user_confirmed_end";
    const harvest = toBool(req.body?.harvest);
    const species = safeStr(req.body?.species);
    const notesFromBody = safeStr(req.body?.notes);
    const harvestItems = sanitizeHarvestItems(req.body?.harvestItems);
    const pendingItems = sanitizePendingItems(req.body?.pendingItems);

    let notes = notesFromBody;
    if (!notes) {
      if (endedReason === "manual") {
        notes = "";
      } else if (endedReason === "user_confirmed_end") {
        notes = "Lovec je potrdil zaključek lova.";
      } else if (endedReason === "no_response_after_reminder") {
        notes = "AUTO: brez odziva na opomnik 'Ali si še na lovu?'.";
      }
    }

    const result = await finishActiveHuntAndLog({
      firebaseUid,
      endedReason,
      notes,
      harvest,
      species,
      harvestItems,
      pendingItems,
    });

    return res.json({ ok: true, result });
  } catch (e) {
    return res.status(500).json({
      error: "Server error",
      detail: String(e?.stack || e?.message || e),
    });
  }
});

router.post("/hunt-monitor-tick", async (req, res) => {
  try {
    const cronKey = safeStr(req.headers["x-cron-key"]);
    const expected = safeStr(process.env.HUNT_MONITOR_CRON_KEY);

    if (!expected || cronKey !== expected) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const now = Date.now();
    const snap = await admin.firestore().collection("active_hunts").get();

    let remindersSent = 0;
    let moderatorAlertsSent = 0;
    let autoFinished = 0;

    for (const doc of snap.docs) {
      const firebaseUid = doc.id;
      const data = doc.data() || {};

      const status = safeStr(data.status) || "active";
      const ldId = safeStr(data.ldId);
      const hunterName = safeStr(data.hunterName) || "Lovec";

      const lastConfirmedAt = tsToDate(data.lastConfirmedAt) || tsToDate(data.startedAt);
      const reminderSentAt = tsToDate(data.reminderSentAt);
      const moderatorAlertSentAt = tsToDate(data.moderatorAlertSentAt);

      if (!lastConfirmedAt || !ldId) continue;

      const sinceConfirmed = now - lastConfirmedAt.getTime();

      if (status === "active" && sinceConfirmed >= REMINDER_AFTER_MS) {
        const hunterTokens = await getEnabledTokensForFirebaseUid(firebaseUid);

        await sendToUserTokens({
          title: "ROG",
          body: "Ali si še na lovu?",
          tokens: hunterTokens,
          data: {
            type: "hunt_still_active_prompt",
            firebaseUid,
            ldId,
            hunterName,
          },
        });

        await doc.ref.set(
          {
            status: "reminder_pending",
            reminderSentAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );

        remindersSent++;
        continue;
      }

      if (status === "reminder_pending" && reminderSentAt) {
        const sinceReminder = now - reminderSentAt.getTime();

        if (sinceReminder >= MODERATOR_ALERT_AFTER_MS && !moderatorAlertSentAt) {
          const modTokens = await getModeratorTokensForLd(ldId);

          await sendToUserTokens({
            title: "ROG – varnostni pregled",
            body: `${hunterName} se ni odzval na vprašanje "Ali si še na lovu?"`,
            tokens: modTokens,
            data: {
              type: "hunt_moderator_alert",
              firebaseUid,
              ldId,
              hunterName,
            },
          });

          await doc.ref.set(
            {
              moderatorAlertSentAt: admin.firestore.FieldValue.serverTimestamp(),
            },
            { merge: true }
          );

          moderatorAlertsSent++;
        }

        if (sinceReminder >= AUTO_END_AFTER_MS) {
          await finishActiveHuntAndLog({
            firebaseUid,
            endedReason: "no_response_after_reminder",
            notes: "AUTO: brez odziva na opomnik 'Ali si še na lovu?'.",
            harvest: false,
            species: "",
            harvestItems: [],
            pendingItems: [],
          });

          autoFinished++;
        }
      }
    }

    return res.json({
      ok: true,
      remindersSent,
      moderatorAlertsSent,
      autoFinished,
    });
  } catch (e) {
    return res.status(500).json({
      error: "Server error",
      detail: String(e?.stack || e?.message || e),
    });
  }
});

module.exports = router;