import { app, BrowserWindow } from 'electron';
import path from 'path';
import express from 'express';
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
      
      // Use app.getAppPath() to get the root of the app, works better in packaged apps
      const appPath = app.getAppPath();
      const staticPath = path.join(appPath, '.vite/renderer/main_window');
      
      console.log(`[SERVER] App Path: ${appPath}`);
      console.log(`[SERVER] Serving static files from: ${staticPath}`);
      
      expressApp.use(express.static(staticPath));
      
      expressApp.get('*', (_req, res) => {
        const indexPath = path.join(staticPath, 'index.html');
        // Check if file exists before sending
        res.sendFile(indexPath);
      });

      server = expressApp.listen(PORT, '127.0.0.1', () => {
        console.log(`[SERVER] Local server running on http://localhost:${PORT}`);
      });

      mainWindow.loadURL(`http://localhost:${PORT}`);
      
      mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL) => {
        console.error(`[SERVER] Failed to load URL: ${validatedURL} (${errorCode}: ${errorDescription})`);
        if (validatedURL.includes('localhost')) {
          console.log('[SERVER] Falling back to file:// due to load failure');
          mainWindow.loadFile(path.join(appPath, '.vite/renderer/main_window/index.html'));
        }
      });
    } catch (error) {
      console.error('[SERVER] Failed to start local server, falling back to file://', error);
      // Fallback relative to __dirname as a last resort
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
