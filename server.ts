import express from 'express';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import { google } from 'googleapis';
import cookieParser from 'cookie-parser';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const PORT = 3000;

app.use(express.json({ limit: '10mb' }));
app.use(cookieParser());

// Favicon redirect
app.get('/favicon.ico', (req, res) => res.status(204).end());

let oauth2Client: any = null;

function getOAuth2Client() {
  if (!oauth2Client) {
    oauth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      '' // Redirect URI will be set dynamically
    );
  }
  return oauth2Client;
}

const SCOPES = ['https://www.googleapis.com/auth/drive.file'];

function getRedirectUri(req: express.Request) {
  // Priority 1: Use APP_URL if set (common in AI Studio)
  if (process.env.APP_URL) {
    const base = process.env.APP_URL.replace(/\/$/, '');
    return `${base}/auth/callback`;
  }

  // Priority 2: Use headers
  const protocol = req.headers['x-forwarded-proto'] || 'http';
  const host = req.headers['host'];
  return `${protocol}://${host}/auth/callback`;
}

// API: Get Auth URL
app.get('/api/auth/google/url', (req, res) => {
  const redirectUri = getRedirectUri(req);
  console.log(`[AUTH] Requesting OAuth with redirect_uri: ${redirectUri}`);
  
  const client = getOAuth2Client();
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

  const client = getOAuth2Client();
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

// API: Export to Drive
app.post('/api/export/gdrive', async (req, res) => {
  const refreshToken = req.cookies.gdrive_refresh_token;
  if (!refreshToken) {
    return res.status(401).json({ error: 'Not connected to Google Drive' });
  }

  const { csvData, fileName } = req.body;

  try {
    const client = getOAuth2Client();
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
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*all', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
