// src/routes/workhours.routes.js
const express = require("express");
const { admin } = require("../firebase");
const { requireAuth } = require("../auth");

const router = express.Router();

const STAFF_ROLES = ["moderator", "admin", "super"];

function safeStr(v) {
  return (v == null ? "" : String(v)).trim();
}

function numOrNull(v) {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

function toIsoMaybe(ts) {
  if (!ts) return null;
  if (ts?.toDate) return ts.toDate().toISOString();
  return null;
}

function isSuper(req) {
  const r = String(req.user?.role || "").trim();
  return r === "super" || r === "admin";
}

function isStaff(req) {
  const r = String(req.user?.role || "").trim();
  return STAFF_ROLES.includes(r);
}

function requireStaff(req, res, next) {
  if (isStaff(req)) return next();
  return res.status(403).json({ error: "Forbidden (staff only)" });
}

function currentYear() {
  return new Date().getFullYear();
}

function planDocId(ldId, year) {
  return `${ldId}_${year}`;
}

/* ================= OVERVIEW =================
   GET /ld/work-hours/overview?year=2026
*/
router.get("/work-hours/overview", requireAuth, async (req, res) => {
  try {
    const ldId = safeStr(req.user?.ldId);
    if (!ldId) {
      return res.status(400).json({ error: "Missing ldId in token." });
    }

    const year = Number(req.query?.year || currentYear());
    if (!year || year < 2020 || year > 2100) {
      return res.status(400).json({ error: "Invalid year" });
    }

    const db = admin.firestore();

    const huntersSnap = await db
      .collection("hunters")
      .where("ldId", "==", ldId)
      .get();

    const hunters = huntersSnap.docs.map((d) => {
      const x = d.data() || {};
      return {
        hunterId: d.id,
        hunterCode: d.id,
        name: safeStr(x.name),
        role: safeStr(x.role || "member"),
        enabled: x.enabled === true,
      };
    });

    const plansSnap = await db
      .collection("work_hour_plans")
      .doc(planDocId(ldId, year))
      .collection("members")
      .get();

    const plansByHunter = {};
    for (const d of plansSnap.docs) {
      const x = d.data() || {};
      plansByHunter[d.id] = {
        plannedHours: numOrNull(x.plannedHours) ?? 0,
        notes: safeStr(x.notes),
        updatedAt: toIsoMaybe(x.updatedAt),
      };
    }

    const actionsSnap = await db
      .collection("work_actions")
      .where("ldId", "==", ldId)
      .where("year", "==", year)
      .get();

    const doneByHunter = {};

    for (const actionDoc of actionsSnap.docs) {
      const entriesSnap = await actionDoc.ref.collection("entries").get();

      for (const entryDoc of entriesSnap.docs) {
        const e = entryDoc.data() || {};
        const hunterId = safeStr(e.hunterId || entryDoc.id);
        const hours = numOrNull(e.hours) ?? 0;
        if (!hunterId) continue;
        doneByHunter[hunterId] = (doneByHunter[hunterId] || 0) + hours;
      }
    }

    const rows = hunters
      .sort((a, b) => String(a.name).localeCompare(String(b.name), "sl"))
      .map((h) => {
        const plannedHours = plansByHunter[h.hunterId]?.plannedHours ?? 0;
        const doneHours = doneByHunter[h.hunterId] ?? 0;
        const missingHours = Math.max(0, plannedHours - doneHours);
        const extraHours = Math.max(0, doneHours - plannedHours);

        return {
          hunterId: h.hunterId,
          hunterCode: h.hunterCode,
          name: h.name,
          role: h.role,
          enabled: h.enabled,
          plannedHours,
          doneHours,
          missingHours,
          extraHours,
        };
      });

    return res.json({
      ok: true,
      ldId,
      year,
      rows,
    });
  } catch (e) {
    return res.status(500).json({
      error: "Server error",
      detail: String(e?.stack || e?.message || e),
    });
  }
});
/* ================= MY WORK HOURS =================
   GET /ld/work-hours/me?year=2026
*/
router.get("/work-hours/me", requireAuth, async (req, res) => {
  try {
    const ldId = safeStr(req.user?.ldId);
    const hunterId = safeStr(req.user?.code || req.user?.hunterId || req.user?.id);

    if (!ldId) {
      return res.status(400).json({ error: "Missing ldId in token." });
    }

    if (!hunterId) {
      return res.status(400).json({ error: "Missing hunter id in token." });
    }

    const year = Number(req.query?.year || currentYear());
    if (!year || year < 2020 || year > 2100) {
      return res.status(400).json({ error: "Invalid year" });
    }

    const db = admin.firestore();

    const hunterRef = db.collection("hunters").doc(hunterId);
    const hunterSnap = await hunterRef.get();

    if (!hunterSnap.exists) {
      return res.status(404).json({ error: "Hunter not found" });
    }

    const hunter = hunterSnap.data() || {};

    if (!isSuper(req) && safeStr(hunter.ldId) !== ldId) {
      return res.status(403).json({ error: "Forbidden (other LD)" });
    }

    const planSnap = await db
      .collection("work_hour_plans")
      .doc(planDocId(ldId, year))
      .collection("members")
      .doc(hunterId)
      .get();

    const plannedHours = planSnap.exists
      ? (numOrNull(planSnap.data()?.plannedHours) ?? 0)
      : 0;

    const actionsSnap = await db
      .collection("work_actions")
      .where("ldId", "==", ldId)
      .where("year", "==", year)
      .get();

    let doneHours = 0;

    for (const actionDoc of actionsSnap.docs) {
      const entrySnap = await actionDoc.ref.collection("entries").doc(hunterId).get();
      if (!entrySnap.exists) continue;

      const entry = entrySnap.data() || {};
      doneHours += numOrNull(entry.hours) ?? 0;
    }

    const missingHours = Math.max(0, plannedHours - doneHours);
    const extraHours = Math.max(0, doneHours - plannedHours);

    return res.json({
      ok: true,
      ldId,
      year,
      hunterId,
      hunterCode: hunterId,
      name: safeStr(hunter.name),
      role: safeStr(hunter.role || "member"),
      plannedHours,
      doneHours,
      missingHours,
      extraHours,
    });
  } catch (e) {
    return res.status(500).json({
      error: "Server error",
      detail: String(e?.stack || e?.message || e),
    });
  }
});

/* ================= PLAN SET =================
   POST /ld/work-hours/plan
   body: { hunterId, plannedHours, year? }
*/
router.post("/work-hours/plan", requireAuth, requireStaff, async (req, res) => {
  try {
    const ldId = safeStr(req.user?.ldId);
    if (!ldId) {
      return res.status(400).json({ error: "Missing ldId in token." });
    }

    const hunterId = safeStr(req.body?.hunterId);
    const plannedHours = numOrNull(req.body?.plannedHours);
    const year = Number(req.body?.year || req.query?.year || currentYear());

    if (!hunterId) {
      return res.status(400).json({ error: "Missing hunterId" });
    }

    if (plannedHours == null || plannedHours < 0) {
      return res.status(400).json({ error: "Invalid plannedHours" });
    }

    if (!year || year < 2020 || year > 2100) {
      return res.status(400).json({ error: "Invalid year" });
    }

    const db = admin.firestore();

    const hunterRef = db.collection("hunters").doc(hunterId);
    const hunterSnap = await hunterRef.get();

    if (!hunterSnap.exists) {
      return res.status(404).json({ error: "Hunter not found" });
    }

    const hunter = hunterSnap.data() || {};
    if (!isSuper(req) && safeStr(hunter.ldId) !== ldId) {
      return res.status(403).json({ error: "Forbidden (other LD)" });
    }

    const memberRef = db
      .collection("work_hour_plans")
      .doc(planDocId(ldId, year))
      .collection("members")
      .doc(hunterId);

    await memberRef.set(
      {
        hunterId,
        hunterName: safeStr(hunter.name),
        role: safeStr(hunter.role || "member"),
        plannedHours,
        notes: safeStr(req.body?.notes),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedBy: safeStr(req.user?.uid || req.user?.code),
      },
      { merge: true }
    );

    await db
      .collection("work_hour_plans")
      .doc(planDocId(ldId, year))
      .set(
        {
          ldId,
          year,
          title: `Delovne ure ${year}`,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

    return res.json({
      ok: true,
      ldId,
      year,
      hunterId,
      plannedHours,
    });
  } catch (e) {
    return res.status(500).json({
      error: "Server error",
      detail: String(e?.stack || e?.message || e),
    });
  }
});

/* ================= WORK ACTIONS LIST =================
   GET /ld/work-actions?year=2026
*/
router.get("/work-actions", requireAuth, async (req, res) => {
  try {
    const ldId = safeStr(req.user?.ldId);
    if (!ldId) {
      return res.status(400).json({ error: "Missing ldId in token." });
    }

    const year = Number(req.query?.year || currentYear());
    if (!year || year < 2020 || year > 2100) {
      return res.status(400).json({ error: "Invalid year" });
    }

    const snap = await admin
      .firestore()
      .collection("work_actions")
      .where("ldId", "==", ldId)
      .where("year", "==", year)
      .get();

    const actions = snap.docs
      .map((d) => {
        const x = d.data() || {};
        return {
          id: d.id,
          ldId: safeStr(x.ldId),
          year: x.year || year,
          title: safeStr(x.title),
          description: safeStr(x.description),
          location: safeStr(x.location),
          status: safeStr(x.status || "open"),
          expectedHours: numOrNull(x.expectedHours) ?? 0,
          startsAt: toIsoMaybe(x.startsAt),
          createdAt: toIsoMaybe(x.createdAt),
          updatedAt: toIsoMaybe(x.updatedAt),
        };
      })
      .sort((a, b) => {
        const ta = a.startsAt ? new Date(a.startsAt).getTime() : 0;
        const tb = b.startsAt ? new Date(b.startsAt).getTime() : 0;
        return ta - tb;
      });

    return res.json({ ok: true, ldId, year, actions });
  } catch (e) {
    return res.status(500).json({
      error: "Server error",
      detail: String(e?.stack || e?.message || e),
    });
  }
});

/* ================= CREATE WORK ACTION =================
   POST /ld/work-actions
*/
router.post("/work-actions", requireAuth, requireStaff, async (req, res) => {
  try {
    const ldId = safeStr(req.user?.ldId);
    if (!ldId) {
      return res.status(400).json({ error: "Missing ldId in token." });
    }

    const title = safeStr(req.body?.title);
    const description = safeStr(req.body?.description);
    const location = safeStr(req.body?.location);
    const status = safeStr(req.body?.status || "open");
    const expectedHours = numOrNull(req.body?.expectedHours) ?? 0;
    const startsAtRaw = safeStr(req.body?.startsAt);

    if (!title) {
      return res.status(400).json({ error: "Missing title" });
    }

    if (!startsAtRaw) {
      return res.status(400).json({ error: "Missing startsAt" });
    }

    const d = new Date(startsAtRaw);
    if (Number.isNaN(d.getTime())) {
      return res.status(400).json({ error: "Invalid startsAt" });
    }

    const year = d.getFullYear();

    const ref = admin.firestore().collection("work_actions").doc();

    await ref.set({
      ldId,
      year,
      title,
      description,
      location,
      status,
      expectedHours,
      startsAt: admin.firestore.Timestamp.fromDate(d),
      createdBy: safeStr(req.user?.uid || req.user?.code),
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return res.json({
      ok: true,
      id: ref.id,
    });
  } catch (e) {
    return res.status(500).json({
      error: "Server error",
      detail: String(e?.stack || e?.message || e),
    });
  }
});

/* ================= LIST ENTRIES FOR ACTION =================
   GET /ld/work-actions/:id/entries
*/
router.get("/work-actions/:id/entries", requireAuth, async (req, res) => {
  try {
    const ldId = safeStr(req.user?.ldId);
    const id = safeStr(req.params.id);

    if (!ldId) return res.status(400).json({ error: "Missing ldId in token." });
    if (!id) return res.status(400).json({ error: "Missing action id" });

    const actionRef = admin.firestore().collection("work_actions").doc(id);
    const actionSnap = await actionRef.get();

    if (!actionSnap.exists) {
      return res.status(404).json({ error: "Action not found" });
    }

    const action = actionSnap.data() || {};
    if (!isSuper(req) && safeStr(action.ldId) !== ldId) {
      return res.status(403).json({ error: "Forbidden (other LD)" });
    }

    const snap = await actionRef.collection("entries").get();

    const entries = snap.docs
      .map((d) => {
        const x = d.data() || {};
        return {
          hunterId: d.id,
          hunterName: safeStr(x.hunterName),
          hours: numOrNull(x.hours) ?? 0,
          notes: safeStr(x.notes),
          enteredAt: toIsoMaybe(x.enteredAt),
          enteredBy: safeStr(x.enteredBy),
        };
      })
      .sort((a, b) => String(a.hunterName).localeCompare(String(b.hunterName), "sl"));

    return res.json({
      ok: true,
      id,
      entries,
    });
  } catch (e) {
    return res.status(500).json({
      error: "Server error",
      detail: String(e?.stack || e?.message || e),
    });
  }
});

/* ================= UPSERT ENTRY =================
   POST /ld/work-actions/:id/entries
   body: { hunterId, hours, notes? }
*/
router.post("/work-actions/:id/entries", requireAuth, requireStaff, async (req, res) => {
  try {
    const ldId = safeStr(req.user?.ldId);
    const id = safeStr(req.params.id);

    if (!ldId) return res.status(400).json({ error: "Missing ldId in token." });
    if (!id) return res.status(400).json({ error: "Missing action id" });

    const hunterId = safeStr(req.body?.hunterId);
    const hours = numOrNull(req.body?.hours);
    const notes = safeStr(req.body?.notes);

    if (!hunterId) {
      return res.status(400).json({ error: "Missing hunterId" });
    }

    if (hours == null || hours < 0) {
      return res.status(400).json({ error: "Invalid hours" });
    }

    const db = admin.firestore();

    const actionRef = db.collection("work_actions").doc(id);
    const actionSnap = await actionRef.get();

    if (!actionSnap.exists) {
      return res.status(404).json({ error: "Action not found" });
    }

    const action = actionSnap.data() || {};
    if (!isSuper(req) && safeStr(action.ldId) !== ldId) {
      return res.status(403).json({ error: "Forbidden (other LD)" });
    }

    const hunterRef = db.collection("hunters").doc(hunterId);
    const hunterSnap = await hunterRef.get();

    if (!hunterSnap.exists) {
      return res.status(404).json({ error: "Hunter not found" });
    }

    const hunter = hunterSnap.data() || {};
    if (!isSuper(req) && safeStr(hunter.ldId) !== ldId) {
      return res.status(403).json({ error: "Forbidden (hunter from other LD)" });
    }

    await actionRef.collection("entries").doc(hunterId).set(
      {
        hunterId,
        hunterName: safeStr(hunter.name),
        hours,
        notes,
        enteredBy: safeStr(req.user?.uid || req.user?.code),
        enteredAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    await actionRef.set(
      {
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    return res.json({
      ok: true,
      id,
      hunterId,
      hours,
    });
  } catch (e) {
    return res.status(500).json({
      error: "Server error",
      detail: String(e?.stack || e?.message || e),
    });
  }
});
/* ================= MY HUNT STATS =================
   GET /ld/hunt-stats/me?year=2026

   OPOMBA:
   Ta verzija predpostavlja kolekcijo "hunt_logs".
   Če imaš drugo ime kolekcije ali drugačna polja,
   bo treba to kasneje prilagoditi.
*/
router.get("/hunt-stats/me", requireAuth, async (req, res) => {
  try {
    const ldId = safeStr(req.user?.ldId);
    const hunterId = safeStr(req.user?.code || req.user?.hunterId || req.user?.id);

    if (!ldId) {
      return res.status(400).json({ error: "Missing ldId in token." });
    }

    if (!hunterId) {
      return res.status(400).json({ error: "Missing hunter id in token." });
    }

    const year = Number(req.query?.year || currentYear());
    if (!year || year < 2020 || year > 2100) {
      return res.status(400).json({ error: "Invalid year" });
    }

    const db = admin.firestore();

    // TODO: Če imaš drugo kolekcijo kot "hunt_logs", zamenjaj tukaj.
    const huntsSnap = await db
      .collection("hunt_logs")
      .where("ldId", "==", ldId)
      .where("hunterId", "==", hunterId)
      .get();

    const hunts = huntsSnap.docs.map((d) => {
      const x = d.data() || {};

      const startedAt = x.startedAt?.toDate
        ? x.startedAt.toDate().toISOString()
        : (x.startedAt || null);

      const endedAt = x.endedAt?.toDate
        ? x.endedAt.toDate().toISOString()
        : (x.endedAt || null);

      const status = safeStr(x.status || "");
      const hasCatch = x.hasCatch === true || x.successful === true;

      return {
        id: d.id,
        startedAt,
        endedAt,
        status,
        hasCatch,
      };
    });

    const totalHunts = hunts.length;

    const huntsThisYear = hunts.filter((h) => {
      if (!h.startedAt) return false;
      const d = new Date(h.startedAt);
      return !Number.isNaN(d.getTime()) && d.getFullYear() === year;
    });

    const finishedThisYear = huntsThisYear.filter((h) => {
      return h.status === "finished" || h.status === "closed" || !!h.endedAt;
    });

    const successfulThisYear = finishedThisYear.filter((h) => h.hasCatch);

    const finishedHunts = finishedThisYear.length;
    const successfulHunts = successfulThisYear.length;
    const successRate =
      finishedHunts > 0 ? (successfulHunts / finishedHunts) * 100 : 0;

    const sortedByDate = [...huntsThisYear].sort((a, b) => {
      const ta = a.startedAt ? new Date(a.startedAt).getTime() : 0;
      const tb = b.startedAt ? new Date(b.startedAt).getTime() : 0;
      return tb - ta;
    });

    const lastHunt = sortedByDate[0] || null;

    let lastHuntLabel = null;
    if (lastHunt?.startedAt) {
      try {
        const d = new Date(lastHunt.startedAt);
        lastHuntLabel = `Lov ${d.toLocaleDateString("sl-SI")}`;
      } catch (_) {
        lastHuntLabel = "Zadnji lov";
      }
    }

    return res.json({
      ok: true,
      ldId,
      year,
      hunterId,
      totalHunts,
      huntsThisYear: huntsThisYear.length,
      successfulHunts,
      finishedHunts,
      successRate: Number(successRate.toFixed(1)),
      lastHuntLabel,
    });
  } catch (e) {
    return res.status(500).json({
      error: "Server error",
      detail: String(e?.stack || e?.message || e),
    });
  }
});
module.exports = router;