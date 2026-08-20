import { facebookLoginAutomation } from './facebook-login.js';
import { logger } from '../utils/logger.js';

async function main() {
  const profileName = process.argv[2] || 'FB REUP BR 17/8 9';
  logger.info(`Khởi chạy Facebook Login Automation cho profile: "${profileName}"`);

  try {
    const result = await facebookLoginAutomation.execute(profileName);
    logger.info('=============================================');
    logger.info('KẾT QUẢ CUỐI CÙNG:');
    console.log(JSON.stringify(result, null, 2));
    logger.info('=============================================');
  } catch (err: any) {
    logger.error(`Lỗi thực thi automation: ${err.message}`);
    process.exit(1);
  }
}

main().catch(console.error);
