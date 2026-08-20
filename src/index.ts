import { startServer } from './server/index.js';
import { adsPowerClient } from './adspower/client.js';
import { logger } from './utils/logger.js';
import { config } from './config/index.js';

export * from './types/index.js';
export * from './config/index.js';
export * from './adspower/client.js';
export * from './utils/logger.js';
export * from './server/index.js';

async function main() {
  logger.info('Khởi động AdsPower Hybrid Agentic Automation App...');
  
  // Start the Local Web GUI Dashboard Server
  await startServer();
}

if (process.argv[1] && (process.argv[1].endsWith('index.ts') || process.argv[1].endsWith('index.js'))) {
  main().catch((err) => {
    logger.error(`Lỗi khởi động ứng dụng: ${err.message}`);
  });
}
