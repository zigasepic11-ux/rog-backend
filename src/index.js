const express = require("express");
const cors = require("cors");
const { GoogleAuth } = require("google-auth-library");
require("dotenv").config();

const { initFirebase } = require("./firebase");
initFirebase();

const app = express();
app.set("trust proxy", 1);
app.set("etag", false);

app.get("/__version", (req, res) => {
  res.json({
    ok: true,
    marker: "ROG-BACKEND",
    commit: "df0cfbf",
    time: new Date().toISOString(),
  });
});

const allowList = String(process.env.CORS_ORIGIN || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const corsOptions = {
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    if (allowList.length === 0) return cb(null, true);
    if (allowList.includes(origin)) return cb(null, true);
    return cb(new Error(`CORS blocked: ${origin}`), false);
  },
  credentials: true,
  methods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  optionsSuccessStatus: 204,
};

app.use(cors(corsOptions));
app.options("*", cors(corsOptions));

app.get("/debug/cors", (req, res) => {
  res.json({
    ok: true,
    requestOrigin: req.headers.origin || null,
    cors_origin_env: process.env.CORS_ORIGIN || null,
    allowList,
  });
});

app.use(express.json({ limit: "25mb" }));

app.use((req, res, next) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.setHeader("Surrogate-Control", "no-store");
  next();
});

app.use((req, res, next) => {
  const t0 = Date.now();
  res.on("finish", () => {
    const ms = Date.now() - t0;
    console.log(`${req.method} ${req.originalUrl} -> ${res.statusCode} (${ms}ms)`);
  });
  next();
});

app.get("/health", (req, res) => res.json({ ok: true, marker: "ROG-BACKEND" }));

function loadRoute(modulePath) {
  try {
    const r = require(modulePath);
    if (typeof r !== "function") {
      throw new Error(`module does not export an Express router (got: ${typeof r})`);
    }
    return { ok: true, router: r, error: null };
  } catch (e) {
    return { ok: false, router: null, error: String(e?.stack || e?.message || e) };
  }
}

const authLoad = loadRoute("./routes/auth.routes");
const ldLoad = loadRoute("./routes/ld.routes");
const workHoursLoad = loadRoute("./routes/workhours.routes");
const documentsLoad = loadRoute("./routes/documents.routes");
const notificationsLoad = loadRoute("./routes/notifications.routes");

if (authLoad.ok) app.use("/auth", authLoad.router);
else console.error("❌ FAILED loading ./routes/auth.routes\n", authLoad.error);

if (ldLoad.ok) app.use("/ld", ldLoad.router);
else console.error("❌ FAILED loading ./routes/ld.routes\n", ldLoad.error);

if (workHoursLoad.ok) app.use("/ld", workHoursLoad.router);
else console.error("❌ FAILED loading ./routes/workhours.routes\n", workHoursLoad.error);

if (documentsLoad.ok) app.use("/ld", documentsLoad.router);
else console.error("❌ FAILED loading ./routes/documents.routes\n", documentsLoad.error);

if (notificationsLoad.ok) app.use("/notifications", notificationsLoad.router);
else console.error("❌ FAILED loading ./routes/notifications.routes\n", notificationsLoad.error);

app.get("/debug/routes", (req, res) => {
  res.json({
    ok: true,
    authMounted: authLoad.ok,
    ldMounted: ldLoad.ok,
    workHoursMounted: workHoursLoad.ok,
    documentsMounted: documentsLoad.ok,
    notificationsMounted: notificationsLoad.ok,
    authError: authLoad.ok ? null : authLoad.error,
    ldError: ldLoad.ok ? null : ldLoad.error,
    workHoursError: workHoursLoad.ok ? null : workHoursLoad.error,
    documentsError: documentsLoad.ok ? null : documentsLoad.error,
    notificationsError: notificationsLoad.ok ? null : notificationsLoad.error,
  });
});

app.get("/debug/firebase", async (req, res) => {
  const { admin } = require("./firebase");

  try {
    const appInstance = admin.app();
    const json = process.env.FIREBASE_SERVICE_ACCOUNT_JSON || "";
    const serviceAccount = json ? JSON.parse(json) : null;

    const info = {
      initialized: admin.apps.length,
      projectIdFromApp: appInstance.options.projectId || null,
      projectIdFromJson: serviceAccount?.project_id || null,
      clientEmailFromJson: serviceAccount?.client_email || null,
      privateKeyIdFromJson: serviceAccount?.private_key_id || null,
      storageBucket: appInstance.options.storageBucket || null,
    };

    let firestoreRead = null;

    try {
      const snap = await admin.firestore().collection("hunters").doc("999999").get();
      firestoreRead = { ok: true, exists: snap.exists };
    } catch (e) {
      firestoreRead = {
        ok: false,
        message: e?.message,
        code: e?.code,
        details: e?.details,
      };
    }

    res.json({
      ok: firestoreRead?.ok === true,
      firebaseInfo: info,
      firestoreRead,
    });
  } catch (e) {
    res.status(500).json({
      ok: false,
      message: e?.message,
      code: e?.code,
      details: e?.details,
    });
  }
});
app.get("/debug/token", async (req, res) => {
  try {
    const json = process.env.FIREBASE_SERVICE_ACCOUNT_JSON || "";
    const serviceAccount = json ? JSON.parse(json) : null;

    const auth = new GoogleAuth({
      credentials: serviceAccount,
      projectId: serviceAccount?.project_id,
      scopes: ["https://www.googleapis.com/auth/cloud-platform"],
    });

    const client = await auth.getClient();
    const token = await client.getAccessToken();

    res.json({
      ok: true,
      projectId: await auth.getProjectId(),
      clientEmail: serviceAccount?.client_email,
      privateKeyId: serviceAccount?.private_key_id,
      tokenLength: token?.token?.length || 0,
    });
  } catch (e) {
    res.status(500).json({
      ok: false,
      message: e?.message,
      code: e?.code,
      stack: e?.stack,
    });
  }
});

app.get("/debug/firestore-rest", async (req, res) => {
  try {
    const { GoogleAuth } = require("google-auth-library");

    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);

    const auth = new GoogleAuth({
      credentials: serviceAccount,
      scopes: ["https://www.googleapis.com/auth/datastore"],
    });

    const client = await auth.getClient();
    const token = await client.getAccessToken();

    const response = await fetch(
      `https://firestore.googleapis.com/v1/projects/${serviceAccount.project_id}/databases/%28default%29/documents/hunters/999999`,
      {
        headers: {
          Authorization: `Bearer ${token.token}`,
        },
      }
    );

    const text = await response.text();

    res.json({
      status: response.status,
      body: text,
    });
  } catch (e) {
    res.status(500).json({
      message: e.message,
      stack: e.stack,
    });
  }
});

app.get("/debug/firestore-client", async (req, res) => {
  try {
    const { Firestore } = require("@google-cloud/firestore");

    const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);

    const db = new Firestore({
      projectId: sa.project_id,
      credentials: sa,
    });

    const cols = await db.listCollections();

    res.json({
      ok: true,
      collections: cols.map(c => c.id),
    });
  } catch (e) {
    res.status(500).json({
      ok: false,
      message: e.message,
      code: e.code,
      details: e.details,
      stack: e.stack,
    });
  }
});

app.get("/debug/project", async (req, res) => {
  try {
    const { GoogleAuth } = require("google-auth-library");

    const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);

    const auth = new GoogleAuth({
      credentials: sa,
      scopes: ["https://www.googleapis.com/auth/cloud-platform"],
    });

    const client = await auth.getClient();

    const r = await client.request({
      url: `https://cloudresourcemanager.googleapis.com/v1/projects/${sa.project_id}`,
    });

    res.json(r.data);
  } catch (e) {
    res.status(500).json({
      message: e.message,
      code: e.code,
      details: e.response?.data || e.details,
    });
  }
});

app.use((req, res) => res.status(404).json({ error: "Not found", path: req.originalUrl }));

app.use((err, req, res, next) => {
  console.error("🔥 UNHANDLED ERROR:", err);
  res.status(500).json({
    error: "Server error",
    detail: String(err?.stack || err?.message || err),
  });
});

const PORT = Number(process.env.PORT || 3001);
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 ROG backend running on http://0.0.0.0:${PORT}`);
  if (allowList.length) console.log("✅ CORS allowList:", allowList);
  else console.log("⚠️ CORS allowList empty -> allowing all origins (dev)");
});