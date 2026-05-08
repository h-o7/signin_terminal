import { app, BrowserWindow } from 'electron';
import path from 'path';
import express from 'express';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let server: any;

function createWindow() {
  const mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
    },
  });

  // Open DevTools with Ctrl+Shift+I or F12 for debugging in the packaged app
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.control && input.shift && input.key.toLowerCase() === 'i') {
      mainWindow.webContents.openDevTools();
      event.preventDefault();
    }
    if (input.key === 'F12') {
      mainWindow.webContents.openDevTools();
      event.preventDefault();
    }
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    try {
      const expressApp = express();
      const PORT = 4000;
      
      // Try to find the static files path more robustly
      const appPath = app.getAppPath();
      const potentialPaths = [
        path.join(appPath, '.vite/renderer/main_window'),
        path.join(__dirname, '../renderer/main_window'),
        path.join(process.cwd(), '.vite/renderer/main_window')
      ];
      
      let staticPath = potentialPaths[0];
      
      for (const p of potentialPaths) {
        if (fs.existsSync(p)) {
          staticPath = p;
          break;
        }
      }
      
      console.log(`[SERVER] App Path: ${appPath}`);
      console.log(`[SERVER] Static Path Found: ${staticPath}`);
      
      expressApp.use(express.static(staticPath));
      
      expressApp.get('*all', (_req, res) => {
        const indexPath = path.join(staticPath, 'index.html');
        res.sendFile(indexPath);
      });

      server = expressApp.listen(PORT, '127.0.0.1', () => {
        console.log(`[SERVER] Local server running on http://localhost:${PORT}`);
      });

      server.on('error', (e: any) => {
        console.error('[SERVER] Server error:', e);
        if (e.code === 'EADDRINUSE') {
          console.log('[SERVER] Port in use, trying fallback...');
          // In a real app, we might try another port, but 4000 is likely ok
        }
      });

      mainWindow.loadURL(`http://localhost:${PORT}`);
      
      mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL) => {
        console.error(`[SERVER] Failed to load URL: ${validatedURL} (${errorCode}: ${errorDescription})`);
        if (validatedURL.includes('localhost')) {
          const dialog = (import('electron')).then(({ dialog }) => {
            dialog.showErrorBox('Local Server Error', `Failed to load app from localhost:4000.\nError: ${errorDescription}\nFalling back to file://`);
          });
          mainWindow.loadFile(path.join(staticPath, 'index.html'));
        }
      });
    } catch (error: any) {
      console.error('[SERVER] Failed to start local server:', error);
      const dialog = (import('electron')).then(({ dialog }) => {
         dialog.showErrorBox('Server Start Failure', error.message || String(error));
      });
      mainWindow.loadFile(path.join(__dirname, '../renderer/main_window/index.html'));
    }
  }
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (server) server.close();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
