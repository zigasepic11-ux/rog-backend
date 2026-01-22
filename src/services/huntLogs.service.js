const { getDb } = require("../firebase");

const COL = "hunt_logs";

function parseDateParam(s) {
  if (!s) return null;
  const d = new Date(String(s));
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

async function listHuntLogs({ ldId, from, to, limit = 500 }) {
  if (!ldId) throw new Error("ldId is required");

  const db = getDb();
  const fromDate = parseDateParam(from);
  const toDate = parseDateParam(to);

  // ✅ Filtriramo po finishedAt (skladno z app logiko)
  let q = db.collection(COL).where("ldId", "==", String(ldId));

  if (fromDate) q = q.where("finishedAt", ">=", fromDate);
  if (toDate) q = q.where("finishedAt", "<=", toDate);

  q = q.orderBy("finishedAt", "desc").limit(Number(limit) || 500);

  const snap = await q.get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

module.exports = { listHuntLogs };
