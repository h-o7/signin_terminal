import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import { fileURLToPath } from "url";
import { google } from "googleapis";
import cron from "node-cron";
import { initializeApp, getApps, getApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import dotenv from "dotenv";
import Papa from "papaparse";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Initialize Firebase Admin
const firebaseApp = getApps().length === 0 
  ? initializeApp({
      projectId: process.env.VITE_FIREBASE_PROJECT_ID,
    })
  : getApp();

const db = process.env.VITE_FIREBASE_DATABASE_ID 
  ? getFirestore(firebaseApp, process.env.VITE_FIREBASE_DATABASE_ID)
  : getFirestore(firebaseApp);

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.APP_URL 
    ? `${process.env.APP_URL}/api/auth/google/callback`
    : "http://localhost:3000/api/auth/google/callback"
);

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());

  // API routes
  app.get("/api/health", (req, res) => {
    res.json({ status: "ok" });
  });

  // Google OAuth URL
  app.get("/api/auth/google/url", (req, res) => {
    try {
      if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
        throw new Error("Google OAuth credentials are missing in .env file.");
      }
      const { login_hint } = req.query;
      const url = oauth2Client.generateAuthUrl({
        access_type: "offline",
        scope: ["https://www.googleapis.com/auth/drive.file"],
        prompt: "consent",
        login_hint: login_hint as string,
      });
      res.json({ url });
    } catch (error) {
      console.error("Error generating Auth URL:", error);
      res.status(500).json({ error: error instanceof Error ? error.message : "Failed to generate Auth URL" });
    }
  });

  // Google OAuth Callback
  app.get("/api/auth/google/callback", async (req, res) => {
    const { code, state } = req.query;
    if (!code) return res.status(400).send("No code provided");

    try {
      const { tokens } = await oauth2Client.getToken(code as string);
      
      // We need the userId to associate the token. 
      // In a real app, we'd use a session or a temporary state.
      // For this demo, we'll expect the userId in the 'state' parameter or similar.
      // Let's assume the client passes userId in state.
      const userId = state as string;

      if (userId && tokens.refresh_token) {
        await db.collection("terminals").doc(userId).set({
          googleDriveRefreshToken: tokens.refresh_token,
          autoExportEnabled: true
        }, { merge: true });
      }

      res.send(`
        <html>
          <body>
            <script>
              if (window.opener) {
                window.opener.postMessage({ type: 'GOOGLE_DRIVE_AUTH_SUCCESS' }, '*');
                window.close();
              } else {
                window.location.href = '/';
              }
            </script>
            <p>Google Drive connected successfully! You can close this window.</p>
          </body>
        </html>
      `);
    } catch (error) {
      console.error("OAuth Error:", error);
      res.status(500).send("Authentication failed");
    }
  });

  // Monthly Export Logic
  const runMonthlyExport = async () => {
    console.log("[CRON] Starting monthly export...");
    const terminalsSnapshot = await db.collection("terminals").where("autoExportEnabled", "==", true).get();

    for (const terminalDoc of terminalsSnapshot.docs) {
      const userId = terminalDoc.id;
      const data = terminalDoc.data();
      const refreshToken = data.googleDriveRefreshToken;

      if (!refreshToken) continue;

      try {
        const auth = new google.auth.OAuth2(
          process.env.GOOGLE_CLIENT_ID,
          process.env.GOOGLE_CLIENT_SECRET
        );
        auth.setCredentials({ refresh_token: refreshToken });

        const drive = google.drive({ version: "v3", auth });

        // Fetch logs
        const logsSnapshot = await db.collection("terminals").doc(userId).collection("logs").orderBy("timestamp", "desc").get();
        if (logsSnapshot.empty) {
          console.log(`[CRON] No logs for user ${userId}, skipping.`);
          continue;
        }

        const logsData = logsSnapshot.docs.map(doc => doc.data());
        const csv = Papa.unparse(logsData);

        // Upload to Drive
        const fileName = `terminal_logs_${new Date().toISOString().split('T')[0]}.csv`;
        await drive.files.create({
          requestBody: {
            name: fileName,
            mimeType: "text/csv",
          },
          media: {
            mimeType: "text/csv",
            body: csv,
          },
        });

        console.log(`[CRON] Exported logs for ${userId} to Google Drive.`);

        // Clear logs
        const batch = db.batch();
        logsSnapshot.docs.forEach(doc => batch.delete(doc.ref));
        await batch.commit();
        
        console.log(`[CRON] Cleared logs for ${userId}.`);

      } catch (error) {
        console.error(`[CRON] Export failed for user ${userId}:`, error);
      }
    }
  };

  // Schedule: Run every day at midnight and check if it's the last day of the month
  cron.schedule("0 0 * * *", () => {
    const today = new Date();
    const tomorrow = new Date(today);
    tomorrow.setDate(today.getDate() + 1);
    if (tomorrow.getDate() === 1) {
      runMonthlyExport();
    }
  });

  // For testing: manual trigger endpoint (protected by a secret if needed)
  app.post("/api/admin/trigger-export", async (req, res) => {
    // In production, add authentication here
    await runMonthlyExport();
    res.json({ status: "Export triggered" });
  });

  // 404 handler for API routes to prevent falling through to Vite
  app.all("/api/*", (req, res) => {
    res.status(404).json({ error: `API route ${req.method} ${req.url} not found` });
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
