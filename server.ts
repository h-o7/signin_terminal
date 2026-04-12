import express from "express";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import dotenv from "dotenv";

const logFile = path.join(process.cwd(), "server.log");
const log = (msg: string) => {
  const entry = `${new Date().toISOString()} - ${msg}\n`;
  console.log(msg);
  try {
    fs.appendFileSync(logFile, entry);
  } catch (e) {}
};

log("[Server] SCRIPT_LOADED");

process.on('uncaughtException', (err) => {
  log(`[Server] Uncaught Exception: ${err.message}\n${err.stack}`);
});

process.on('unhandledRejection', (reason, promise) => {
  log(`[Server] Unhandled Rejection at: ${promise} reason: ${reason}`);
});

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3000;

// 1. Register health routes IMMEDIATELY
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", initialized: !!db, time: new Date().toISOString() });
});

app.get("/healthz", (req, res) => {
  res.send("ok");
});

// 2. Start listening IMMEDIATELY
app.listen(PORT, "0.0.0.0", () => {
  log(`[Server] SUCCESS: Server is listening on port ${PORT}`);
});

// 3. Request logging
app.use((req, res, next) => {
  log(`[Server] ${new Date().toISOString()} - ${req.method} ${req.url}`);
  log(`[Headers] ${JSON.stringify(req.headers)}`);
  next();
});

// Load Firebase Config
log("[Server] Loading Firebase config...");
const firebaseConfigPath = path.join(process.cwd(), "firebase-applet-config.json");
if (!fs.existsSync(firebaseConfigPath)) {
  log(`[Server] Firebase config NOT FOUND at ${firebaseConfigPath}`);
  process.exit(1);
}
const firebaseConfig = JSON.parse(fs.readFileSync(firebaseConfigPath, "utf8"));
log("[Server] Firebase config loaded successfully");

// Initialize Firebase Admin variables
const projectId = firebaseConfig.projectId;
const databaseId = firebaseConfig.firestoreDatabaseId;

let db: any;
let oauth2Client: any;

const getCallbackUrl = () => {
  const baseUrl = process.env.APP_URL?.replace(/\/$/, "") || "http://localhost:3000";
  const callbackUrl = `${baseUrl}/api/auth/google/callback`;
  return callbackUrl;
};

async function startServer() {
  log("[Server] Starting server initialization...");
  log(`[Server] APP_URL: ${process.env.APP_URL}`);
  log(`[Server] PORT ENV: ${process.env.PORT}`);
  
  try {
    const { google } = await import("googleapis");
    log("[OAuth] Initializing client...");
    oauth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      getCallbackUrl()
    );
    log("[OAuth] Client initialized");
  } catch (err) {
    log(`[OAuth] Initialization failed: ${err}`);
  }

  // Initialize Firebase Admin
  try {
    const { initializeApp, getApps, getApp } = await import("firebase-admin/app");
    const { getFirestore } = await import("firebase-admin/firestore");
    
    log(`[Firebase Admin] Initializing...`);
    log(` - Project ID: ${projectId}`);
    log(` - Database ID: ${databaseId}`);

    const firebaseApp = getApps().length === 0 
      ? initializeApp({
          projectId: projectId
        })
      : getApp();

    db = getFirestore(firebaseApp, databaseId);
    log("[Firebase Admin] Initialized successfully");
  } catch (error) {
    log(`[Firebase Admin] Initialization failed: ${error}`);
  }

  app.use(express.json());

  // API routes
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
      log(`Firestore Connectivity Test Failed: ${error}`);
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
      log(`Error generating Auth URL: ${error}`);
      res.status(500).json({ error: error instanceof Error ? error.message : "Failed to generate Auth URL" });
    }
  });

  // Google OAuth Callback
  app.get(["/api/auth/google/callback", "/api/auth/google/callback/"], async (req, res) => {
    const { code, state, error } = req.query;

    if (error === "access_denied") {
      log("OAuth Callback: User denied access.");
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
      log(`OAuth Callback Error: No code provided ${JSON.stringify(req.query)}`);
      return res.status(400).send("No code provided");
    }

    try {
      log("OAuth Callback: Exchanging code for tokens...");
      const { tokens } = await oauth2Client.getToken(code as string);
      log("OAuth Callback: Tokens received successfully.");
      
      // We need the userId to associate the token. 
      const userId = state as string;

      if (userId && tokens.refresh_token) {
        log(`OAuth Callback: Saving refresh token for user ${userId} to database ${databaseId || 'default'}`);
        try {
          await db.collection("terminals").doc(userId).set({
            googleDriveRefreshToken: tokens.refresh_token,
            autoExportEnabled: true
          }, { merge: true });
          log("OAuth Callback: Token saved to Firestore successfully.");
        } catch (dbError) {
          log(`Firestore Save Error: ${dbError}`);
          throw dbError;
        }
      } else if (!tokens.refresh_token) {
        log("OAuth Callback: No refresh_token received. Ensure 'prompt: consent' is used.");
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
      log(`OAuth Callback Error: ${error}`);
      res.status(500).send(`Authentication failed: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
  });

  // Monthly Export Logic
  const runMonthlyExport = async () => {
    log("[CRON] Starting monthly export...");
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
          log(`[CRON] No logs for user ${userId}, skipping.`);
          continue;
        }

        const logsData = logsSnapshot.docs.map(doc => doc.data());
        const Papa = (await import("papaparse")).default;
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

        log(`[CRON] Exported logs for ${userId} to Google Drive.`);

        // Clear logs
        const batch = db.batch();
        logsSnapshot.docs.forEach(doc => batch.delete(doc.ref));
        await batch.commit();
        
        log(`[CRON] Cleared logs for ${userId}.`);

      } catch (error) {
        log(`[CRON] Export failed for user ${userId}: ${error}`);
      }
    }
  };

  // Schedule: Run every day at midnight and check if it's the last day of the month
  const cron = (await import("node-cron")).default;
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
  const isProduction = process.env.NODE_ENV === "production" || fs.existsSync(path.join(process.cwd(), 'dist'));
  log(`[Server] Mode: ${isProduction ? "PRODUCTION" : "DEVELOPMENT"}`);
  
  if (!isProduction) {
    log("[Server] Starting in DEVELOPMENT mode (Vite middleware)");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    log("[Server] Starting in PRODUCTION mode (serving dist)");
    const distPath = path.resolve(__dirname, 'dist');
    
    app.use((req, res, next) => {
      if (req.url.startsWith('/assets/')) {
        log(`[Server] Asset request: ${req.url}`);
      }
      next();
    });

    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      log(`[Server] Catch-all route hit for: ${req.url}`);
      res.sendFile(path.resolve(distPath, 'index.html'));
    });
  }
}

startServer().catch((err) => {
  log(`[Server] Failed to start server: ${err}`);
  process.exit(1);
});
