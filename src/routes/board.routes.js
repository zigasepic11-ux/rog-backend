// src/routes/board.routes.js
const express = require("express");

const { admin } = require("../firebase");
const { requireAuth } = require("../auth");

const router = express.Router();

/* ================= HELPERS ================= */

function isBoardMember(req) {
  const role = String(req.user?.role || "");
  if (role === "admin" || role === "super") return true;
  return req.user?.isBoardMember === true;
}

function requireBoardMember(req, res, next) {
  if (isBoardMember(req)) return next();
  return res.status(403).json({ error: "Forbidden (board members only)" });
}

/* ================= ROUTES ================= */

router.get("/board/ping", requireAuth, requireBoardMember, (req, res) => {
  return res.json({ ok: true, message: "Board module reachable", code: req.user.code });
});

/* ================= SEJE ================= */

router.get("/board/meetings", requireAuth, requireBoardMember, async (req, res) => {
  try {
    const ldId = String(req.user?.ldId || "").trim();
    const snap = await admin
      .firestore()
      .collection("boardMeetings")
      .where("ldId", "==", ldId)
      .orderBy("datum", "desc")
      .get();

    const meetings = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    return res.json({ ok: true, meetings });
  } catch (e) {
    return res.status(500).json({
      error: "Server error",
      detail: String(e?.stack || e?.message || e),
    });
  }
});

router.post("/board/meetings", requireAuth, requireBoardMember, async (req, res) => {
  try {
    const ldId = String(req.user?.ldId || "").trim();
    if (!ldId) return res.status(400).json({ error: "Missing ldId in token." });

    const datum = req.body?.datum;
    if (!datum) return res.status(400).json({ error: "Missing datum" });

    const doc = {
      ldId,
      datum,
      lokacija: String(req.body?.lokacija || "").trim(),
      dnevniRed: String(req.body?.dnevniRed || "").trim(),
      status: "nacrtovana",
      ustvarilCode: req.user.code,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    const ref = await admin.firestore().collection("boardMeetings").add(doc);
    return res.json({ ok: true, id: ref.id });
  } catch (e) {
    return res.status(500).json({
      error: "Server error",
      detail: String(e?.stack || e?.message || e),
    });
  }
});

router.patch("/board/meetings/:id", requireAuth, requireBoardMember, async (req, res) => {
  try {
    const ldId = String(req.user?.ldId || "").trim();
    const id = String(req.params.id || "").trim();
    if (!id) return res.status(400).json({ error: "Missing id" });

    const ref = admin.firestore().collection("boardMeetings").doc(id);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ error: "Meeting not found" });
    if (String(snap.data()?.ldId || "") !== ldId) {
      return res.status(403).json({ error: "Forbidden (other LD)" });
    }

    const patch = {};
    if (req.body?.datum != null) patch.datum = req.body.datum;
    if (req.body?.lokacija != null) patch.lokacija = String(req.body.lokacija).trim();
    if (req.body?.dnevniRed != null) patch.dnevniRed = String(req.body.dnevniRed).trim();
    if (req.body?.status != null) {
      const validStatuses = ["nacrtovana", "v_teku", "zakljucena", "preklicana"];
      if (!validStatuses.includes(req.body.status)) {
        return res.status(400).json({ error: "Invalid status" });
      }
      patch.status = req.body.status;
    }
    patch.updatedAt = admin.firestore.FieldValue.serverTimestamp();

    await ref.set(patch, { merge: true });
    return res.json({ ok: true, id, patch });
  } catch (e) {
    return res.status(500).json({
      error: "Server error",
      detail: String(e?.stack || e?.message || e),
    });
  }
});

router.delete("/board/meetings/:id", requireAuth, requireBoardMember, async (req, res) => {
  try {
    const ldId = String(req.user?.ldId || "").trim();
    const id = String(req.params.id || "").trim();

    const ref = admin.firestore().collection("boardMeetings").doc(id);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ error: "Meeting not found" });
    if (String(snap.data()?.ldId || "") !== ldId) {
      return res.status(403).json({ error: "Forbidden (other LD)" });
    }

    await ref.delete();
    return res.json({ ok: true, id });
  } catch (e) {
    return res.status(500).json({
      error: "Server error",
      detail: String(e?.stack || e?.message || e),
    });
  }
});

/* ================= OPOMBE (koledar) ================= */

router.get("/board/notes", requireAuth, requireBoardMember, async (req, res) => {
  try {
    const ldId = String(req.user?.ldId || "").trim();
    const snap = await admin
      .firestore()
      .collection("boardNotes")
      .where("ldId", "==", ldId)
      .get();

    const notes = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    return res.json({ ok: true, notes });
  } catch (e) {
    return res.status(500).json({
      error: "Server error",
      detail: String(e?.stack || e?.message || e),
    });
  }
});

router.post("/board/notes", requireAuth, requireBoardMember, async (req, res) => {
  try {
    const ldId = String(req.user?.ldId || "").trim();
    if (!ldId) return res.status(400).json({ error: "Missing ldId in token." });

    const datum = req.body?.datum;
    const naslov = String(req.body?.naslov || "").trim();
    if (!datum) return res.status(400).json({ error: "Missing datum" });
    if (!naslov) return res.status(400).json({ error: "Missing naslov" });

    const doc = {
      ldId,
      datum,
      naslov,
      besedilo: String(req.body?.besedilo || "").trim(),
      ustvarilCode: req.user.code,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    const ref = await admin.firestore().collection("boardNotes").add(doc);
    return res.json({ ok: true, id: ref.id });
  } catch (e) {
    return res.status(500).json({
      error: "Server error",
      detail: String(e?.stack || e?.message || e),
    });
  }
});

router.patch("/board/notes/:id", requireAuth, requireBoardMember, async (req, res) => {
  try {
    const ldId = String(req.user?.ldId || "").trim();
    const id = String(req.params.id || "").trim();

    const ref = admin.firestore().collection("boardNotes").doc(id);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ error: "Note not found" });
    if (String(snap.data()?.ldId || "") !== ldId) {
      return res.status(403).json({ error: "Forbidden (other LD)" });
    }

    const patch = {};
    if (req.body?.datum != null) patch.datum = req.body.datum;
    if (req.body?.naslov != null) patch.naslov = String(req.body.naslov).trim();
    if (req.body?.besedilo != null) patch.besedilo = String(req.body.besedilo).trim();
    patch.updatedAt = admin.firestore.FieldValue.serverTimestamp();

    await ref.set(patch, { merge: true });
    return res.json({ ok: true, id, patch });
  } catch (e) {
    return res.status(500).json({
      error: "Server error",
      detail: String(e?.stack || e?.message || e),
    });
  }
});

router.delete("/board/notes/:id", requireAuth, requireBoardMember, async (req, res) => {
  try {
    const ldId = String(req.user?.ldId || "").trim();
    const id = String(req.params.id || "").trim();

    const ref = admin.firestore().collection("boardNotes").doc(id);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ error: "Note not found" });
    if (String(snap.data()?.ldId || "") !== ldId) {
      return res.status(403).json({ error: "Forbidden (other LD)" });
    }

    await ref.delete();
    return res.json({ ok: true, id });
  } catch (e) {
    return res.status(500).json({
      error: "Server error",
      detail: String(e?.stack || e?.message || e),
    });
  }
});

/* ================= ČLANI UO ================= */

router.get("/board/members", requireAuth, requireBoardMember, async (req, res) => {
  try {
    const ldId = String(req.user?.ldId || "").trim();

    const snap = await admin
      .firestore()
      .collection("hunters")
      .where("ldId", "==", ldId)
      .where("isBoardMember", "==", true)
      .get();

    const members = snap.docs.map((d) => {
      const data = d.data() || {};
      return { code: d.id, name: data.name || d.id };
    });

    // Novi (email) uporabniki: clanstvo je v "memberships", ime v "users"
    const msnap = await admin
      .firestore()
      .collection("memberships")
      .where("ldId", "==", ldId)
      .where("status", "==", "active")
      .where("isBoardMember", "==", true)
      .get();

    for (const md of msnap.docs) {
      const uid = String(md.data()?.uid || "").trim();
      if (!uid) continue;
      const u = await admin.firestore().collection("users").doc(uid).get();
      const ud = u.exists ? u.data() || {} : {};
      const full = `${ud.name || ""} ${ud.surname || ""}`.trim();
      members.push({ code: uid, name: full || ud.email || uid });
    }

    members.sort((a, b) => String(a.name).localeCompare(String(b.name), "sl"));

    return res.json({ ok: true, members });
  } catch (e) {
    return res.status(500).json({
      error: "Server error",
      detail: String(e?.stack || e?.message || e),
    });
  }
});

/* ================= PRISOTNOST ================= */

router.get(
  "/board/meetings/:id/attendance",
  requireAuth,
  requireBoardMember,
  async (req, res) => {
    try {
      const ldId = String(req.user?.ldId || "").trim();
      const meetingId = String(req.params.id || "").trim();

      const meetingRef = admin.firestore().collection("boardMeetings").doc(meetingId);
      const meetingSnap = await meetingRef.get();
      if (!meetingSnap.exists) return res.status(404).json({ error: "Meeting not found" });
      if (String(meetingSnap.data()?.ldId || "") !== ldId) {
        return res.status(403).json({ error: "Forbidden (other LD)" });
      }

      const snap = await admin
        .firestore()
        .collection("boardAttendance")
        .where("meetingId", "==", meetingId)
        .get();

      const attendance = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      return res.json({ ok: true, attendance });
    } catch (e) {
      return res.status(500).json({
        error: "Server error",
        detail: String(e?.stack || e?.message || e),
      });
    }
  }
);

router.post(
  "/board/meetings/:id/attendance",
  requireAuth,
  requireBoardMember,
  async (req, res) => {
    try {
      const ldId = String(req.user?.ldId || "").trim();
      const meetingId = String(req.params.id || "").trim();
      const memberCode = String(req.body?.memberCode || "").trim();
      const status = String(req.body?.status || "").trim();

      const validStatuses = ["prisoten", "opravicen", "odsoten"];
      if (!memberCode) return res.status(400).json({ error: "Missing memberCode" });
      if (!validStatuses.includes(status)) {
        return res.status(400).json({ error: "Invalid status" });
      }

      const meetingRef = admin.firestore().collection("boardMeetings").doc(meetingId);
      const meetingSnap = await meetingRef.get();
      if (!meetingSnap.exists) return res.status(404).json({ error: "Meeting not found" });
      if (String(meetingSnap.data()?.ldId || "") !== ldId) {
        return res.status(403).json({ error: "Forbidden (other LD)" });
      }

      const docId = `${meetingId}_${memberCode}`;
      const ref = admin.firestore().collection("boardAttendance").doc(docId);

      await ref.set(
        {
          meetingId,
          ldId,
          memberCode,
          status,
          opomba: String(req.body?.opomba || "").trim(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedByCode: req.user.code,
        },
        { merge: true }
      );

      return res.json({ ok: true, id: docId });
    } catch (e) {
      return res.status(500).json({
        error: "Server error",
        detail: String(e?.stack || e?.message || e),
      });
    }
  }
);

/* ================= ZAPISNIKI ================= */

async function nameForCode(code) {
  const c = String(code || "").trim();
  if (!c) return null;
  try {
    const h = await admin.firestore().collection("hunters").doc(c).get();
    if (h.exists) return String(h.data()?.name || c);
    const u = await admin.firestore().collection("users").doc(c).get();
    if (u.exists) return String(u.data()?.name || c);
  } catch {
    /* ignore */
  }
  return c;
}

function lockedResponse(res) {
  return res
    .status(409)
    .json({ error: "Zapisnik je potrjen in zaklenjen.", code: "LOCKED" });
}

router.get("/board/minutes", requireAuth, requireBoardMember, async (req, res) => {
  try {
    const ldId = String(req.user?.ldId || "").trim();
    const meetingId = req.query?.meetingId ? String(req.query.meetingId).trim() : null;

    let q = admin.firestore().collection("boardMinutes").where("ldId", "==", ldId);
    if (meetingId) q = q.where("meetingId", "==", meetingId);

    const snap = await q.get();
    const minutes = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    return res.json({ ok: true, minutes });
  } catch (e) {
    return res.status(500).json({
      error: "Server error",
      detail: String(e?.stack || e?.message || e),
    });
  }
});

router.get("/board/minutes/:id", requireAuth, requireBoardMember, async (req, res) => {
  try {
    const ldId = String(req.user?.ldId || "").trim();
    const id = String(req.params.id || "").trim();

    const snap = await admin.firestore().collection("boardMinutes").doc(id).get();
    if (!snap.exists) return res.status(404).json({ error: "Minutes not found" });
    const data = snap.data() || {};
    if (String(data.ldId || "") !== ldId) {
      return res.status(403).json({ error: "Forbidden (other LD)" });
    }

    const [potrdilByName, zadnjaSpremembaByName] = await Promise.all([
      nameForCode(data.potrdilByCode),
      nameForCode(data.zadnjaSpremembaByCode),
    ]);

    return res.json({
      ok: true,
      minutes: { id: snap.id, ...data, potrdilByName, zadnjaSpremembaByName },
    });
  } catch (e) {
    return res.status(500).json({
      error: "Server error",
      detail: String(e?.stack || e?.message || e),
    });
  }
});

router.post("/board/minutes", requireAuth, requireBoardMember, async (req, res) => {
  try {
    const ldId = String(req.user?.ldId || "").trim();
    if (!ldId) return res.status(400).json({ error: "Missing ldId in token." });

    const naslov = String(req.body?.naslov || "").trim();
    if (!naslov) return res.status(400).json({ error: "Missing naslov" });

    const meetingId = req.body?.meetingId ? String(req.body.meetingId).trim() : null;
    if (meetingId) {
      const meetingSnap = await admin.firestore().collection("boardMeetings").doc(meetingId).get();
      if (!meetingSnap.exists) return res.status(404).json({ error: "Meeting not found" });
      if (String(meetingSnap.data()?.ldId || "") !== ldId) {
        return res.status(403).json({ error: "Forbidden (other LD)" });
      }
    }

    // Nov zapisnik je lahko samo osnutek ali v potrjevanju; potrditev gre prek PATCH.
    let status = String(req.body?.status || "osnutek").trim();
    if (!["osnutek", "v_potrjevanju"].includes(status)) status = "osnutek";

    const doc = {
      ldId,
      meetingId,
      naslov,
      vsebina: String(req.body?.vsebina || ""),
      status,
      verzija: 1,
      ustvarilCode: req.user.code,
      zadnjaSpremembaByCode: req.user.code,
      zadnjaSpremembaDatum: admin.firestore.FieldValue.serverTimestamp(),
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    const ref = await admin.firestore().collection("boardMinutes").add(doc);
    return res.json({ ok: true, id: ref.id });
  } catch (e) {
    return res.status(500).json({
      error: "Server error",
      detail: String(e?.stack || e?.message || e),
    });
  }
});

router.patch("/board/minutes/:id", requireAuth, requireBoardMember, async (req, res) => {
  try {
    const ldId = String(req.user?.ldId || "").trim();
    const id = String(req.params.id || "").trim();

    const ref = admin.firestore().collection("boardMinutes").doc(id);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ error: "Minutes not found" });
    const cur = snap.data() || {};
    if (String(cur.ldId || "") !== ldId) {
      return res.status(403).json({ error: "Forbidden (other LD)" });
    }
    if (cur.status === "potrjen") return lockedResponse(res);

    const patch = {};
    if (req.body?.naslov != null) {
      const n = String(req.body.naslov).trim();
      if (!n) return res.status(400).json({ error: "Missing naslov" });
      patch.naslov = n;
    }
    if (req.body?.vsebina != null) patch.vsebina = String(req.body.vsebina);

    if (req.body?.status != null) {
      const validStatuses = ["osnutek", "v_potrjevanju", "potrjen"];
      if (!validStatuses.includes(req.body.status)) {
        return res.status(400).json({ error: "Invalid status" });
      }
      patch.status = req.body.status;
      if (req.body.status === "potrjen") {
        patch.potrdilByCode = req.user.code;
        patch.potrdilDatum = admin.firestore.FieldValue.serverTimestamp();
      }
    }

    if (req.body && "meetingId" in req.body) {
      const meetingId = req.body.meetingId ? String(req.body.meetingId).trim() : null;
      if (meetingId) {
        const meetingSnap = await admin.firestore().collection("boardMeetings").doc(meetingId).get();
        if (!meetingSnap.exists) return res.status(404).json({ error: "Meeting not found" });
        if (String(meetingSnap.data()?.ldId || "") !== ldId) {
          return res.status(403).json({ error: "Forbidden (other LD)" });
        }
      }
      patch.meetingId = meetingId;
    }

    patch.verzija = Number(cur.verzija || 0) + 1;
    patch.zadnjaSpremembaByCode = req.user.code;
    patch.zadnjaSpremembaDatum = admin.firestore.FieldValue.serverTimestamp();

    await ref.set(patch, { merge: true });
    return res.json({ ok: true, id, verzija: patch.verzija });
  } catch (e) {
    return res.status(500).json({
      error: "Server error",
      detail: String(e?.stack || e?.message || e),
    });
  }
});

router.post("/board/minutes/:id/copy", requireAuth, requireBoardMember, async (req, res) => {
  try {
    const ldId = String(req.user?.ldId || "").trim();
    const id = String(req.params.id || "").trim();

    const snap = await admin.firestore().collection("boardMinutes").doc(id).get();
    if (!snap.exists) return res.status(404).json({ error: "Minutes not found" });
    const src = snap.data() || {};
    if (String(src.ldId || "") !== ldId) {
      return res.status(403).json({ error: "Forbidden (other LD)" });
    }

    const doc = {
      ldId,
      meetingId: src.meetingId || null,
      naslov: `${String(src.naslov || "Zapisnik").trim()} (popravek)`,
      vsebina: String(src.vsebina || ""),
      status: "osnutek",
      verzija: 1,
      izvirnikId: id,
      ustvarilCode: req.user.code,
      zadnjaSpremembaByCode: req.user.code,
      zadnjaSpremembaDatum: admin.firestore.FieldValue.serverTimestamp(),
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    const ref = await admin.firestore().collection("boardMinutes").add(doc);
    return res.json({ ok: true, id: ref.id });
  } catch (e) {
    return res.status(500).json({
      error: "Server error",
      detail: String(e?.stack || e?.message || e),
    });
  }
});

router.delete("/board/minutes/:id", requireAuth, requireBoardMember, async (req, res) => {
  try {
    const ldId = String(req.user?.ldId || "").trim();
    const id = String(req.params.id || "").trim();

    const ref = admin.firestore().collection("boardMinutes").doc(id);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ error: "Minutes not found" });
    const cur = snap.data() || {};
    if (String(cur.ldId || "") !== ldId) {
      return res.status(403).json({ error: "Forbidden (other LD)" });
    }
    if (cur.status === "potrjen") return lockedResponse(res);

    await ref.delete();
    return res.json({ ok: true, id });
  } catch (e) {
    return res.status(500).json({
      error: "Server error",
      detail: String(e?.stack || e?.message || e),
    });
  }
});

/* ================= ODLOKI ================= */

const MOTION_STATUSES = ["predlog", "razprava", "sprejeto", "zavrnjeno", "umaknjeno"];
const MOTION_FINAL = ["sprejeto", "zavrnjeno", "umaknjeno"];

function motionLocked(res) {
  return res
    .status(409)
    .json({ error: "Odlok je zaključen in zaklenjen.", code: "LOCKED" });
}

async function loadMotion(req, res) {
  const ldId = String(req.user?.ldId || "").trim();
  const id = String(req.params.id || "").trim();
  const ref = admin.firestore().collection("boardMotions").doc(id);
  const snap = await ref.get();
  if (!snap.exists) {
    res.status(404).json({ error: "Motion not found" });
    return null;
  }
  const data = snap.data() || {};
  if (String(data.ldId || "") !== ldId) {
    res.status(403).json({ error: "Forbidden (other LD)" });
    return null;
  }
  return { ref, data, id };
}

async function meetingOkForLd(meetingId, ldId, res) {
  const snap = await admin.firestore().collection("boardMeetings").doc(meetingId).get();
  if (!snap.exists) {
    res.status(404).json({ error: "Meeting not found" });
    return false;
  }
  if (String(snap.data()?.ldId || "") !== ldId) {
    res.status(403).json({ error: "Forbidden (other LD)" });
    return false;
  }
  return true;
}

router.get("/board/motions", requireAuth, requireBoardMember, async (req, res) => {
  try {
    const ldId = String(req.user?.ldId || "").trim();
    const snap = await admin
      .firestore()
      .collection("boardMotions")
      .where("ldId", "==", ldId)
      .get();
    const motions = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    return res.json({ ok: true, motions });
  } catch (e) {
    return res.status(500).json({
      error: "Server error",
      detail: String(e?.stack || e?.message || e),
    });
  }
});

router.get("/board/motions/:id", requireAuth, requireBoardMember, async (req, res) => {
  try {
    const m = await loadMotion(req, res);
    if (!m) return;

    const [zadnjaSpremembaByName, zakljucilByName] = await Promise.all([
      nameForCode(m.data.zadnjaSpremembaByCode),
      nameForCode(m.data.zakljucilByCode),
    ]);

    return res.json({
      ok: true,
      motion: { id: m.id, ...m.data, zadnjaSpremembaByName, zakljucilByName },
    });
  } catch (e) {
    return res.status(500).json({
      error: "Server error",
      detail: String(e?.stack || e?.message || e),
    });
  }
});

router.post("/board/motions", requireAuth, requireBoardMember, async (req, res) => {
  try {
    const ldId = String(req.user?.ldId || "").trim();
    if (!ldId) return res.status(400).json({ error: "Missing ldId in token." });

    const naslov = String(req.body?.naslov || "").trim();
    if (!naslov) return res.status(400).json({ error: "Missing naslov" });

    const meetingId = req.body?.meetingId ? String(req.body.meetingId).trim() : null;
    if (meetingId && !(await meetingOkForLd(meetingId, ldId, res))) return;

    // Nov odlok je lahko samo predlog ali v razpravi; zaključek gre prek PATCH.
    let status = String(req.body?.status || "predlog").trim();
    if (!["predlog", "razprava"].includes(status)) status = "predlog";

    const doc = {
      ldId,
      meetingId,
      naslov,
      vsebina: String(req.body?.vsebina || ""),
      status,
      verzija: 1,
      steviloKomentarjev: 0,
      ustvarilCode: req.user.code,
      zadnjaSpremembaByCode: req.user.code,
      zadnjaSpremembaDatum: admin.firestore.FieldValue.serverTimestamp(),
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    const ref = await admin.firestore().collection("boardMotions").add(doc);
    return res.json({ ok: true, id: ref.id });
  } catch (e) {
    return res.status(500).json({
      error: "Server error",
      detail: String(e?.stack || e?.message || e),
    });
  }
});

router.patch("/board/motions/:id", requireAuth, requireBoardMember, async (req, res) => {
  try {
    const ldId = String(req.user?.ldId || "").trim();
    const m = await loadMotion(req, res);
    if (!m) return;
    const cur = m.data;
    if (MOTION_FINAL.includes(cur.status)) return motionLocked(res);

    const patch = {};
    let textChanged = false;

    if (req.body?.naslov != null) {
      const n = String(req.body.naslov).trim();
      if (!n) return res.status(400).json({ error: "Missing naslov" });
      if (n !== cur.naslov) textChanged = true;
      patch.naslov = n;
    }
    if (req.body?.vsebina != null) {
      const v = String(req.body.vsebina);
      if (v !== String(cur.vsebina || "")) textChanged = true;
      patch.vsebina = v;
    }

    const curVerzija = Number(cur.verzija || 0);
    const clientVerzija = req.body?.verzija != null ? Number(req.body.verzija) : null;
    if (textChanged && clientVerzija !== null && clientVerzija !== curVerzija) {
      return res.status(409).json({
        error: "Odlok je medtem uredil drug član. Zapri okno in ga odpri znova, da vidiš zadnjo verzijo.",
        code: "CONFLICT",
      });
    }

    if (req.body?.status != null) {
      if (!MOTION_STATUSES.includes(req.body.status)) {
        return res.status(400).json({ error: "Invalid status" });
      }
      patch.status = req.body.status;
      if (MOTION_FINAL.includes(req.body.status)) {
        patch.zakljucilByCode = req.user.code;
        patch.zakljucenDatum = admin.firestore.FieldValue.serverTimestamp();
      }
    }

    if (req.body && "meetingId" in req.body) {
      const meetingId = req.body.meetingId ? String(req.body.meetingId).trim() : null;
      if (meetingId && !(await meetingOkForLd(meetingId, ldId, res))) return;
      patch.meetingId = meetingId;
    }

    if (textChanged) patch.verzija = curVerzija + 1;
    patch.zadnjaSpremembaByCode = req.user.code;
    patch.zadnjaSpremembaDatum = admin.firestore.FieldValue.serverTimestamp();

    await m.ref.set(patch, { merge: true });
    return res.json({ ok: true, id: m.id, verzija: patch.verzija ?? curVerzija });
  } catch (e) {
    return res.status(500).json({
      error: "Server error",
      detail: String(e?.stack || e?.message || e),
    });
  }
});

router.post("/board/motions/:id/copy", requireAuth, requireBoardMember, async (req, res) => {
  try {
    const ldId = String(req.user?.ldId || "").trim();
    const m = await loadMotion(req, res);
    if (!m) return;
    const src = m.data;
    if (!MOTION_FINAL.includes(src.status)) {
      return res.status(400).json({ error: "Odlok še ni zaključen." });
    }

    const doc = {
      ldId,
      meetingId: src.meetingId || null,
      naslov: `${String(src.naslov || "Odlok").trim()} (popravek)`,
      vsebina: String(src.vsebina || ""),
      status: "predlog",
      verzija: 1,
      steviloKomentarjev: 0,
      izvirnikId: m.id,
      ustvarilCode: req.user.code,
      zadnjaSpremembaByCode: req.user.code,
      zadnjaSpremembaDatum: admin.firestore.FieldValue.serverTimestamp(),
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    const ref = await admin.firestore().collection("boardMotions").add(doc);
    return res.json({ ok: true, id: ref.id });
  } catch (e) {
    return res.status(500).json({
      error: "Server error",
      detail: String(e?.stack || e?.message || e),
    });
  }
});

router.delete("/board/motions/:id", requireAuth, requireBoardMember, async (req, res) => {
  try {
    const m = await loadMotion(req, res);
    if (!m) return;
    if (MOTION_FINAL.includes(m.data.status)) return motionLocked(res);

    const hasComments = await admin
      .firestore()
      .collection("boardMotionComments")
      .where("motionId", "==", m.id)
      .limit(1)
      .get();
    if (!hasComments.empty) {
      return res.status(409).json({
        error: "Odloka z razpravo ni mogoče izbrisati.",
        code: "HAS_COMMENTS",
      });
    }

    await m.ref.delete();
    return res.json({ ok: true, id: m.id });
  } catch (e) {
    return res.status(500).json({
      error: "Server error",
      detail: String(e?.stack || e?.message || e),
    });
  }
});

router.get(
  "/board/motions/:id/comments",
  requireAuth,
  requireBoardMember,
  async (req, res) => {
    try {
      const m = await loadMotion(req, res);
      if (!m) return;

      const snap = await admin
        .firestore()
        .collection("boardMotionComments")
        .where("motionId", "==", m.id)
        .get();

      const raw = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      raw.sort(
        (a, b) => (a.createdAt?.toMillis?.() || 0) - (b.createdAt?.toMillis?.() || 0)
      );

      const codes = [...new Set(raw.map((c) => c.avtorCode).filter(Boolean))];
      const names = {};
      await Promise.all(
        codes.map(async (c) => {
          names[c] = await nameForCode(c);
        })
      );

      const comments = raw.map((c) => ({ ...c, avtorName: names[c.avtorCode] || c.avtorCode }));
      return res.json({ ok: true, comments });
    } catch (e) {
      return res.status(500).json({
        error: "Server error",
        detail: String(e?.stack || e?.message || e),
      });
    }
  }
);

router.post(
  "/board/motions/:id/comments",
  requireAuth,
  requireBoardMember,
  async (req, res) => {
    try {
      const ldId = String(req.user?.ldId || "").trim();
      const id = String(req.params.id || "").trim();

      const besedilo = String(req.body?.besedilo || "").trim();
      if (!besedilo) return res.status(400).json({ error: "Komentar je prazen." });
      if (besedilo.length > 2000) {
        return res.status(400).json({ error: "Komentar je predolg (največ 2000 znakov)." });
      }
      const parentId = req.body?.odgovorNaId ? String(req.body.odgovorNaId).trim() : null;

      const db = admin.firestore();
      const motionRef = db.collection("boardMotions").doc(id);
      const commentRef = db.collection("boardMotionComments").doc();
      let outcome = null;

      await db.runTransaction(async (tx) => {
        const snap = await tx.get(motionRef);
        if (!snap.exists) {
          outcome = { status: 404, body: { error: "Motion not found" } };
          return;
        }
        const cur = snap.data() || {};
        if (String(cur.ldId || "") !== ldId) {
          outcome = { status: 403, body: { error: "Forbidden (other LD)" } };
          return;
        }
        if (MOTION_FINAL.includes(cur.status)) {
          outcome = {
            status: 409,
            body: { error: "Razprava je zaprta, ker je odlok zaključen.", code: "CLOSED" },
          };
          return;
        }

        let rootId = null;
        if (parentId) {
          const pSnap = await tx.get(db.collection("boardMotionComments").doc(parentId));
          const p = pSnap.exists ? pSnap.data() || {} : null;
          if (!p || p.motionId !== id) {
            outcome = { status: 404, body: { error: "Parent comment not found" } };
            return;
          }
          rootId = p.odgovorNaId || parentId;
        }

        tx.set(commentRef, {
          motionId: id,
          ldId,
          besedilo,
          odgovorNaId: rootId,
          odlokVerzija: Number(cur.verzija || 1),
          avtorCode: req.user.code,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        tx.update(motionRef, {
          steviloKomentarjev: admin.firestore.FieldValue.increment(1),
        });
      });

      if (outcome) return res.status(outcome.status).json(outcome.body);
      return res.json({ ok: true, id: commentRef.id });
    } catch (e) {
      return res.status(500).json({
        error: "Server error",
        detail: String(e?.stack || e?.message || e),
      });
    }
  }
);

module.exports = router;

    