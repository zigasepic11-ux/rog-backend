const express = require("express");
const cors = require("cors");
require("dotenv").config();

const { initFirebase } = require("./firebase");
initFirebase();

// Routes
const authRoutes = require("./routes/auth.routes");

// Če imaš še /ld routes, ga vključimo varno
let ldRoutes = null;
try {
  // če datoteka obstaja in exporta router
  ldRoutes = require("./routes/ld.routes");
} catch (_) {
  ldRoutes = null;
}

const app = express();

// ✅ CORS (MVP: allow all origins). Kasneje omejimo na portal domeno.
app.use(cors({ origin: true }));

app.use(express.json({ limit: "2mb" }));

// ✅ Healthcheck za Render + test povezave
app.get("/health", (req, res) => res.json({ ok: true }));

// Routes
app.use("/auth", authRoutes);
if (ldRoutes) app.use("/ld", ldRoutes);

// ✅ Render uporablja ENV PORT
const PORT = Number(process.env.PORT || 3001);

// ✅ poslušaj na vseh vmesnikih (da deluje iz interneta)
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 ROG backend running on http://0.0.0.0:${PORT}`);
});
