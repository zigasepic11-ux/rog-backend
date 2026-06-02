const { admin } = require("../firebase");

function safeStr(v) {
  return (v == null ? "" : String(v)).trim();
}

async function getLdTokens(ldId) {
  const cleanLdId = safeStr(ldId).toLowerCase();

  const snap = await admin
    .firestore()
    .collection("fcm_tokens")
    .where("ldId", "==", cleanLdId)
    .where("enabled", "==", true)
    .get();

  return snap.docs
    .map((d) => safeStr(d.data()?.token))
    .filter(Boolean);
}

async function getHunterTokens(hunterId) {
  const cleanHunterId = safeStr(hunterId);

  const snap = await admin
    .firestore()
    .collection("fcm_tokens")
    .where("hunterId", "==", cleanHunterId)
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
    console.log("FCM skipped: no tokens");
    return { ok: true, sent: 0, failed: 0 };
  }

  const cleanTitle = safeStr(title) || "ROG";
  const cleanBody = safeStr(body);

  const cleanData = Object.fromEntries(
    Object.entries(data || {}).map(([k, v]) => [k, v == null ? "" : String(v)])
  );

  const message = {
    tokens: cleanTokens,

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

    apns: {
      headers: {
        "apns-priority": "10",
        "apns-push-type": "alert",
      },
      payload: {
        aps: {
          alert: {
            title: cleanTitle,
            body: cleanBody,
          },
          sound: "default",
          badge: 1,
        },
      },
    },
  };

  console.log("FCM sending:", {
    tokenCount: cleanTokens.length,
    title: cleanTitle,
    body: cleanBody,
    data: cleanData,
  });

  const response = await admin.messaging().sendEachForMulticast(message);

  console.log("FCM multicast result:", {
    tokenCount: cleanTokens.length,
    successCount: response.successCount,
    failureCount: response.failureCount,
  });

  const invalidTokens = [];

  response.responses.forEach((r, i) => {
    if (!r.success) {
      const code = r.error?.code || "";
      const msg = r.error?.message || "";

      console.error("FCM send failed:", {
        tokenPrefix: cleanTokens[i]?.slice(0, 24),
        code,
        message: msg,
      });

      if (
        code.includes("registration-token-not-registered") ||
        code.includes("invalid-argument")
      ) {
        invalidTokens.push(cleanTokens[i]);
      }
    } else {
      console.log("FCM send success:", {
        tokenPrefix: cleanTokens[i]?.slice(0, 24),
      });
    }
  });

  if (invalidTokens.length) {
    console.log("FCM cleanup invalid tokens:", {
      count: invalidTokens.length,
    });

    await cleanupInvalidTokens(invalidTokens);
  }

  return {
    ok: true,
    sent: response.successCount,
    failed: response.failureCount,
  };
}

async function sendToLd({ ldId, title, body, data = {} }) {
  const cleanLdId = safeStr(ldId).toLowerCase();
  const tokens = await getLdTokens(cleanLdId);

  console.log("sendToLd debug:", {
    ldId: cleanLdId,
    tokenCount: tokens.length,
  });

  return sendToTokens(tokens, { title, body, data });
}

async function sendToHunter({ hunterId, title, body, data = {} }) {
  const cleanHunterId = safeStr(hunterId);
  const tokens = await getHunterTokens(cleanHunterId);

  console.log("sendToHunter debug:", {
    hunterId: cleanHunterId,
    tokenCount: tokens.length,
  });

  return sendToTokens(tokens, { title, body, data });
}

module.exports = {
  sendToLd,
  sendToHunter,
  sendToTokens,
};