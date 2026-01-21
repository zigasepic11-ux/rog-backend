// import_lds.js
// Run: node import_lds.js

const fs = require("fs");
const path = require("path");
const admin = require("firebase-admin");

const servicePath = path.join(__dirname, "serviceAccountKey.json");
const dataPath = path.join(__dirname, "lds.json");

if (!fs.existsSync(servicePath)) {
  console.error("❌ Missing serviceAccountKey.json in rog-backend root.");
  process.exit(1);
}
if (!fs.existsSync(dataPath)) {
  console.error("❌ Missing lds.json in rog-backend root.");
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(require(servicePath)),
});

function norm(s) {
  return String(s || "").trim();
}

async function run() {
  const db = admin.firestore();
  const items = JSON.parse(fs.readFileSync(dataPath, "utf8"));

  if (!Array.isArray(items)) throw new Error("lds.json must be an array");

  const batchSize = 400; // Firestore limit 500
  let batch = db.batch();
  let count = 0;
  let total = 0;

  for (const item of items) {
    const id = norm(item.id);
    const name = norm(item.name);
    const region = norm(item.region);
    const kmlFile = norm(item.kmlFile); // optional
    const enabled = item.enabled !== false; // default true

    if (!id || !name) {
      console.warn("⚠️ Skipping invalid item (need id+name):", item);
      continue;
    }

    const ref = db.collection("lds").doc(id);

    batch.set(
      ref,
      {
        name,
        region,
        kmlFile,
        enabled,
        updatedAt: new Date().toISOString(),
        // createdAt nastavimo samo če doc še ne obstaja (merge + createAtOnly)
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    count++;
    total++;

    if (count >= batchSize) {
      await batch.commit();
      console.log(`✅ Committed batch of ${count} (total ${total})`);
      batch = db.batch();
      count = 0;
    }
  }

  if (count > 0) {
    await batch.commit();
    console.log(`✅ Committed final batch of ${count} (total ${total})`);
  }

  console.log("🎉 DONE: lds imported/updated into Firestore collection 'lds'.");
  process.exit(0);
}

run().catch((e) => {
  console.error("❌ Import failed:", e);
  process.exit(1);
});
