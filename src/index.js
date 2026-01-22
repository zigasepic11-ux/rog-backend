// src/index.js
const express = require("express");
const cors = require("cors");
require("dotenv").config();

console.log("🔥 STARTING ROG-BACKEND FROM:", __filename);
console.log("📌 CWD:", process.cwd());

const { initFirebase } = require("./firebase");
initFirebase();

const app = express();

// (če boš kdaj za proxyjem / Render ipd.)
app.set("trust proxy", 1);

// ✅ CORS (pomembno: Authorization header!)
app.use(
  cors({
    origin: true, // MVP: allow all origins (kasneje omeji)
    methods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

// preflight
app.options("*", cors());

app.use(express.json({ limit: "2mb" }));

// ✅ Request logger (da vidiš kaj portal kliče)
app.use((req, res, next) => {
  const t0 = Date.now();
  res.on("finish", () => {
    const ms = Date.now() - t0;
    console.log(
      `${req.method} ${req.originalUrl} -> ${res.statusCode} (${ms}ms)`
    );
  });
  next();
});

// ✅ Health marker
app.get("/health", (req, res) =>
  res.json({ ok: true, marker: "ROG-BACKEND-LOCAL" })
);

// ---------------------------
// ✅ Safe route loader
// ---------------------------
function loadRoute(modulePath) {
  try {
    const r = require(modulePath);
    if (!r) throw new Error("module exports is empty");
    // Express router je funkcija z .use/.get...
    if (typeof r !== "function") {
      throw new Error(
        `module does not export an Express router (got: ${typeof r})`
      );
    }
    return { ok: true, router: r, error: null };
  } catch (e) {
    return {
      ok: false,
      router: null,
      error: String(e?.stack || e?.message || e),
    };
  }
}

const authLoad = loadRoute("./routes/auth.routes");
const ldLoad = loadRoute("./routes/ld.routes");

// ✅ Mount what loaded
if (authLoad.ok) {
  app.use("/auth", authLoad.router);
  console.log("✅ Mounted /auth");
} else {
  console.error("❌ FAILED loading ./routes/auth.routes");
  console.error(authLoad.error);
}

if (ldLoad.ok) {
  app.use("/ld", ldLoad.router);
  console.log("✅ Mounted /ld");
} else {
  console.error("❌ FAILED loading ./routes/ld.routes");
  console.error(ldLoad.error);
}

// ---------------------------
// ✅ Debug endpoints
// ---------------------------

// Vrne status mountanja + napake
app.get("/debug/routes", (req, res) => {
  res.json({
    ok: true,
    authMounted: authLoad.ok,
    ldMounted: ldLoad.ok,
    authError: authLoad.ok ? null : authLoad.error,
    ldError: ldLoad.ok ? null : ldLoad.error,
  });
});

// ✅ Izpiše dejanske registrirane poti (najbolj uporabno!)
function listRoutes(app) {
  const out = [];

  const stack = app?._router?.stack || [];
  for (const layer of stack) {
    if (layer.route && layer.route.path) {
      const methods = Object.keys(layer.route.methods || {})
        .map((m) => m.toUpperCase())
        .join(",");
      out.push({ path: layer.route.path, methods });
    } else if (layer.name === "router" && layer.handle?.stack) {
      // router mounted (npr. /auth, /ld)
      const mountPath = layer.regexp?.toString() || "";
      for (const l2 of layer.handle.stack) {
        if (l2.route && l2.route.path) {
          const methods = Object.keys(l2.route.methods || {})
            .map((m) => m.toUpperCase())
            .join(",");
          out.push({
            path: `${mountPath}  +  ${l2.route.path}`,
            methods,
          });
        }
      }
    }
  }
  return out;
}

app.get("/debug/route-list", (req, res) => {
  res.json({
    ok: true,
    note:
      "Če tu ne vidiš /ld/active-hunts, potem endpoint v ld.routes.js ne obstaja (zato portal dobi 404).",
    routes: listRoutes(app),
  });
});

// ✅ 404 handler (lep JSON) — NA KONCU
app.use((req, res) => {
  res.status(404).json({ error: "Not found", path: req.originalUrl });
});

// ✅ Global error handler — zadnji
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
  console.log("✅ Test:");
  console.log("   GET  http://localhost:3001/health");
  console.log("   GET  http://localhost:3001/debug/routes");
  console.log("   GET  http://localhost:3001/debug/route-list");
});
