// src/firebase.js
const admin = require("firebase-admin");
const fs = require("fs");
const path = require("path");

function initFirebase() {
  if (admin.apps.length) return admin;

  // Render/production: JSON v env
  const json = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (json && json.trim()) {
    const serviceAccount = JSON.parse(json);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
    return admin;
  }

  // Lokalno: pot do datoteke
  const p = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!p) {
    throw new Error("Missing FIREBASE_SERVICE_ACCOUNT_JSON or FIREBASE_SERVICE_ACCOUNT");
  }

  const fullPath = path.isAbsolute(p) ? p : path.join(process.cwd(), p);
  if (!fs.existsSync(fullPath)) {
    throw new Error(`Firebase service account file not found: ${fullPath}`);
  }

  const serviceAccount = JSON.parse(fs.readFileSync(fullPath, "utf8"));
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });

  return admin;
}

module.exports = { admin, initFirebase };
