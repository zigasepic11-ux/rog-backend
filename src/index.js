const express = require("express");
const cors = require("cors");
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