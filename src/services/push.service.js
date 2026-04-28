const { admin } = require("../firebase");

function safeStr(v) {
  return (v == null ? "" : String(v)).trim();
}

async function getLdTokens(ldId) {
  const snap = await admin
    .firestore()
    .collection("fcm_tokens")
    .where("ldId", "==", ldId)
    .where("enabled", "==", true)
    .get();

  return snap.docs
    .map((d) => safeStr(d.data()?.token))
    .filter(Boolean);
}

async function getHunterTokens(hunterId) {
  const snap = await admin
    .firestore()
    .collection("fcm_tokens")
    .where("hunterId", "==", hunterId)
    .where("enabled", "==", true)
    .get();

  return snap.docs
    .map((d) => safeStr(d.data()?.token))
    .filter(Boolean);
}

async function cleanupInvalidTokens(tokens) {
  if (!tokens.length) return;

  const db = admin.firestore();
  const batch = db.batch();

  for (const token of tokens) {
    const docId = Buffer.from(token).toString("base64url");
    const ref = db.collection("fcm_tokens").doc(docId);

    batch.set(
      ref,
      {
        enabled: false,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
  }

  await batch.commit();
}

async function sendToTokens(tokens, { title, body, data = {} }) {
  const cleanTokens = Array.from(
    new Set((tokens || []).map(safeStr).filter(Boolean))
  );

  if (cleanTokens.length === 0) {
    return { ok: true, sent: 0, failed: 0 };
  }

  const cleanTitle = safeStr(title) || "ROG";
  const cleanBody = safeStr(body);

  const cleanData = Object.fromEntries(
    Object.entries(data || {}).map(([k, v]) => [k, v == null ? "" : String(v)])
  );

  const message = {
    tokens: cleanTokens,

    // Android + iOS visible notification
    notification: {
      title: cleanTitle,
      body: cleanBody,
    },

    data: cleanData,

    android: {
      priority: "high",
      notification: {
        channelId: "rog_notifications",
        sound: "default",
        priority: "high",
      },
    },

    // iOS / APNs config
    apns: {
      headers: {
        "apns-priority": "10",
      },
      payload: {
        aps: {
          alert: {
            title: cleanTitle,
            body: cleanBody,
          },
          sound: "default",
          badge: 1,
          "content-available": 1,
        },
      },
    },
  };

  const response = await admin.messaging().sendEachForMulticast(message);

  const invalidTokens = [];

  response.responses.forEach((r, i) => {
    if (!r.success) {
      const code = r.error?.code || "";

      console.error("FCM send failed:", {
        tokenPrefix: cleanTokens[i]?.slice(0, 18),
        code,
        message: r.error?.message,
      });

      if (
        code.includes("registration-token-not-registered") ||
        code.includes("invalid-argument")
      ) {
        invalidTokens.push(cleanTokens[i]);
      }
    }
  });

  if (invalidTokens.length) {
    await cleanupInvalidTokens(invalidTokens);
  }

  return {
    ok: true,
    sent: response.successCount,
    failed: response.failureCount,
  };
}

async function sendToLd({ ldId, title, body, data = {} }) {
  const tokens = await getLdTokens(ldId);
  return sendToTokens(tokens, { title, body, data });
}

async function sendToHunter({ hunterId, title, body, data = {} }) {
  const tokens = await getHunterTokens(hunterId);
  return sendToTokens(tokens, { title, body, data });
}

module.exports = {
  sendToLd,
  sendToHunter,
  sendToTokens,
};