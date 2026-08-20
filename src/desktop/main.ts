import { app as electronApp, BrowserWindow, shell } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import { startServer } from '../server/index.js';
import { logger } from '../utils/logger.js';
import http from 'http';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mainWindow: BrowserWindow | null = null;
let serverInstance: http.Server | null = null;

async function createWindow(serverUrl: string) {
  mainWindow = new BrowserWindow({
    width: 1380,
    height: 880,
    minWidth: 1024,
    minHeight: 700,
    title: 'AdsPower Hybrid Automation Studio v2.0',
    backgroundColor: '#090d16',
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false,
    },
  });

  mainWindow.loadURL(serverUrl);

  // Open external links in default browser
  mainWindow.webContents.setWindowOpenHandler(({ url }: { url: string }) => {
    if (url.startsWith('http:') || url.startsWith('https:')) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

electronApp.whenReady().then(async () => {
  try {
    const port = 3000;
    serverInstance = await startServer(port);
    const serverUrl = `http://localhost:${port}`;
    logger.info(`[Desktop App] Server started successfully at ${serverUrl}`);

    await createWindow(serverUrl);
  } catch (err: any) {
    logger.error(`[Desktop App Error] ${err.message}`);
  }

  electronApp.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0 && serverInstance) {
      createWindow('http://localhost:3000');
    }
  });
});

electronApp.on('window-all-closed', () => {
  if (serverInstance) {
    serverInstance.close();
  }
  if (process.platform !== 'darwin') {
    electronApp.quit();
  }
});
