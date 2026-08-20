import { batchFacebookLoginRunner } from './batch-runner.js';
import { logger } from '../utils/logger.js';

async function main() {
  const args = process.argv.slice(2);
  let profiles: string[] | undefined;
  let groupId: string | undefined;
  let concurrency: number | undefined;
  let targetUrl: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--profiles' || arg === '-p') {
      profiles = args[i + 1]?.split(',').map(s => s.trim()).filter(Boolean);
      i++;
    } else if (arg === '--group' || arg === '-g') {
      groupId = args[i + 1];
      i++;
    } else if (arg === '--concurrency' || arg === '-c') {
      concurrency = Number(args[i + 1]);
      i++;
    } else if (arg === '--url' || arg === '-u') {
      targetUrl = args[i + 1];
      i++;
    }
  }

  logger.info('Khởi chạy CLI Facebook Multi-threaded Batch Automation...');
  if (profiles) logger.info(`Profiles: ${profiles.join(', ')}`);
  if (groupId) logger.info(`Group ID: ${groupId}`);
  if (concurrency) logger.info(`Số luồng song song (Concurrency): ${concurrency}`);

  try {
    const summary = await batchFacebookLoginRunner.runBatch({
      profileIdentifiers: profiles,
      groupId,
      concurrency,
      targetUrl,
    });

    console.log('\n=============================================');
    console.log('KẾT QUẢ BATCH BÁO CÁO:');
    console.log(JSON.stringify(summary, null, 2));
    console.log('=============================================\n');
  } catch (err: any) {
    logger.error(`Lỗi thực thi batch automation: ${err.message}`);
    process.exit(1);
  }
}

main().catch(console.error);
