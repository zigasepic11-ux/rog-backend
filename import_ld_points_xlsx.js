// import_ld_points_xlsx.js
// Run (PowerShell):
//   node .\import_ld_points_xlsx.js .\points_brezovica.xlsx
// Ali z ld filterjem:
//   node .\import_ld_points_xlsx.js .\points_all.xlsx brezovica
//
// Zahteva: npm i xlsx firebase-admin
// Lokalno: v root naj bo serviceAccountKey.json

const fs = require("fs");
const path = require("path");
const XLSX = require("xlsx");
const admin = require("firebase-admin");

const servicePath = path.join(__dirname, "serviceAccountKey.json");

if (!fs.existsSync(servicePath)) {
  console.error("❌ Missing serviceAccountKey.json in project root.");
  process.exit(1);
}

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(require(servicePath)),
  });
}

function safeStr(v) {
  return String(v ?? "").trim();
}

function toNum(v) {
  if (v == null) return null;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  const s = safeStr(v);
  if (!s) return null;
  const n = Number(s.replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

function normType(t) {
  // uskladi s portalom (krmisce, opazovalnica, lovska_koca, njiva, drugo)
  const s = safeStr(t)
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/č/g, "c")
    .replace(/š/g, "s")
    .replace(/ž/g, "z");
  return s;
}

function normStatus(s) {
  const x = safeStr(s).toLowerCase();
  if (!x) return ""; // pustimo prazno
  if (x === "active" || x === "inactive") return x;
  return "";
}

function makeDocId(ldId, pointId) {
  // stabilen docId v Firestore (brez presledkov, šumnikov, ...)
  const clean = (s) =>
    safeStr(s)
      .toLowerCase()
      .replace(/\s+/g, "_")
      .replace(/č/g, "c")
      .replace(/š/g, "s")
      .replace(/ž/g, "z")
      .replace(/[^a-z0-9_]+/g, "_")
      .replace(/_+/g, "_")
      .replace(/^_+|_+$/g, "");

  return `${clean(ldId)}__${clean(pointId)}`;
}

async function run() {
  const xlsxPath = process.argv[2];
  const onlyLd = safeStr(process.argv[3]); // optional: npr "brezovica"

  if (!xlsxPath) {
    console.error("❌ Usage: node import_ld_points_xlsx.js <file.xlsx> [ldId]");
    process.exit(1);
  }
  if (!fs.existsSync(xlsxPath)) {
    console.error("❌ File not found:", xlsxPath);
    process.exit(1);
  }

  const wb = XLSX.readFile(xlsxPath);
  const sheetName = wb.SheetNames[0]; // prva sheet-a
  const ws = wb.Sheets[sheetName];

  // preberemo v JSON preko headerjev iz prve vrstice
  const rows = XLSX.utils.sheet_to_json(ws, { defval: "" });

  // pričakujemo headerje: ldId*, type*, name*, lat*, lng*, notes, status, source, pointId
  // Excel lahko ima zvezdice v headerjih - to saniramo:
  const get = (row, key) => {
    // poskusi exact, potem brez *
    if (row[key] != null) return row[key];
    const key2 = key.replace("*", "");
    if (row[key2] != null) return row[key2];
    // poskusi še različice (npr lng ali "lng*")
    return "";
  };

  const db = admin.firestore();

  // 1) zberemo ldId-je, ki jih bomo uvažali
  const wantedLdIds = new Set();
  for (const r of rows) {
    const ldId = safeStr(get(r, "ldId*") || get(r, "ldId"));
    if (!ldId) continue;
    if (onlyLd && ldId !== onlyLd) continue;
    wantedLdIds.add(ldId);
  }

  if (!wantedLdIds.size) {
    console.log("⚠️ No rows found for import (check ldId column / optional ld filter).");
    process.exit(0);
  }

  // 2) prednaložimo obstoječe točke za te LD-je (da lahko najdemo doc po pointId in posodobimo, ne dupliciramo)
  // Map: `${ldId}__${pointId}` -> existingDocId
  const existingByKey = new Map();

  for (const ldId of wantedLdIds) {
    const snap = await db.collection("ld_points").where("ldId", "==", ldId).get();
    snap.docs.forEach((d) => {
      const x = d.data() || {};
      const pid = safeStr(x.pointId);
      if (!pid) return;
      existingByKey.set(`${ldId}__${pid}`, d.id);
    });
    console.log(`ℹ️ Existing points loaded for ${ldId}: ${snap.size}`);
  }

  // 3) batch upsert
  const BATCH_SIZE = 400;
  let batch = db.batch();
  let inBatch = 0;
  let total = 0;
  let created = 0;
  let updated = 0;
  let skipped = 0;

  for (const r of rows) {
    const ldId = safeStr(get(r, "ldId*") || get(r, "ldId"));
    if (!ldId) continue;
    if (onlyLd && ldId !== onlyLd) continue;

    const type = normType(get(r, "type*") || get(r, "type"));
    const name = safeStr(get(r, "name*") || get(r, "name"));
    const lat = toNum(get(r, "lat*") || get(r, "lat"));
    const lng = toNum(get(r, "lng*") || get(r, "lng"));
    const notes = safeStr(get(r, "notes"));
    const status = normStatus(get(r, "status"));
    const source = safeStr(get(r, "source"));
    const pointId = safeStr(get(r, "pointId"));

    if (!type || !name || lat == null || lng == null) {
      skipped++;
      continue;
    }

    if (!pointId) {
      // če pointId ni, NE uvažaj — ker brez tega ne moreš garantirat “no-duplicate”
      // (lahko spremeniš to pravilo, ampak priporočam, da je pointId obvezen)
      console.warn(`⚠️ Skipping row (missing pointId) for ldId=${ldId}, name="${name}"`);
      skipped++;
      continue;
    }

    const key = `${ldId}__${pointId}`;
    const existingDocId = existingByKey.get(key);

    let docId;
    let isUpdate = false;

    if (existingDocId) {
      docId = existingDocId;     // posodobi točno tisti obstoječi doc (tudi če je imel random ID)
      isUpdate = true;
    } else {
      docId = makeDocId(ldId, pointId);  // nov stabilen ID
      isUpdate = false;
      existingByKey.set(key, docId);
    }

    const ref = db.collection("ld_points").doc(docId);

    batch.set(
      ref,
      {
        ldId,
        ldName: safeStr(get(r, "LD ime") || get(r, "ldName")), // če obstaja
        type,
        name,
        lat,
        lng,
        notes,
        status,
        source,
        pointId, // ✅ ključ za dedupe
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    total++;
    if (isUpdate) updated++;
    else created++;

    inBatch++;
    if (inBatch >= BATCH_SIZE) {
      await batch.commit();
      console.log(`✅ Committed batch (${inBatch}). Total so far: ${total}`);
      batch = db.batch();
      inBatch = 0;
    }
  }

  if (inBatch > 0) {
    await batch.commit();
    console.log(`✅ Committed final batch (${inBatch}). Total: ${total}`);
  }

  console.log("🎉 DONE");
  console.log({ totalImported: total, created, updated, skipped });
  process.exit(0);
}

run().catch((e) => {
  console.error("❌ Import failed:", e);
  process.exit(1);
});
