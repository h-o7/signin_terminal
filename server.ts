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
const distPath = path.resolve(__dirname, 'dist');

log(`[Server] __dirname: ${__dirname}`);
log(`[Server] distPath: ${distPath}`);

const app = express();
const PORT = 3000;

// Load Firebase Config
log("[Server] Loading Firebase config...");
const firebaseConfigPath = path.join(process.cwd(), "firebase-applet-config.json");
if (!fs.existsSync(firebaseConfigPath)) {
  log(`[Server] Firebase config NOT FOUND at ${firebaseConfigPath}`);
  process.exit(1);
}
const firebaseConfig = JSON.parse(fs.readFileSync(firebaseConfigPath, "utf8"));
log("[Server] Firebase config loaded successfully");

const projectId = firebaseConfig.projectId;
const databaseId = firebaseConfig.firestoreDatabaseId;

let db: any;
let oauth2Client: any;

const getCallbackUrl = () => {
  const baseUrl = process.env.APP_URL?.replace(/\/$/, "") || "http://localhost:3000";
  const callbackUrl = `${baseUrl}/api/auth/google/callback`;
  return callbackUrl;
};

// 1. Register health routes IMMEDIATELY
app.get("/api/health", (req, res) => {
  res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  res.json({ 
    status: "ok", 
    initialized: !!db, 
    oauthReady: !!oauth2Client,
    time: new Date().toISOString() 
  });
});

app.get("/healthz", (req, res) => {
  res.send("ok");
});

app.get("/", (req, res, next) => {
  if (req.url === "/" && !req.headers.accept?.includes("text/html")) {
    return res.send("ok");
  }
  next();
});

// 2. Start listening IMMEDIATELY to satisfy infrastructure
app.listen(PORT, "0.0.0.0", () => {
  log(`[Server] SUCCESS: Server is listening on port ${PORT}`);
});

// 3. Global Error Handler
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  log(`[Server] Global Error: ${err.message}\n${err.stack}`);
  if (!res.headersSent) {
    res.status(500).send("Internal Server Error");
  }
});

// 4. Request logging
app.use((req, res, next) => {
  if (req.url !== '/api/health' && req.url !== '/healthz') {
    log(`[Server] ${new Date().toISOString()} - ${req.method} ${req.url}`);
  }
  next();
});

app.use(express.json());

// 5. API Routes
app.get("/api/test-db", async (req, res) => {
  if (!db) return res.status(503).json({ error: "Database not initialized yet" });
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
      message: error instanceof Error ? error.message : String(error)
    });
  }
});

app.get("/api/auth/google/url", (req, res) => {
  if (!oauth2Client) return res.status(503).json({ error: "OAuth client not initialized yet" });
  try {
    const { login_hint } = req.query;
    const url = oauth2Client.generateAuthUrl({
      access_type: "offline",
      scope: ["https://www.googleapis.com/auth/drive.file"],
      prompt: "consent",
      login_hint: login_hint as string,
    });
    res.json({ url });
  } catch (error) {
    res.status(500).json({ error: "Failed to generate Auth URL" });
  }
});

app.get(["/api/auth/google/callback", "/api/auth/google/callback/"], async (req, res) => {
  if (!oauth2Client || !db) return res.status(503).send("Server still initializing...");
  const { code, state, error } = req.query;

  if (error === "access_denied") {
    return res.send(`<html><body><script>if(window.opener){window.opener.postMessage({type:'GOOGLE_DRIVE_AUTH_CANCELLED'},'*');window.close();}else{window.location.href='/';}</script><p>Cancelled.</p></body></html>`);
  }

  if (!code) return res.status(400).send("No code provided");

  try {
    const { tokens } = await oauth2Client.getToken(code as string);
    const userId = state as string;
    if (userId && tokens.refresh_token) {
      await db.collection("terminals").doc(userId).set({
        googleDriveRefreshToken: tokens.refresh_token,
        autoExportEnabled: true
      }, { merge: true });
    }
    res.send(`<html><body><script>if(window.opener){window.opener.postMessage({type:'GOOGLE_DRIVE_AUTH_SUCCESS'},'*');window.close();}else{window.location.href='/';}</script><p>Success!</p></body></html>`);
  } catch (err) {
    res.status(500).send("Auth failed");
  }
});

// 6. UI Routes (Eager registration)
const isProduction = process.env.NODE_ENV === "production" || fs.existsSync(distPath);
log(`[Server] Mode: ${isProduction ? "PRODUCTION" : "DEVELOPMENT"}`);

if (isProduction) {
  app.use(express.static(distPath));
}

async function initializeServices() {
  log("[Server] Starting background initialization...");
  
  let google: any;
  try {
    const googleapis = await import("googleapis");
    google = googleapis.google;
    oauth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      getCallbackUrl()
    );
    log("[OAuth] Client initialized");
  } catch (err) {
    log(`[OAuth] Initialization failed: ${err}`);
  }

  try {
    const { initializeApp, getApps, getApp } = await import("firebase-admin/app");
    const { getFirestore } = await import("firebase-admin/firestore");
    const firebaseApp = getApps().length === 0 ? initializeApp({ projectId }) : getApp();
    db = getFirestore(firebaseApp, databaseId);
    log("[Firebase Admin] Initialized successfully");
  } catch (error) {
    log(`[Firebase Admin] Initialization failed: ${error}`);
  }

  // Monthly Export Logic
  const runMonthlyExport = async () => {
    if (!db || !google) return;
    log("[CRON] Starting monthly export...");
    const terminalsSnapshot = await db.collection("terminals").where("autoExportEnabled", "==", true).get();
    for (const terminalDoc of terminalsSnapshot.docs) {
      const userId = terminalDoc.id;
      const data = terminalDoc.data();
      const refreshToken = data.googleDriveRefreshToken;
      if (!refreshToken) continue;
      try {
        const auth = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET);
        auth.setCredentials({ refresh_token: refreshToken });
        const drive = google.drive({ version: "v3", auth });
        const logsSnapshot = await db.collection("terminals").doc(userId).collection("logs").orderBy("timestamp", "desc").get();
        if (logsSnapshot.empty) continue;
        const logsData = logsSnapshot.docs.map(doc => doc.data());
        const Papa = (await import("papaparse")).default;
        const csv = Papa.unparse(logsData);
        const fileName = `terminal_logs_${new Date().toISOString().split('T')[0]}.csv`;
        await drive.files.create({
          requestBody: { name: fileName, mimeType: "text/csv" },
          media: { mimeType: "text/csv", body: csv },
        });
        const batch = db.batch();
        logsSnapshot.docs.forEach(doc => batch.delete(doc.ref));
        await batch.commit();
        log(`[CRON] Exported logs for ${userId}.`);
      } catch (error) {
        log(`[CRON] Export failed for ${userId}: ${error}`);
      }
    }
  };

  // Setup Cron
  try {
    const cron = (await import("node-cron")).default;
    cron.schedule("0 0 * * *", async () => {
      const today = new Date();
      const tomorrow = new Date(today);
      tomorrow.setDate(today.getDate() + 1);
      if (tomorrow.getDate() === 1) {
        runMonthlyExport();
      }
    });
  } catch (e) {}
}

// Start initialization in background
initializeServices();

// Final Catch-all for UI
if (isProduction) {
  app.get('*', (req, res) => {
    try {
      const indexPath = path.join(distPath, 'index.html');
      log(`[Server] Catch-all request: ${req.url} -> ${indexPath}`);
      if (fs.existsSync(indexPath)) {
        res.sendFile(indexPath, (err) => {
          if (err) {
            log(`[Server] res.sendFile ERROR: ${err.message}`);
            if (!res.headersSent) {
              res.status(500).send("Error sending index.html");
            }
          }
        });
      } else {
        log(`[Server] ERROR: index.html not found at ${indexPath}`);
        res.status(404).send("Frontend build not found.");
      }
    } catch (err: any) {
      log(`[Server] Catch-all CRASH: ${err.message}`);
      res.status(500).send("Internal Server Error");
    }
  });
} else {
  // Vite setup
  const { createServer: createViteServer } = await import("vite");
  const vite = await createViteServer({
    server: { middlewareMode: true },
    appType: "spa",
  });
  app.use(vite.middlewares);
}
