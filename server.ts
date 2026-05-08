console.log('[SYSTEM] Process starting...');
import express from 'express';
import path from 'path';
import cookieParser from 'cookie-parser';
import dotenv from 'dotenv';
import fs from 'fs';
import { setupApiRoutes } from './src/api-routes.ts';

dotenv.config();

const app = express();
const PORT = 3000;

app.use(express.json({ limit: '10mb' }));
app.use(cookieParser());

// Health check
app.get('/api/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

// Favicon redirect
app.get('/favicon.ico', (req, res) => res.status(204).end());

// Set up Google Drive and Settings API routes
setupApiRoutes(app);

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
      app.get('*all', (req, res) => {
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
