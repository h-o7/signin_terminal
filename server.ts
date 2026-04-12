import express from "express";
console.log("[Server] SCRIPT_LOADED");
import { createServer as createViteServer } from "vite";
import path from "path";
import { fileURLToPath } from "url";
import { google } from "googleapis";
import cron from "node-cron";
import { initializeApp, getApps, getApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import dotenv from "dotenv";
import Papa from "papaparse";
import fs from "fs";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load Firebase Config
console.log("[Server] Loading Firebase config...");
const firebaseConfigPath = path.join(process.cwd(), "firebase-applet-config.json");
if (!fs.existsSync(firebaseConfigPath)) {
  console.error(`[Server] Firebase config NOT FOUND at ${firebaseConfigPath}`);
  process.exit(1);
}
const firebaseConfig = JSON.parse(fs.readFileSync(firebaseConfigPath, "utf8"));
console.log("[Server] Firebase config loaded successfully");

// Initialize Firebase Admin
const projectId = firebaseConfig.projectId;
const databaseId = firebaseConfig.firestoreDatabaseId;

console.log(`[Firebase Admin] Initializing...`);
console.log(` - Project ID: ${projectId}`);
console.log(` - Database ID: ${databaseId}`);

const firebaseApp = getApps().length === 0 
  ? initializeApp({
      projectId: projectId
    })
  : getApp();

const db = getFirestore(firebaseApp, databaseId);

const getCallbackUrl = () => {
  const baseUrl = process.env.APP_URL?.replace(/\/$/, "") || "http://localhost:3000";
  const callbackUrl = `${baseUrl}/api/auth/google/callback`;
  console.log(`[OAuth] Using Callback URL: ${callbackUrl}`);
  return callbackUrl;
};

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  getCallbackUrl()
);

async function startServer() {
  console.log("[Server] Starting server...");
  console.log(`[Server] NODE_ENV: ${process.env.NODE_ENV}`);
  const app = express();
  const PORT = 3000;

  // Request logging
  app.use((req, res, next) => {
    console.log(`[Server] ${new Date().toISOString()} - ${req.method} ${req.url}`);
    next();
  });

  app.use(express.json());

  // API routes
  app.get("/api/ping", (req, res) => {
    res.send("pong");
  });

  app.get("/api/debug-html", (req, res) => {
    const distPath = path.join(process.cwd(), 'dist');
    const htmlPath = path.join(distPath, 'index.html');
    if (fs.existsSync(htmlPath)) {
      res.send(fs.readFileSync(htmlPath, 'utf8'));
    } else {
      res.status(404).send("index.html not found in dist");
    }
  });

  app.get("/api/health", (req, res) => {
    res.json({ status: "ok" });
  });

  // Test Firestore connectivity
  app.get("/api/test-db", async (req, res) => {
    try {
      const testDoc = await db.collection("test").doc("connectivity").get();
      res.json({ 
        status: "success", 
        projectId, 
        databaseId: databaseId || "default",
        exists: testDoc.exists 
      });
    } catch (error) {
      console.error("Firestore Connectivity Test Failed:", error);
      res.status(500).json({ 
        status: "error", 
        message: error instanceof Error ? error.message : String(error),
        projectId,
        databaseId: databaseId || "default"
      });
    }
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
  app.get(["/api/auth/google/callback", "/api/auth/google/callback/"], async (req, res) => {
    const { code, state, error } = req.query;

    if (error === "access_denied") {
      console.log("OAuth Callback: User denied access.");
      return res.send(`
        <html>
          <body>
            <script>
              if (window.opener) {
                window.opener.postMessage({ type: 'GOOGLE_DRIVE_AUTH_CANCELLED' }, '*');
                window.close();
              } else {
                window.location.href = '/';
              }
            </script>
            <p>Connection cancelled. You can close this window.</p>
          </body>
        </html>
      `);
    }

    if (!code) {
      console.error("OAuth Callback Error: No code provided", req.query);
      return res.status(400).send("No code provided");
    }

    try {
      console.log("OAuth Callback: Exchanging code for tokens...");
      const { tokens } = await oauth2Client.getToken(code as string);
      console.log("OAuth Callback: Tokens received successfully.");
      
      // We need the userId to associate the token. 
      const userId = state as string;

      if (userId && tokens.refresh_token) {
        console.log(`OAuth Callback: Saving refresh token for user ${userId} to database ${databaseId || 'default'}`);
        try {
          await db.collection("terminals").doc(userId).set({
            googleDriveRefreshToken: tokens.refresh_token,
            autoExportEnabled: true
          }, { merge: true });
          console.log("OAuth Callback: Token saved to Firestore successfully.");
        } catch (dbError) {
          console.error("Firestore Save Error:", dbError);
          throw dbError;
        }
      } else if (!tokens.refresh_token) {
        console.warn("OAuth Callback: No refresh_token received. Ensure 'prompt: consent' is used.");
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
      console.error("OAuth Callback Error:", error);
      res.status(500).send(`Authentication failed: ${error instanceof Error ? error.message : "Unknown error"}`);
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

  app.get("/test", (req, res) => {
    res.send("<h1>Server is responding at /test</h1>");
  });

  // Vite middleware for development
  const isProduction = false; // Force development mode for testing
  
  if (!isProduction) {
    console.log("[Server] Starting in DEVELOPMENT mode (Vite middleware)");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    console.log("[Server] Starting in PRODUCTION mode (serving dist)");
    const distPath = path.join(process.cwd(), 'dist');
    
    app.use((req, res, next) => {
      if (req.url.startsWith('/assets/')) {
        console.log(`[Server] Asset request: ${req.url}`);
      }
      next();
    });

    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      console.log(`[Server] Catch-all route hit for: ${req.url}`);
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error("[Server] Failed to start server:", err);
  process.exit(1);
});
