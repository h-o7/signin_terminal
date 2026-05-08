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
      // In production, serve renderer files via localhost:4000 
      // This is necessary because Firebase Auth doesn't support file:// origins
      const expressApp = express();
      const PORT = 4000;
      const staticPath = path.join(__dirname, '../renderer/main_window');
      
      expressApp.use(express.static(staticPath));
      
      // Handle SPA routing: redirect all requests to index.html
      expressApp.get('*', (_req, res) => {
        res.sendFile(path.join(staticPath, 'index.html'));
      });

      server = expressApp.listen(PORT, '127.0.0.1', () => {
        console.log(`Local server running on http://localhost:${PORT}`);
      });

      mainWindow.loadURL(`http://localhost:${PORT}`);
    } catch (error) {
      console.error('Failed to start local server, falling back to file://', error);
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
