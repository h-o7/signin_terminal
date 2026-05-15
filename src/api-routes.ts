import express from 'express';
import { google } from 'googleapis';
import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';

dotenv.config();

const SETTINGS_FILE = path.join(process.cwd(), 'settings.json');

// Reusable settings logic
export function getSettings() {
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
    }
  }
  return settings;
}

let oauth2Client: any = null;

export async function getOAuth2Client() {
  if (!oauth2Client) {
    const settings = getSettings();
    const clientId = settings.googleClientId;
    const clientSecret = settings.googleClientSecret;

    if (!clientId || !clientSecret) {
      console.warn('[AUTH] Missing Google credentials. Google Drive features will fail.');
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
  
  // For Electron running on localhost:4000
  if (req.headers.host && req.headers.host.includes('localhost:4000')) {
      return 'http://localhost:4000/auth/callback';
  }

  if (settings.appUrl && settings.appUrl.trim() !== '') {
    const base = settings.appUrl.trim().replace(/\/$/, '');
    return `${base}/auth/callback`;
  }

  if (process.env.APP_URL) {
    const base = process.env.APP_URL.replace(/\/$/, '');
    return `${base}/auth/callback`;
  }

  const protocol = req.headers['x-forwarded-proto'] || 'http';
  let host = req.headers['host'] || '';
  
  if (host.includes('aistudio.google.com')) {
    const forwardedHost = req.headers['x-forwarded-host'] as string;
    if (forwardedHost && !forwardedHost.includes('aistudio.google.com')) {
      host = forwardedHost;
    }
  }

  return `${protocol}://${host}/auth/callback`;
}

export function setupApiRoutes(app: express.Express) {
  // Get Auth URL
  app.get('/api/auth/google/url', async (req, res) => {
    const redirectUri = getRedirectUri(req);
    const client = await getOAuth2Client();
    if (!client) {
      return res.status(500).json({ error: 'OAuth client not initialized. Please configure credentials in Settings.' });
    }

    const url = client.generateAuthUrl({
      access_type: 'offline',
      scope: SCOPES,
      redirect_uri: redirectUri,
      prompt: 'select_account consent'
    });
    res.json({ url });
  });

  // Auth Callback
  app.get(['/auth/callback', '/auth/callback/'], async (req, res) => {
    const { code } = req.query;
    const redirectUri = getRedirectUri(req);

    const client = await getOAuth2Client();
    if (!client) return res.status(500).send('OAuth client not initialized.');

    try {
      const { tokens } = await client.getToken({
        code: code as string,
        redirect_uri: redirectUri
      });

      if (tokens.refresh_token) {
        // Set basic cookie options
        const cookieOptions: any = {
          httpOnly: true,
          secure: true, // Always true for AI Studio (HTTPS)
          sameSite: 'none',
          maxAge: 30 * 24 * 60 * 60 * 1000,
          path: '/',
          partitioned: true // For modern browsers in iframes
        };

        // If explicitly localhost, we can relax secure
        if (req.headers.host?.includes('localhost')) {
          cookieOptions.secure = false;
          cookieOptions.sameSite = 'lax';
          delete cookieOptions.partitioned;
        }

        res.cookie('gdrive_refresh_token', tokens.refresh_token, cookieOptions);
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

  // Status
  app.get('/api/auth/google/status', (req, res) => {
    const hasToken = !!req.cookies.gdrive_refresh_token;
    res.json({ connected: hasToken });
  });

  // Disconnect
  app.post('/api/auth/google/disconnect', (req, res) => {
    const isLocalhost = !!req.headers.host?.includes('localhost');
    res.clearCookie('gdrive_refresh_token', {
      httpOnly: true,
      secure: !isLocalhost,
      sameSite: isLocalhost ? 'lax' : 'none',
      path: '/'
    });
    res.json({ success: true });
  });

  // Settings
  app.get('/api/settings', (req, res) => res.json(getSettings()));
  
  app.post('/api/settings', (req, res) => {
    try {
      const newSettings = req.body;
      fs.writeFileSync(SETTINGS_FILE, JSON.stringify(newSettings, null, 2));
      oauth2Client = null;
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: 'Failed to save settings' });
    }
  });

  app.post('/api/settings/reset', (req, res) => {
    try {
      if (fs.existsSync(SETTINGS_FILE)) fs.unlinkSync(SETTINGS_FILE);
      oauth2Client = null;
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: 'Failed to reset settings' });
    }
  });

  // Export
  app.post('/api/export/gdrive', async (req, res) => {
    const refreshToken = req.cookies.gdrive_refresh_token;
    if (!refreshToken) return res.status(401).json({ error: 'Not connected to Google Drive' });

    const { csvData, fileName } = req.body;

    try {
      const client = await getOAuth2Client();
      if (!client) return res.status(500).json({ error: 'OAuth client failure' });

      client.setCredentials({ refresh_token: refreshToken });
      const drive = google.drive({ version: 'v3', auth: client });

      // Ensure backup folder exists
      let folderId: string | undefined;
      try {
        const folderName = 'Terminal_Backups';
        const folderRes = await drive.files.list({
          q: `name = '${folderName}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
          fields: 'files(id)',
          spaces: 'drive',
        });

        if (folderRes.data.files && folderRes.data.files.length > 0) {
          folderId = folderRes.data.files[0].id!;
        } else {
          const folderMetadata = {
            name: folderName,
            mimeType: 'application/vnd.google-apps.folder',
          };
          const folder = await drive.files.create({
            requestBody: folderMetadata,
            fields: 'id',
          });
          folderId = folder.data.id!;
        }
      } catch (e) {
        console.warn('[GDRIVE] Failed to ensure folder exists, using root:', e);
      }

      const file = await drive.files.create({
        requestBody: { 
          name: fileName, 
          mimeType: 'text/csv',
          parents: folderId ? [folderId] : []
        },
        media: { mimeType: 'text/csv', body: csvData },
        fields: 'id, name, webViewLink',
      });

      res.json({ success: true, fileId: file.data.id, fileName: file.data.name, webViewLink: file.data.webViewLink });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });
}
