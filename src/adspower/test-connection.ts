import { adsPowerClient } from './client.js';
import { logger } from '../utils/logger.js';
import { config } from '../config/index.js';

async function main() {
  logger.info('=============================================');
  logger.info('  KIỂM TRA KẾT NỐI ADSPOWER LOCAL API');
  logger.info('=============================================');
  logger.info(`Target API URL: ${config.adspower.apiUrl}`);

  // 1. Kiểm tra trạng thái API
  logger.info('\n[1/3] Đang kiểm tra API Status...');
  const status = await adsPowerClient.checkStatus();
  if (!status.ok) {
    logger.error(`❌ Kiểm tra thất bại: ${status.message}`);
    logger.info('\n💡 Hướng dẫn khắc phục:');
    logger.info('1. Hãy mở phần mềm AdsPower.');
    logger.info('2. Vào Cài đặt (Settings) -> Local API, đảm bảo công tắc API đang BẬT.');
    logger.info('3. Kiểm tra Port xem có đúng là 50325 không.');
    process.exit(1);
  }

  logger.info(`✅ Kết nối AdsPower Local API thành công! [${status.message}]`);

  // 2. Lấy danh sách profiles hiện có
  logger.info('\n[2/3] Đang lấy danh sách Profiles...');
  try {
    const profilesResult = await adsPowerClient.listProfiles({ page: 1, pageSize: 10 });
    const count = profilesResult.total ?? profilesResult.list?.length ?? 0;
    logger.info(`✅ Tìm thấy: ${count} profiles (hiển thị trang 1).`);
    
    if (profilesResult.list && profilesResult.list.length > 0) {
      console.table(
        profilesResult.list.map((p) => ({
          'User ID': p.user_id,
          'Serial / No': p.serial_number || 'N/A',
          'Name': p.name || 'Unnamed',
          'Group': p.group_name || 'Default',
          'Country/IP': p.country || p.ip || 'N/A',
        }))
      );
    } else {
      logger.warn('Chưa có profile nào được tạo trên AdsPower.');
    }
  } catch (err: any) {
    logger.error(`❌ Lỗi khi lấy danh sách profile: ${err.message}`);
  }

  logger.info('\n[3/3] Hoàn tất kiểm tra kết nối.');
}

main().catch((err) => {
  logger.error(`Lỗi không mong muốn: ${err.message}`);
  process.exit(1);
});
