import { app } from './app.js';
import { logger } from '../utils/logger.js';
import { config } from '../config/index.js';
import http from 'http';

const DEFAULT_PORT = Number(process.env.PORT) || 3000;

export function startServer(port: number = DEFAULT_PORT): Promise<http.Server> {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);

    server.listen(port, () => {
      logger.info('===========================================================');
      logger.info(`🚀 ADSPOWER HYBRID AUTOMATION DASHBOARD ĐANG CHẠY TẠI:`);
      logger.info(`👉 http://localhost:${port}`);
      logger.info('===========================================================');
      resolve(server);
    });

    server.on('error', (err: any) => {
      if (err.code === 'EADDRINUSE') {
        logger.warn(`Port ${port} đang bận, tự động thử port ${port + 1}...`);
        resolve(startServer(port + 1));
      } else {
        logger.error(`Lỗi khởi động server: ${err.message}`);
        reject(err);
      }
    });
  });
}

if (process.argv[1] && (process.argv[1].endsWith('server/index.ts') || process.argv[1].endsWith('server/index.js'))) {
  startServer().catch(console.error);
}
