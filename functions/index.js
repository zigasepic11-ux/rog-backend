const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const logger = require("firebase-functions/logger");
const { defineSecret } = require("firebase-functions/params");
const { randomBytes } = require("crypto");
const nodemailer = require("nodemailer");
const admin = require("firebase-admin");
const { getFirestore, FieldValue, Timestamp } = require("firebase-admin/firestore");

admin.initializeApp();

const RESEND_API_KEY = defineSecret("RESEND_API_KEY");
const SMTP_PASSWORD = defineSecret("SMTP_PASSWORD");

const INVITE_EXPIRY_HOURS = 48;

// Vizualna osnova usklajena z DEJANSKO identiteto portala (theme.css/App.css):
// topla krem/bež ozadja, rjava kot glavna barva (ne zelena), brez pretirane
// "SaaS predloge" estetike (manj senc, manj emoji, bolj umirjeno).
const ROG_COLORS = {
  brown: "#6B4E2E",
  brownBorder: "#D9CBB8",
  cream: "#F5EFE2",
  cardBg: "#FFFFFF",
  text: "#2B2B2B",
  muted: "#8A7A66",
};

function emailWrapper(bodyHtml) {
  return `<!DOCTYPE html>
<html lang="sl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin:0; padding:0;">
  <div style="background-color:${ROG_COLORS.cream}; padding:36px 16px; font-family:-apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif;">
    <div style="max-width:460px; margin:0 auto; background:${ROG_COLORS.cardBg}; border:1px solid ${ROG_COLORS.brownBorder}; border-radius:18px;">
      <div style="padding:20px 26px; text-align:center; border-bottom:1px solid ${ROG_COLORS.brownBorder};">
        <span style="color:${ROG_COLORS.brown}; font-size:16px; font-weight:900; letter-spacing:4px;">🌲&nbsp;&nbsp;ROG</span>
      </div>
      <div style="padding:30px 28px; color:${ROG_COLORS.text}; font-size:15px; line-height:1.6;">
        ${bodyHtml}
      </div>
      <div style="padding:14px 28px 22px; text-align:center;">
        <div style="border-top:1px solid ${ROG_COLORS.brownBorder}; padding-top:14px; font-size:12px; color:${ROG_COLORS.muted};">
          ROG Sistem — digitalna platforma za lovske družine
        </div>
      </div>
    </div>
  </div>
</body>
</html>`;
}

function emailButton(url, label) {
  return `<div style="text-align:center; margin:24px 0 8px;">
    <a href="${url}" style="display:inline-block; background-color:${ROG_COLORS.brown}; color:#ffffff; text-decoration:none; padding:14px 32px; border-radius:14px; font-weight:700; font-size:15px;">${label}</a>
  </div>`;
}

function buildTransporter(smtpPassword) {
  return nodemailer.createTransport({
    host: "mail.rog-sistem.si",
    port: 465,
    secure: true,
    auth: {
      user: "info@rog-sistem.si",
      pass: smtpPassword,
    },
  });
}

function buildWelcomeEmailHtml({ name, ldName }) {
  const body = `
    <h2 style="color:${ROG_COLORS.brown}; margin-top:0; margin-bottom:14px; font-size:19px;">Dobrodošli, ${name || ""}.</h2>
    <p>Vaš račun za lovsko družino <strong>${ldName}</strong> je uspešno aktiviran.</p>
    <p>Odslej se lahko prijavite v ROG Sistem z vašim emailom in PIN-om, ki ste ga pravkar nastavili.</p>
    ${emailButton("https://rog-sistem.si/", "Pojdi na prijavo")}
    <p style="font-size:13px; color:${ROG_COLORS.muted}; margin-bottom:0;">Če imate kakršnakoli vprašanja, se obrnite na moderatorja vaše lovske družine.</p>
  `;
  return emailWrapper(body);
}

function buildInviteEmailHtml({ name, ldId, inviteUrl }) {
  const body = `
    <h2 style="color:${ROG_COLORS.brown}; margin-top:0; margin-bottom:14px; font-size:19px;">Vabilo v ROG Sistem</h2>
    <p>Pozdravljeni ${name || ""},</p>
    <p>Povabljeni ste v lovsko družino <strong>${ldId}</strong> na ROG Sistemu.</p>
    <p>Za dokončanje registracije kliknite spodnji gumb in si nastavite svoj PIN:</p>
    ${emailButton(inviteUrl, "Nastavi PIN")}
    <p style="font-size:13px; color:${ROG_COLORS.muted};">Povezava je veljavna ${INVITE_EXPIRY_HOURS} ur.</p>
    <div style="height:1px; background-color:${ROG_COLORS.brownBorder}; margin:20px 0;"></div>
    <p style="font-size:13px; color:${ROG_COLORS.muted}; margin-bottom:0;">Če tega vabila niste pričakovali, lahko to sporočilo prezrete.</p>
  `;
  return emailWrapper(body);
}

/**
 * Preveri, ali sme klicatelj povabiti nove člane v dano LD.
 * Dovoljeno: super-admin (custom claim role == "super"/"admin"), ali
 * aktiven moderator te konkretne LD (memberships dokument, role "moderator"/"super").
 */
async function callerCanInvite(callerUid, callerToken, ldId, db) {
  const claimRole = callerToken && callerToken.role;
  if (claimRole === "super" || claimRole === "admin") {
    return true;
  }

  // Legacy (star sistem) moderator: custom token nosi role+ldId neposredno
  // (glej auth.routes.js /auth/login, firebaseClaims), brez membership dokumenta.
  if (claimRole === "moderator" && callerToken.ldId === ldId) {
    return true;
  }

  const callerMembershipSnap = await db
    .collection("memberships")
    .doc(`${callerUid}_${ldId}`)
    .get();

  if (!callerMembershipSnap.exists) {
    return false;
  }

  const callerMembership = callerMembershipSnap.data();
  return (
    callerMembership.status === "active" &&
    (callerMembership.role === "moderator" || callerMembership.role === "super")
  );
}

exports.sendContactNotification = onDocumentCreated(
  {
    document: "contact_requests/{docId}",
    secrets: [RESEND_API_KEY],
  },
  async (event) => {
    try {
      const doc = event.data.data();
      const apiKey = RESEND_API_KEY.value();
      const response = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: "ROG Kontakt <onboarding@resend.dev>",
          to: ["zigasepic11@gmail.com"],
          subject: `Novo povpraševanje — ${doc.type || "Kontakt"}`,
          html: `
            <h2>Novo povpraševanje iz ROG portala</h2>
            <p><strong>Ime:</strong> ${doc.name || "-"}</p>
            <p><strong>Lovska družina:</strong> ${doc.huntingClub || "-"}</p>
            <p><strong>Email:</strong> ${doc.email || "-"}</p>
            <p><strong>Telefon:</strong> ${doc.phone || "-"}</p>
            <p><strong>Vrsta:</strong> ${doc.type || "-"}</p>
            <hr>
            <p><strong>Sporočilo:</strong></p>
            <p>${doc.message || "-"}</p>
          `,
        }),
      });
      const data = await response.json();
      logger.info("Email sent:", data);
    } catch (error) {
      logger.error("Error sending email:", error);
    }
  }
);

exports.sendBugReportNotification = onDocumentCreated(
  {
    document: "bug_reports/{docId}",
    secrets: [RESEND_API_KEY],
  },
  async (event) => {
    try {
      const doc = event.data.data();
      const apiKey = RESEND_API_KEY.value();
      const response = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: "ROG Napake <onboarding@resend.dev>",
          to: ["zigasepic11@gmail.com"],
          subject: `Nova prijava napake — ${doc.priority || "Brez prioritete"}`,
          html: `
            <h2>Nova prijava napake iz ROG portala</h2>
            <p><strong>Ime:</strong> ${doc.name || "-"}</p>
            <p><strong>Email:</strong> ${doc.email || "-"}</p>
            <p><strong>Naprava:</strong> ${doc.device || "-"}</p>
            <p><strong>Del sistema:</strong> ${doc.pageOrFeature || "-"}</p>
            <p><strong>Pomembnost:</strong> ${doc.priority || "-"}</p>
            <hr>
            <p><strong>Opis napake:</strong></p>
            <p>${doc.description || "-"}</p>
            <hr>
            <p><strong>Stran:</strong> ${doc.page || "-"}</p>
            <p><strong>User agent:</strong> ${doc.userAgent || "-"}</p>
          `,
        }),
      });
      const data = await response.json();
      logger.info("Bug report email sent:", data);
    } catch (error) {
      logger.error("Error sending bug report email:", error);
    }
  }
);

/**
 * performInvite — skupna jedrna logika za povabilo enega uporabnika,
 * ki jo delita `inviteMember` (ročno, eden naenkrat) in
 * `bulkInviteLegacyMembers` (migracija, več naenkrat). NE preverja
 * pravic - to mora narediti klicatelj PRED klicem te funkcije.
 *
 * Vrže HttpsError pri napaki (already-exists, internal), ali vrne
 * { uid, membershipId, isNewUser } pri uspehu.
 */
async function performInvite({
  callerUid,
  ldId,
  ldName,
  email,
  name,
  surname,
  role,
  legacyMemberId,
  auditAction,
  auditDetails,
  db,
}) {
  const normalizedEmail = String(email).trim().toLowerCase();

  let userRecord;
  let isNewUser = false;
  try {
    userRecord = await admin.auth().getUserByEmail(normalizedEmail);
  } catch (err) {
    if (err.code === "auth/user-not-found") {
      userRecord = await admin.auth().createUser({
        email: normalizedEmail,
        emailVerified: false,
        disabled: false,
      });
      isNewUser = true;
    } else {
      logger.error("Napaka pri iskanju uporabnika:", err);
      throw new HttpsError("internal", "Napaka pri preverjanju uporabnika.");
    }
  }

  const uid = userRecord.uid;
  const membershipId = `${uid}_${ldId}`;
  const membershipRef = db.collection("memberships").doc(membershipId);

  const existingMembership = await membershipRef.get();
  if (existingMembership.exists) {
    const status = existingMembership.data().status;
    if (status === "active") {
      throw new HttpsError(
        "already-exists",
        "Ta oseba je že aktivni član te lovske družine."
      );
    }
  }

  if (isNewUser || legacyMemberId) {
    await db.collection("users").doc(uid).set(
      {
        email: normalizedEmail,
        name: name || "",
        surname: surname || "",
        legacyMemberId: legacyMemberId || null,
        emso: null,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
  }

  const inviteToken = randomBytes(32).toString("hex");
  const now = Timestamp.now();
  const expiresAt = Timestamp.fromMillis(
    now.toMillis() + INVITE_EXPIRY_HOURS * 60 * 60 * 1000
  );

  await membershipRef.set(
    {
      uid,
      ldId,
      role,
      status: "invited",
      inviteToken,
      invitedBy: callerUid,
      invitedAt: now,
      expiresAt,
      confirmedAt: null,
      termsVersion: null,
      termsAcceptedAt: null,
      deactivatedBy: null,
      deactivatedAt: null,
      createdAt: existingMembership.exists
        ? existingMembership.data().createdAt
        : now,
      updatedAt: now,
    },
    { merge: true }
  );

  const inviteUrl = `https://rog-sistem.si/potrdi-vabilo?token=${inviteToken}&membership=${membershipId}`;
  const transporter = buildTransporter(SMTP_PASSWORD.value());

  try {
    await transporter.sendMail({
      from: '"ROG Sistem" <info@rog-sistem.si>',
      to: normalizedEmail,
      subject: `Vabilo v lovsko družino ${ldName} — ROG Sistem`,
      html: buildInviteEmailHtml({ name, ldId: ldName, inviteUrl }),
    });
  } catch (err) {
    logger.error("Napaka pri pošiljanju invite emaila:", err);
    throw new HttpsError(
      "internal",
      "Membership je bil ustvarjen, ampak pošiljanje emaila ni uspelo."
    );
  }

  await db.collection("auditLog").add({
    action: auditAction || "invite_sent",
    performedBy: callerUid,
    targetUid: uid,
    ldId,
    timestamp: now,
    details: { email: normalizedEmail, isNewUser, ...(auditDetails || {}) },
  });

  return { uid, membershipId, isNewUser };
}

/**
 * inviteMember — pokliče moderator/super-admin iz portala.
 * Ustvari (ali poveže na obstoječega) Firebase Auth uporabnika in
 * membership dokument s statusom "invited", nato pošlje invite email.
 *
 * data: { ldId: string, email: string, name: string, surname: string }
 */
exports.inviteMember = onCall(
  { secrets: [SMTP_PASSWORD] },
  async (request) => {
    const callerUid = request.auth && request.auth.uid;
    if (!callerUid) {
      throw new HttpsError("unauthenticated", "Prijava je obvezna.");
    }

    const { ldId, email, name, surname, role: requestedRole } = request.data || {};
    if (!ldId || !email) {
      throw new HttpsError("invalid-argument", "ldId in email sta obvezna.");
    }

    // Samo "member" in "moderator" se smeta dodeliti preko povabila -
    // "super" vloga ni dosegljiva preko tega kanala (prepreči eskalacijo pravic).
    const role = requestedRole === "moderator" ? "moderator" : "member";

    const db = getFirestore();

    // Preverba pravic: samo super-admin ali aktiven moderator te LD
    const allowed = await callerCanInvite(
      callerUid,
      request.auth.token,
      ldId,
      db
    );
    if (!allowed) {
      throw new HttpsError(
        "permission-denied",
        "Nimate pravic za povabilo članov v to lovsko družino."
      );
    }

    // Poišči berljivo ime LD za uporabo v emailu (namesto surovega ldId slug-a)
    const ldDoc = await db.collection("lds").doc(ldId).get();
    const ldName = ldDoc.exists ? ldDoc.data().name : ldId;

    const result = await performInvite({
      callerUid,
      ldId,
      ldName,
      email,
      name,
      surname,
      role,
      legacyMemberId: null,
      auditAction: "invite_sent",
      db,
    });

    return { success: true, ...result };
  }
);

/**
 * bulkInviteLegacyMembers — pokliče moderator/super-admin, za MIGRACIJO
 * obstoječih (starih ID+PIN) uporabnikov na nov email+PIN sistem.
 * Sprejme seznam { code, email } parov - za vsak poišče obstoječega
 * "hunters/{code}" (ime, vloga), in mu pošlje standardno invite povabilo,
 * s povezavo nazaj na star profil preko legacyMemberId.
 *
 * data: { ldId: string, pairs: [{ code: string, email: string }] }
 */
exports.bulkInviteLegacyMembers = onCall(
  { secrets: [SMTP_PASSWORD] },
  async (request) => {
    const callerUid = request.auth && request.auth.uid;
    if (!callerUid) {
      throw new HttpsError("unauthenticated", "Prijava je obvezna.");
    }

    const { ldId, pairs } = request.data || {};
    if (!ldId || !Array.isArray(pairs) || pairs.length === 0) {
      throw new HttpsError(
        "invalid-argument",
        "ldId in neprazen seznam pairs sta obvezna."
      );
    }
    if (pairs.length > 200) {
      throw new HttpsError(
        "invalid-argument",
        "Naenkrat je mogoče uvoziti največ 200 članov."
      );
    }

    const db = getFirestore();

    const allowed = await callerCanInvite(callerUid, request.auth.token, ldId, db);
    if (!allowed) {
      throw new HttpsError(
        "permission-denied",
        "Nimate pravic za migracijo članov te lovske družine."
      );
    }

    const ldDoc = await db.collection("lds").doc(ldId).get();
    const ldName = ldDoc.exists ? ldDoc.data().name : ldId;

    const results = [];

    for (const pair of pairs) {
      const code = String(pair?.code || "").trim();
      const email = String(pair?.email || "").trim();

      if (!code || !email) {
        results.push({ code, email, status: "error", reason: "Manjka koda ali email." });
        continue;
      }

      try {
        const hunterSnap = await db.collection("hunters").doc(code).get();
        if (!hunterSnap.exists) {
          results.push({ code, email, status: "error", reason: "Koda ne obstaja v starem sistemu." });
          continue;
        }

        const hunter = hunterSnap.data();
        if (String(hunter.ldId || "") !== ldId) {
          results.push({ code, email, status: "error", reason: "Koda pripada drugi LD." });
          continue;
        }

        // Varnostna omejitev: bulk migracija dodeli samo "member" ali
        // "moderator" - nikoli "super"/"admin", ne glede na staro vlogo
        const role = hunter.role === "moderator" ? "moderator" : "member";
        const [name, ...surnameParts] = String(hunter.name || "").trim().split(" ");
        const surname = surnameParts.join(" ");

        const inviteResult = await performInvite({
          callerUid,
          ldId,
          ldName,
          email,
          name: name || "",
          surname: surname || "",
          role,
          legacyMemberId: code,
          auditAction: "bulk_invite_sent",
          auditDetails: { legacyCode: code },
          db,
        });

        results.push({ code, email, status: "sent", ...inviteResult });
      } catch (err) {
        results.push({
          code,
          email,
          status: "error",
          reason: err.message || "Neznana napaka.",
        });
      }
    }

    return { success: true, results };
  }
);

/**
 * confirmInvite — pokliče neprijavljena oseba, ki je kliknila invite link.
 * Validira token, nastavi PIN (Firebase Auth geslo), potrdi ToU,
 * membership status invited -> active.
 *
 * data: { membershipId: string, token: string, pin: string,
 *          termsAccepted: boolean, termsVersion: string }
 */
exports.confirmInvite = onCall({ secrets: [SMTP_PASSWORD] }, async (request) => {
  const { membershipId, token, pin, termsAccepted, termsVersion } =
    request.data || {};

  if (!membershipId || !token || !pin) {
    throw new HttpsError(
      "invalid-argument",
      "membershipId, token in pin so obvezni."
    );
  }
  if (typeof pin !== "string" || pin.length < 6) {
    throw new HttpsError(
      "invalid-argument",
      "PIN mora imeti vsaj 6 znakov."
    );
  }
  if (!termsAccepted || !termsVersion) {
    throw new HttpsError(
      "invalid-argument",
      "Potrditev pogojev uporabe je obvezna."
    );
  }

  const db = getFirestore();
  const membershipRef = db.collection("memberships").doc(membershipId);
  const membershipSnap = await membershipRef.get();

  if (!membershipSnap.exists) {
    throw new HttpsError("not-found", "Povabilo ne obstaja.");
  }

  const membership = membershipSnap.data();

  if (membership.status === "active") {
    throw new HttpsError(
      "already-exists",
      "To povabilo je že bilo potrjeno."
    );
  }
  if (membership.status === "deactivated") {
    throw new HttpsError("permission-denied", "Ta članstvo je deaktivirano.");
  }
  if (membership.inviteToken !== token) {
    throw new HttpsError("permission-denied", "Neveljaven token povabila.");
  }

  const now = Timestamp.now();
  if (membership.expiresAt.toMillis() < now.toMillis()) {
    await membershipRef.update({ status: "expired", updatedAt: now });
    throw new HttpsError(
      "deadline-exceeded",
      "Povabilo je poteklo. Prosite moderatorja za novo povabilo."
    );
  }

  // Nastavi PIN kot Firebase Auth geslo
  try {
    await admin.auth().updateUser(membership.uid, { password: pin });
  } catch (err) {
    logger.error("Napaka pri nastavitvi PIN-a:", err);
    throw new HttpsError("internal", "Napaka pri nastavitvi PIN-a.");
  }

  // Aktiviraj membership, odstrani token (enkratna uporaba)
  await membershipRef.update({
    status: "active",
    confirmedAt: now,
    termsVersion,
    termsAcceptedAt: now,
    inviteToken: FieldValue.delete(),
    updatedAt: now,
  });

  await db.collection("auditLog").add({
    action: "invite_confirmed",
    performedBy: membership.uid,
    targetUid: membership.uid,
    ldId: membership.ldId,
    timestamp: now,
    details: { membershipId },
  });

  // Pošlji "Dobrodošli" email (best-effort - napaka tukaj NE sme
  // preprečiti uspešne aktivacije, ki se je že zgodila zgoraj)
  try {
    const userDoc = await db.collection("users").doc(membership.uid).get();
    const name = userDoc.exists ? userDoc.data().name : "";

    const ldDoc = await db.collection("lds").doc(membership.ldId).get();
    const ldName = ldDoc.exists ? ldDoc.data().name : membership.ldId;

    const userRecord = await admin.auth().getUser(membership.uid);

    const transporter = buildTransporter(SMTP_PASSWORD.value());
    await transporter.sendMail({
      from: '"ROG Sistem" <info@rog-sistem.si>',
      to: userRecord.email,
      subject: `Dobrodošli v ROG Sistem — ${ldName}`,
      html: buildWelcomeEmailHtml({ name, ldName }),
    });
  } catch (err) {
    logger.error("Napaka pri pošiljanju 'Dobrodošli' emaila (ne kritično):", err);
  }

  return { success: true };
});

const RESEND_COOLDOWN_MINUTES = 5;

/**
 * resendInvite — pokliče moderator/super-admin. Regenerira token in
 * podaljša veljavnost obstoječega povabila, z upoštevanjem cooldowna.
 *
 * data: { membershipId: string }
 */
exports.resendInvite = onCall(
  { secrets: [SMTP_PASSWORD] },
  async (request) => {
    const callerUid = request.auth && request.auth.uid;
    if (!callerUid) {
      throw new HttpsError("unauthenticated", "Prijava je obvezna.");
    }

    const { membershipId } = request.data || {};
    if (!membershipId) {
      throw new HttpsError("invalid-argument", "membershipId je obvezen.");
    }

    const db = getFirestore();
    const membershipRef = db.collection("memberships").doc(membershipId);
    const membershipSnap = await membershipRef.get();

    if (!membershipSnap.exists) {
      throw new HttpsError("not-found", "Povabilo ne obstaja.");
    }

    const membership = membershipSnap.data();

    // Preverba pravic - enaka logika kot pri inviteMember, samo za LD tega membershipa
    const allowed = await callerCanInvite(
      callerUid,
      request.auth.token,
      membership.ldId,
      db
    );
    if (!allowed) {
      throw new HttpsError(
        "permission-denied",
        "Nimate pravic za ponovno pošiljanje povabila v to lovsko družino."
      );
    }

    if (membership.status === "active") {
      throw new HttpsError(
        "already-exists",
        "Ta oseba je že aktivni član - ponovno povabilo ni potrebno."
      );
    }
    if (membership.status === "deactivated") {
      throw new HttpsError(
        "permission-denied",
        "Ta članstvo je deaktivirano, ponovno povabilo ni mogoče."
      );
    }

    // Cooldown: prepreči spam ponovnih povabil
    const now = Timestamp.now();
    if (membership.invitedAt) {
      const minutesSinceLastInvite =
        (now.toMillis() - membership.invitedAt.toMillis()) / 1000 / 60;
      if (minutesSinceLastInvite < RESEND_COOLDOWN_MINUTES) {
        const waitMinutes = Math.ceil(
          RESEND_COOLDOWN_MINUTES - minutesSinceLastInvite
        );
        throw new HttpsError(
          "resource-exhausted",
          `Počakajte še ${waitMinutes} min pred ponovnim pošiljanjem.`
        );
      }
    }

    // Pridobi email uporabnika za ponovno pošiljanje
    let userRecord;
    try {
      userRecord = await admin.auth().getUser(membership.uid);
    } catch (err) {
      logger.error("Napaka pri iskanju uporabnika:", err);
      throw new HttpsError("internal", "Napaka pri iskanju uporabnika.");
    }
    const normalizedEmail = userRecord.email;

    let userDoc = await db.collection("users").doc(membership.uid).get();
    const name = userDoc.exists ? userDoc.data().name : "";

    const ldDoc = await db.collection("lds").doc(membership.ldId).get();
    const ldName = ldDoc.exists ? ldDoc.data().name : membership.ldId;

    // Generiraj nov token, podaljšaj veljavnost
    const inviteToken = randomBytes(32).toString("hex");
    const expiresAt = Timestamp.fromMillis(
      now.toMillis() + INVITE_EXPIRY_HOURS * 60 * 60 * 1000
    );

    await membershipRef.update({
      status: "invited",
      inviteToken,
      invitedBy: callerUid,
      invitedAt: now,
      expiresAt,
      updatedAt: now,
    });

    const inviteUrl = `https://rog-sistem.si/potrdi-vabilo?token=${inviteToken}&membership=${membershipId}`;
    const transporter = buildTransporter(SMTP_PASSWORD.value());

    try {
      await transporter.sendMail({
        from: '"ROG Sistem" <info@rog-sistem.si>',
        to: normalizedEmail,
        subject: `Ponovno vabilo v lovsko družino ${ldName} — ROG Sistem`,
        html: buildInviteEmailHtml({ name, ldId: ldName, inviteUrl }),
      });
    } catch (err) {
      logger.error("Napaka pri ponovnem pošiljanju emaila:", err);
      throw new HttpsError(
        "internal",
        "Token je bil obnovljen, ampak pošiljanje emaila ni uspelo."
      );
    }

    await db.collection("auditLog").add({
      action: "invite_resent",
      performedBy: callerUid,
      targetUid: membership.uid,
      ldId: membership.ldId,
      timestamp: now,
      details: { membershipId, email: normalizedEmail },
    });

    return { success: true, membershipId };
  }
);

/**
 * expireInvites — scheduled function, teče vsako uro.
 * Poišče memberships s statusom "invited", katerih expiresAt je minil,
 * in jim spremeni status na "expired".
 */
exports.expireInvites = onSchedule("every 60 minutes", async (event) => {
  const db = getFirestore();
  const now = Timestamp.now();

  const expiredQuery = db
    .collection("memberships")
    .where("status", "==", "invited")
    .where("expiresAt", "<", now)
    .limit(500);

  let totalExpired = 0;

  // Zanka za primer, da je naenkrat več kot 500 poteklih (batch limit)
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const snap = await expiredQuery.get();
    if (snap.empty) {
      break;
    }

    const batch = db.batch();
    snap.docs.forEach((doc) => {
      batch.update(doc.ref, { status: "expired", updatedAt: now });
    });
    await batch.commit();

    for (const doc of snap.docs) {
      const membership = doc.data();
      await db.collection("auditLog").add({
        action: "invite_expired",
        performedBy: "system",
        targetUid: membership.uid,
        ldId: membership.ldId,
        timestamp: now,
        details: { membershipId: doc.id },
      });
    }

    totalExpired += snap.docs.length;

    if (snap.docs.length < 500) {
      break;
    }
  }

  logger.info(`expireInvites: označenih kot potekli - ${totalExpired}`);
});

const RESET_EXPIRY_HOURS = 1;

function buildResetEmailHtml({ name, resetUrl }) {
  const body = `
    <h2 style="color:${ROG_COLORS.brown}; margin-top:0; margin-bottom:14px; font-size:19px;">Ponastavitev PIN-a</h2>
    <p>Pozdravljeni ${name || ""},</p>
    <p>Prejeli smo zahtevo za ponastavitev vašega PIN-a. Če te zahteve niste poslali vi, lahko to sporočilo prezrete.</p>
    <p>Za nastavitev novega PIN-a kliknite spodnji gumb:</p>
    ${emailButton(resetUrl, "Nastavi nov PIN")}
    <p style="font-size:13px; color:${ROG_COLORS.muted}; margin-bottom:0;">Povezava je veljavna ${RESET_EXPIRY_HOURS} uro. Po ponastavitvi bodo vse ostale prijavljene naprave samodejno odjavljene.</p>
  `;
  return emailWrapper(body);
}

/**
 * requestPinReset — pokliče neprijavljena oseba, ki je pozabila PIN.
 * Vedno vrne success (ne glede na to, ali email obstaja) - preprečuje
 * ugibanje, kateri emaili so registrirani (user enumeration).
 *
 * data: { email: string }
 */
exports.requestPinReset = onCall(
  { secrets: [SMTP_PASSWORD] },
  async (request) => {
    const { email } = request.data || {};
    if (!email) {
      throw new HttpsError("invalid-argument", "Email je obvezen.");
    }

    const normalizedEmail = String(email).trim().toLowerCase();
    const db = getFirestore();

    let userRecord;
    try {
      userRecord = await admin.auth().getUserByEmail(normalizedEmail);
    } catch (err) {
      // Uporabnik ne obstaja - vseeno vrni success, ne razkrij tega dejstva
      logger.info("requestPinReset: email ne obstaja, tiho ignoriram");
      return { success: true };
    }

    const uid = userRecord.uid;
    const resetToken = randomBytes(32).toString("hex");
    const now = Timestamp.now();
    const resetTokenExpiresAt = Timestamp.fromMillis(
      now.toMillis() + RESET_EXPIRY_HOURS * 60 * 60 * 1000
    );

    await db.collection("users").doc(uid).set(
      { resetToken, resetTokenExpiresAt, updatedAt: now },
      { merge: true }
    );

    const userDoc = await db.collection("users").doc(uid).get();
    const name = userDoc.exists ? userDoc.data().name : "";

    const resetUrl = `https://rog-sistem.si/ponastavi-pin?token=${resetToken}&uid=${uid}`;
    const transporter = buildTransporter(SMTP_PASSWORD.value());

    try {
      await transporter.sendMail({
        from: '"ROG Sistem" <info@rog-sistem.si>',
        to: normalizedEmail,
        subject: "Ponastavitev PIN-a — ROG Sistem",
        html: buildResetEmailHtml({ name, resetUrl }),
      });
    } catch (err) {
      logger.error("Napaka pri pošiljanju reset emaila:", err);
      // Ne razkrivamo napake klicatelju - iz istega razloga kot user enumeration zgoraj
    }

    await db.collection("auditLog").add({
      action: "pin_reset_requested",
      performedBy: uid,
      targetUid: uid,
      ldId: null,
      timestamp: now,
      details: { email: normalizedEmail },
    });

    return { success: true };
  }
);

/**
 * confirmPinReset — pokliče neprijavljena oseba, ki je kliknila reset link.
 * Validira token, nastavi nov PIN, in KLJUČNO: invalidira vse obstoječe
 * seje na drugih napravah (revokeRefreshTokens).
 *
 * data: { uid: string, token: string, newPin: string }
 */
exports.confirmPinReset = onCall(async (request) => {
  const { uid, token, newPin } = request.data || {};

  if (!uid || !token || !newPin) {
    throw new HttpsError(
      "invalid-argument",
      "uid, token in newPin so obvezni."
    );
  }
  if (typeof newPin !== "string" || newPin.length < 6) {
    throw new HttpsError(
      "invalid-argument",
      "PIN mora imeti vsaj 6 znakov."
    );
  }

  const db = getFirestore();
  const userRef = db.collection("users").doc(uid);
  const userSnap = await userRef.get();

  if (!userSnap.exists) {
    throw new HttpsError("not-found", "Uporabnik ne obstaja.");
  }

  const userData = userSnap.data();

  if (!userData.resetToken || userData.resetToken !== token) {
    throw new HttpsError("permission-denied", "Neveljaven token.");
  }

  const now = Timestamp.now();
  if (
    !userData.resetTokenExpiresAt ||
    userData.resetTokenExpiresAt.toMillis() < now.toMillis()
  ) {
    throw new HttpsError(
      "deadline-exceeded",
      "Povezava je potekla. Ponovno zahtevajte ponastavitev PIN-a."
    );
  }

  try {
    await admin.auth().updateUser(uid, { password: newPin });
  } catch (err) {
    logger.error("Napaka pri nastavitvi novega PIN-a:", err);
    throw new HttpsError("internal", "Napaka pri nastavitvi PIN-a.");
  }

  // KLJUČNO: invalidiraj vse obstoječe seje na drugih napravah
  await admin.auth().revokeRefreshTokens(uid);

  await userRef.update({
    resetToken: FieldValue.delete(),
    resetTokenExpiresAt: FieldValue.delete(),
    updatedAt: now,
  });

  await db.collection("auditLog").add({
    action: "pin_reset_confirmed",
    performedBy: uid,
    targetUid: uid,
    ldId: null,
    timestamp: now,
    details: {},
  });

  return { success: true };
});

/**
 * reactivateMember — pokliče moderator/super. Ponovno aktivira
 * predhodno deaktivirano membership (simetrično deactivateMember).
 *
 * data: { membershipId: string }
 */
exports.reactivateMember = onCall(async (request) => {
  const callerUid = request.auth && request.auth.uid;
  if (!callerUid) {
    throw new HttpsError("unauthenticated", "Prijava je obvezna.");
  }

  const { membershipId } = request.data || {};
  if (!membershipId) {
    throw new HttpsError("invalid-argument", "membershipId je obvezen.");
  }

  const db = getFirestore();
  const membershipRef = db.collection("memberships").doc(membershipId);
  const membershipSnap = await membershipRef.get();

  if (!membershipSnap.exists) {
    throw new HttpsError("not-found", "Članstvo ne obstaja.");
  }

  const membership = membershipSnap.data();

  const allowed = await callerCanInvite(
    callerUid,
    request.auth.token,
    membership.ldId,
    db
  );
  if (!allowed) {
    throw new HttpsError(
      "permission-denied",
      "Nimate pravic za ponovno aktivacijo članov te lovske družine."
    );
  }

  if (membership.status !== "deactivated") {
    throw new HttpsError(
      "failed-precondition",
      "Ta član ni deaktiviran."
    );
  }

  const now = Timestamp.now();
  await membershipRef.update({
    status: "active",
    deactivatedBy: null,
    deactivatedAt: null,
    updatedAt: now,
  });

  await db.collection("auditLog").add({
    action: "member_reactivated",
    performedBy: callerUid,
    targetUid: membership.uid,
    ldId: membership.ldId,
    timestamp: now,
    details: { membershipId },
  });

  return { success: true };
});

/**
 * listLdMembers — pokliče moderator/super. Vrne seznam NOVIH (memberships)
 * članov dane LD, brez občutljivih podatkov (EMŠO ostane skrit).
 *
 * data: { ldId: string }
 */
exports.listLdMembers = onCall(async (request) => {
  const callerUid = request.auth && request.auth.uid;
  if (!callerUid) {
    throw new HttpsError("unauthenticated", "Prijava je obvezna.");
  }

  const { ldId } = request.data || {};
  if (!ldId) {
    throw new HttpsError("invalid-argument", "ldId je obvezen.");
  }

  const db = getFirestore();

  const allowed = await callerCanInvite(callerUid, request.auth.token, ldId, db);
  if (!allowed) {
    throw new HttpsError(
      "permission-denied",
      "Nimate pravic za pregled članov te lovske družine."
    );
  }

  const membershipsSnap = await db
    .collection("memberships")
    .where("ldId", "==", ldId)
    .get();

  const members = [];
  for (const doc of membershipsSnap.docs) {
    const m = doc.data();
    const userDoc = await db.collection("users").doc(m.uid).get();
    const userData = userDoc.exists ? userDoc.data() : {};

    members.push({
      membershipId: doc.id,
      uid: m.uid,
      name: userData.name || "",
      surname: userData.surname || "",
      email: userData.email || "",
      role: m.role,
      status: m.status,
      invitedAt: m.invitedAt ? m.invitedAt.toMillis() : null,
      confirmedAt: m.confirmedAt ? m.confirmedAt.toMillis() : null,
    });
  }

  members.sort((a, b) => (a.name || "").localeCompare(b.name || "", "sl"));

  return { success: true, members };
});

/**
 * deactivateMember — pokliče moderator/super. Deaktivira membership
 * (soft-delete, skladno z odločitvijo iz Faze 0).
 *
 * data: { membershipId: string }
 */
exports.deactivateMember = onCall(async (request) => {
  const callerUid = request.auth && request.auth.uid;
  if (!callerUid) {
    throw new HttpsError("unauthenticated", "Prijava je obvezna.");
  }

  const { membershipId } = request.data || {};
  if (!membershipId) {
    throw new HttpsError("invalid-argument", "membershipId je obvezen.");
  }

  const db = getFirestore();
  const membershipRef = db.collection("memberships").doc(membershipId);
  const membershipSnap = await membershipRef.get();

  if (!membershipSnap.exists) {
    throw new HttpsError("not-found", "Članstvo ne obstaja.");
  }

  const membership = membershipSnap.data();

  const allowed = await callerCanInvite(
    callerUid,
    request.auth.token,
    membership.ldId,
    db
  );
  if (!allowed) {
    throw new HttpsError(
      "permission-denied",
      "Nimate pravic za deaktivacijo članov te lovske družine."
    );
  }

  if (membership.status === "deactivated") {
    throw new HttpsError("already-exists", "Ta član je že deaktiviran.");
  }

  const now = Timestamp.now();
  await membershipRef.update({
    status: "deactivated",
    deactivatedBy: callerUid,
    deactivatedAt: now,
    updatedAt: now,
  });

  await db.collection("auditLog").add({
    action: "member_deactivated",
    performedBy: callerUid,
    targetUid: membership.uid,
    ldId: membership.ldId,
    timestamp: now,
    details: { membershipId },
  });

  return { success: true };
});

/**
 * changeMemberRole — pokliče moderator/super. Spremeni vlogo obstoječega
 * člana (member <-> moderator). "super" ni dosegljiva preko tega kanala.
 *
 * data: { membershipId: string, newRole: "member" | "moderator" }
 */
exports.changeMemberRole = onCall(async (request) => {
  const callerUid = request.auth && request.auth.uid;
  if (!callerUid) {
    throw new HttpsError("unauthenticated", "Prijava je obvezna.");
  }

  const { membershipId, newRole } = request.data || {};
  if (!membershipId || !newRole) {
    throw new HttpsError("invalid-argument", "membershipId in newRole sta obvezna.");
  }
  if (newRole !== "member" && newRole !== "moderator") {
    throw new HttpsError(
      "invalid-argument",
      "newRole mora biti 'member' ali 'moderator'."
    );
  }

  const db = getFirestore();
  const membershipRef = db.collection("memberships").doc(membershipId);
  const membershipSnap = await membershipRef.get();

  if (!membershipSnap.exists) {
    throw new HttpsError("not-found", "Članstvo ne obstaja.");
  }

  const membership = membershipSnap.data();

  const allowed = await callerCanInvite(
    callerUid,
    request.auth.token,
    membership.ldId,
    db
  );
  if (!allowed) {
    throw new HttpsError(
      "permission-denied",
      "Nimate pravic za spremembo vloge v tej lovski družini."
    );
  }

  const oldRole = membership.role;
  const now = Timestamp.now();

  await membershipRef.update({
    role: newRole,
    updatedAt: now,
  });

  await db.collection("auditLog").add({
    action: "role_changed",
    performedBy: callerUid,
    targetUid: membership.uid,
    ldId: membership.ldId,
    timestamp: now,
    details: { membershipId, oldRole, newRole },
  });

  return { success: true };
});