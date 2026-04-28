console.log('[SYSTEM] Process starting...');
import express from 'express';
// import { createServer as createViteServer } from 'vite'; // Moved to dynamic import inside startServer
import path from 'path';
// import { google } from 'googleapis'; // Moved to dynamic import
import cookieParser from 'cookie-parser';
import dotenv from 'dotenv';
import fs from 'fs';

dotenv.config();

const app = express();
const PORT = 3000;
const SETTINGS_FILE = path.join(process.cwd(), 'settings.json');

// Load settings from file or environment
function getSettings() {
  let settings = {
    googleClientId: process.env.GOOGLE_CLIENT_ID || '',
    googleClientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
    appUrl: process.env.APP_URL || ''
  };

  if (fs.existsSync(SETTINGS_FILE)) {
    try {
      const content = fs.readFileSync(SETTINGS_FILE, 'utf8');
      if (content && content.trim()) {
        const saved = JSON.parse(content);
        settings = { ...settings, ...saved };
      }
    } catch (e) {
      console.error('[SETTINGS] Failed to parse settings.json:', e);
      // If the file is corrupted, we might want to delete it or just ignore it
    }
  }
  return settings;
}

app.use(express.json({ limit: '10mb' }));
app.use(cookieParser());

// Health check
app.get('/api/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

// Favicon redirect
app.get('/favicon.ico', (req, res) => res.status(204).end());

let oauth2Client: any = null;

async function getOAuth2Client() {
  if (!oauth2Client) {
    const { google } = await import('googleapis');
    const settings = getSettings();
    const clientId = settings.googleClientId;
    const clientSecret = settings.googleClientSecret;

    if (!clientId || !clientSecret) {
      console.warn('[AUTH] Missing Google credentials in settings.json or environment. Google Drive features will fail.');
      return null;
    }

    oauth2Client = new google.auth.OAuth2(
      clientId,
      clientSecret,
      '' // Redirect URI will be set dynamically
    );
  }
  return oauth2Client;
}

const SCOPES = ['https://www.googleapis.com/auth/drive.file'];

function getRedirectUri(req: express.Request) {
  const settings = getSettings();
  
  // Log headers for debugging
  console.log('[AUTH] Headers:', {
    host: req.headers['host'],
    'x-forwarded-host': req.headers['x-forwarded-host'],
    'x-forwarded-proto': req.headers['x-forwarded-proto'],
    origin: req.headers['origin']
  });

  // Priority 1: Use settings APP_URL if set and not empty
  if (settings.appUrl && settings.appUrl.trim() !== '') {
    const base = settings.appUrl.trim().replace(/\/$/, '');
    console.log(`[AUTH] Using App URL from settings: ${base}`);
    return `${base}/auth/callback`;
  }

  // Priority 2: Use environment APP_URL if set
  if (process.env.APP_URL) {
    const base = process.env.APP_URL.replace(/\/$/, '');
    console.log(`[AUTH] Using App URL from environment: ${base}`);
    return `${base}/auth/callback`;
  }

  // Priority 3: Use request headers but filter out platform domain if it leaks
  const protocol = req.headers['x-forwarded-proto'] || 'http';
  let host = req.headers['host'] || '';
  
  // If host is aistudio.google.com, we are likely in a proxied iframe state we don't want for OAuth
  if (host.includes('aistudio.google.com')) {
    console.warn(`[AUTH] Detected platform host (${host}) in headers. Attempting to recover real host...`);
    const forwardedHost = req.headers['x-forwarded-host'] as string;
    if (forwardedHost && !forwardedHost.includes('aistudio.google.com')) {
      host = forwardedHost;
    }
  }

  const generated = `${protocol}://${host}/auth/callback`;
  console.log(`[AUTH] Generated redirect URI from headers: ${generated}`);
  return generated;
}

// API: Get Auth URL
app.get('/api/auth/google/url', async (req, res) => {
  const redirectUri = getRedirectUri(req);
  console.log(`[AUTH] Requesting OAuth with redirect_uri: ${redirectUri}`);
  
  const client = await getOAuth2Client();
  if (!client) {
    return res.status(500).json({ error: 'OAuth client not initialized. Check server environment variables.' });
  }

  const url = client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    redirect_uri: redirectUri,
    prompt: 'consent'
  });
  res.json({ url });
});

// API: Auth Callback
app.get(['/auth/callback', '/auth/callback/'], async (req, res) => {
  const { code } = req.query;
  const redirectUri = getRedirectUri(req);
  console.log(`[AUTH] Handling callback with redirect_uri: ${redirectUri}`);

  const client = await getOAuth2Client();
  if (!client) {
    return res.status(500).send('OAuth client not initialized.');
  }

  try {
    const { tokens } = await client.getToken({
      code: code as string,
      redirect_uri: redirectUri
    });

    // Store refresh token in a secure, cross-site cookie
    if (tokens.refresh_token) {
      res.cookie('gdrive_refresh_token', tokens.refresh_token, {
        httpOnly: true,
        secure: true,
        sameSite: 'none',
        maxAge: 30 * 24 * 60 * 60 * 1000 // 30 days
      });
    }

    res.send(`
      <html>
        <body style="background: black; color: #00ff00; font-family: monospace; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0;">
          <script>
            if (window.opener) {
              window.opener.postMessage({ type: 'GDRIVE_AUTH_SUCCESS' }, '*');
              window.close();
            } else {
              window.location.href = '/';
            }
          </script>
          <div style="border: 1px solid #00ff00; padding: 20px;">
            [SUCCESS] AUTHENTICATION_COMPLETE. CLOSING_WINDOW...
          </div>
        </body>
      </html>
    `);
  } catch (error) {
    console.error('Auth error:', error);
    res.status(500).send('Authentication failed');
  }
});

// API: Check connection status
app.get('/api/auth/google/status', (req, res) => {
  const hasToken = !!req.cookies.gdrive_refresh_token;
  res.json({ connected: hasToken });
});

// API: Disconnect Google Drive
app.post('/api/auth/google/disconnect', (req, res) => {
  res.clearCookie('gdrive_refresh_token', {
    httpOnly: true,
    secure: true,
    sameSite: 'none'
  });
  console.log('[AUTH] Google Drive disconnected (cookie cleared)');
  res.json({ success: true });
});

// API: Get App Settings (Current)
app.get('/api/settings', (req, res) => {
  res.json(getSettings());
});

// API: Get Default Settings (from Environment Only)
app.get('/api/settings/defaults', (req, res) => {
  const defaults = {
    googleClientId: process.env.GOOGLE_CLIENT_ID || '',
    googleClientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
    appUrl: process.env.APP_URL || ''
  };
  res.json(defaults);
});

// API: Save App Settings
app.post('/api/settings', (req, res) => {
  try {
    const newSettings = req.body;
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(newSettings, null, 2));
    
    // Invalidate oauth2Client so it picks up new settings next time
    oauth2Client = null;
    
    console.log('[SETTINGS] Settings updated and saved to settings.json');
    res.json({ success: true });
  } catch (error) {
    console.error('[SETTINGS] Save error:', error);
    res.status(500).json({ error: 'Failed to save settings' });
  }
});

// API: Reset App Settings (Delete settings.json)
app.post('/api/settings/reset', (req, res) => {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      fs.unlinkSync(SETTINGS_FILE);
    }
    oauth2Client = null;
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to reset settings' });
  }
});

// API: Export to Drive
app.post('/api/export/gdrive', async (req, res) => {
  const refreshToken = req.cookies.gdrive_refresh_token;
  if (!refreshToken) {
    return res.status(401).json({ error: 'Not connected to Google Drive' });
  }

  const { csvData, fileName } = req.body;
  console.log(`[DRIVE] Export requested for file: ${fileName}`);

  try {
    const { google } = await import('googleapis');
    const client = await getOAuth2Client();
    if (!client) {
      return res.status(500).json({ error: 'OAuth client not initialized. Check server environment variables.' });
    }

    client.setCredentials({ refresh_token: refreshToken });
    const drive = google.drive({ version: 'v3', auth: client });

    const fileMetadata = {
      name: fileName || `terminal_export_${new Date().toISOString()}.csv`,
      mimeType: 'text/csv',
    };
    const media = {
      mimeType: 'text/csv',
      body: csvData,
    };

    const file = await drive.files.create({
      requestBody: fileMetadata,
      media: media,
      fields: 'id, name, webViewLink',
    });

    console.log(`[DRIVE] File created successfully. ID: ${file.data.id}, Name: ${file.data.name}`);
    res.json({ success: true, fileId: file.data.id, fileName: file.data.name, webViewLink: file.data.webViewLink });
  } catch (error: any) {
    console.error('Export error:', error);
    
    // Extract specific error message from Google if available
    const message = error.response?.data?.error?.message || error.message || 'Failed to export to Google Drive';
    res.status(500).json({ error: message });
  }
});

async function startServer() {
  try {
    if (process.env.NODE_ENV !== 'production') {
      console.log('[SERVER] Starting in DEVELOPMENT mode with Vite middleware');
      const { createServer: createViteServer } = await import('vite');
      const vite = await createViteServer({
        server: { middlewareMode: true },
        appType: 'spa',
      });
      app.use(vite.middlewares);
    } else {
      console.log('[SERVER] Starting in PRODUCTION mode serving from dist/');
      const distPath = path.join(process.cwd(), 'dist');
      
      app.use(express.static(distPath));
      
      // Catch-all route for SPA - Express 5 compatible wildcard
      app.get('(.*)', (req, res) => {
        const indexPath = path.join(distPath, 'index.html');
        console.log(`[SERVER] Serving SPA for: ${req.url}`);
        res.sendFile(indexPath, (err) => {
          if (err) {
            console.error(`[ERROR] Failed to send index.html for ${req.url}: ${err.message}`);
            // If index.html is missing, the build might have failed or outDir is wrong
            res.status(500).send('Application Error: Frontend assets not found. Please contact support.');
          }
        });
      });
    }

    app.listen(PORT, '0.0.0.0', () => {
      console.log(`Server running on http://0.0.0.0:${PORT}`);
    });
  } catch (err) {
    console.error('[CRITICAL] Failed to start server:', err);
    process.exit(1);
  }
}

startServer();
