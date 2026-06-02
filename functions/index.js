const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const logger = require("firebase-functions/logger");
const { defineSecret } = require("firebase-functions/params");

const RESEND_API_KEY = defineSecret("RESEND_API_KEY");

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