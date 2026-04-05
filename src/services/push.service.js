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
  if (!Array.isArray(tokens) || tokens.length === 0) {
    return { ok: true, sent: 0, failed: 0 };
  }

  const message = {
    tokens,
    notification: {
      title: safeStr(title) || "ROG",
      body: safeStr(body),
    },
    data: Object.fromEntries(
      Object.entries(data || {}).map(([k, v]) => [k, String(v ?? "")])
    ),
    android: {
      priority: "high",
      notification: {
        channelId: "rog_notifications",
      },
    },
  };

  const response = await admin.messaging().sendEachForMulticast(message);

  const invalidTokens = [];
  response.responses.forEach((r, i) => {
    if (!r.success) {
      const code = r.error?.code || "";
      if (
        code.includes("registration-token-not-registered") ||
        code.includes("invalid-argument")
      ) {
        invalidTokens.push(tokens[i]);
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
};