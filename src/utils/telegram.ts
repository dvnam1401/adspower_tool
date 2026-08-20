import { config, getEffectiveLLMConfig } from '../config/index.js';
import { logger } from './logger.js';
import { BatchRunSummary } from '../automation/batch-runner.js';

export async function sendTelegramMessage(botToken: string, chatId: string, text: string): Promise<boolean> {
  if (!botToken || !chatId) {
    logger.warn('[Telegram] Thiếu Telegram Bot Token hoặc Chat ID.');
    return false;
  }

  const url = `https://api.telegram.org/bot${botToken.trim()}/sendMessage`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId.trim(),
        text: text,
        parse_mode: 'Markdown',
      }),
    });

    const data: any = await res.json();
    if (data?.ok) {
      logger.info(`[Telegram] Đã gửi tin nhắn báo cáo tới Telegram Chat ID: ${chatId}`);
      return true;
    } else {
      // Retry without markdown if parsing error
      const fallbackRes = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId.trim(),
          text: text,
        }),
      });
      const fallbackData: any = await fallbackRes.json();
      if (fallbackData?.ok) {
        logger.info(`[Telegram] Đã gửi tin nhắn tới Telegram Chat ID (plain text): ${chatId}`);
        return true;
      }
      logger.error(`[Telegram API Error] ${data?.description || 'Gửi thất bại'}`);
      return false;
    }
  } catch (err: any) {
    logger.error(`[Telegram Network Error] ${err.message}`);
    return false;
  }
}

/**
 * Call configured AI API (Gemini Direct / 9router / Custom OpenAI) to synthesize executive batch report
 */
async function generateAISummary(summary: BatchRunSummary): Promise<string> {
  const llm = getEffectiveLLMConfig();
  const baseUrl = llm.baseUrl.replace(/\/+$/, '');
  const model = llm.model;
  const apiKey = llm.apiKey || 'sk-dummy';

  logger.info(`[AI Summary] Đang kết nối AI Provider [${llm.provider.toUpperCase()}] (${baseUrl}, model: ${model})...`);

  // Group items by failure/success categories
  const wrongPassword: string[] = [];
  const checkpoint: string[] = [];
  const recaptcha: string[] = [];
  const unknownError: string[] = [];
  const success: string[] = [];

  summary.results.forEach(r => {
    const id = r.profileName ? `${r.profileName} (${r.identifier})` : r.identifier;
    const errText = (r.error || r.result?.message || '').toLowerCase();
    const statusStr = String(r.result?.status || '');

    if (statusStr === 'logged_in' || statusStr === 'already_logged_in' || statusStr === 'two_factor_completed') {
      success.push(id);
    } else if (errText.includes('password') || errText.includes('mật khẩu') || errText.includes('incorrect') || errText.includes('wrong')) {
      wrongPassword.push(id);
    } else if (statusStr === 'checkpoint_human_verification' || errText.includes('checkpoint') || errText.includes('xác minh') || errText.includes('2fa')) {
      checkpoint.push(id);
    } else if (statusStr === 'recapcha_detected' || errText.includes('captcha') || errText.includes('recaptcha')) {
      recaptcha.push(id);
    } else {
      unknownError.push(`${id}: ${r.error || r.result?.message || 'Lỗi không xác định'}`);
    }
  });

  const rawDataForAI = {
    total: summary.total,
    durationSeconds: Math.round(summary.totalDurationMs / 1000),
    successCount: success.length,
    successList: success,
    wrongPasswordList: wrongPassword,
    checkpointList: checkpoint,
    recaptchaList: recaptcha,
    unknownErrorList: unknownError,
  };

  const prompt = `Bạn là trợ lý AI quản lý tự động hóa AdsPower. Hãy đọc dữ liệu kết quả chạy tự động hóa hàng loạt dưới đây và viết một bản BÁO CÁO TỔNG HỢP GỬI TELEGRAM ngắn gọn, chuyên nghiệp, súc tích bằng tiếng Việt.

DỮ LIỆU ĐỢT CHẠY:
- Tổng số profile: ${rawDataForAI.total}
- Thời gian chạy: ${rawDataForAI.durationSeconds} giây
- Thành công: ${rawDataForAI.successCount} profile
- Tài khoản/Mật khẩu không đúng (${rawDataForAI.wrongPasswordList.length}): ${rawDataForAI.wrongPasswordList.join(', ') || 'Không có'}
- Tài khoản bị Checkpoint / 2FA (${rawDataForAI.checkpointList.length}): ${rawDataForAI.checkpointList.join(', ') || 'Không có'}
- Vướng ReCaptcha (${rawDataForAI.recaptchaList.length}): ${rawDataForAI.recaptchaList.join(', ') || 'Không có'}
- Lỗi chưa xác định / Lỗi khác (${rawDataForAI.unknownErrorList.length}): ${rawDataForAI.unknownErrorList.join('; ') || 'Không có'}

YÊU CẦU ĐỊNH DẠNG:
- Dùng icon sinh động (📊, ✅, ⚠️, 🔒, 🤖, ❌).
- Phân loại rõ ràng các mục: 
  + 📊 Báo Cáo Tổng Quan
  + ✅ Đăng Nhập Thành Công
  + 🔑 Sai Tài Khoản / Mật Khẩu
  + 🛡️ Bị Checkpoint / 2FA
  + 🧩 Vướng ReCaptcha
  + ⚠️ Lỗi Khác / Chưa Xác Định
- Không liệt kê quá dài nếu danh sách rỗng.
- Cuối báo cáo đưa ra lời khuyên xử lý ngắn (ví dụ: đổi pass, gỡ checkpoint...).`;

  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: model,
        messages: [
          { role: 'system', content: 'Bạn là báo cáo viên AI súc tích cho quản lý AdsPower.' },
          { role: 'user', content: prompt }
        ],
        temperature: 0.3,
      }),
    });

    if (res.ok) {
      const data: any = await res.json();
      const aiContent = data?.choices?.[0]?.message?.content;
      if (aiContent) {
        return aiContent;
      }
    }
  } catch (err: any) {
    logger.warn(`[AI Summary Error] Không thể gọi 9router AI API (${err.message}), chuyển sang fallback format.`);
  }

  // Fallback formatting if AI API call is unconfigured or fails
  let fallback = `📊 *BÁO CÁO TỰ ĐỘNG HÓA ADSPOWER*\n`;
  fallback += `⏱️ Tổng thời gian: ${rawDataForAI.durationSeconds}s | Tổng số: ${rawDataForAI.total}\n\n`;
  fallback += `✅ *Thành công (${success.length}):*\n${success.slice(0, 10).join('\n') || 'Không có'}\n\n`;
  if (wrongPassword.length > 0) {
    fallback += `🔑 *Sai tài khoản/mật khẩu (${wrongPassword.length}):*\n${wrongPassword.join('\n')}\n\n`;
  }
  if (checkpoint.length > 0) {
    fallback += `🛡️ *Bị Checkpoint/2FA (${checkpoint.length}):*\n${checkpoint.join('\n')}\n\n`;
  }
  if (recaptcha.length > 0) {
    fallback += `🧩 *Vướng ReCaptcha (${recaptcha.length}):*\n${recaptcha.join('\n')}\n\n`;
  }
  if (unknownError.length > 0) {
    fallback += `⚠️ *Lỗi chưa xác định (${unknownError.length}):*\n${unknownError.join('\n')}\n\n`;
  }

  return fallback;
}

/**
 * Main entrance to synthesize and send Telegram notification when batch completes
 */
export async function synthesizeBatchReportAndNotify(summary: BatchRunSummary): Promise<void> {
  const telegramConfig = config.telegram;
  if (!telegramConfig?.enabled) {
    logger.info('[Telegram] Tính năng gửi thông báo Telegram đang TẮT trong Settings. Bỏ qua.');
    return;
  }

  if (!telegramConfig.botToken || !telegramConfig.chatId) {
    logger.warn('[Telegram] Thiếu Bot Token hoặc Chat ID trong Cấu hình Telegram. Bỏ qua.');
    return;
  }

  logger.info('[Telegram] Bắt đầu tổng hợp báo cáo bằng AI (9router/Gemini)...');
  const aiReportText = await generateAISummary(summary);

  logger.info('[Telegram] Đang gửi tin nhắn báo cáo tổng hợp về Telegram...');
  await sendTelegramMessage(telegramConfig.botToken, telegramConfig.chatId, aiReportText);
}

/**
 * Send real-time Telegram notification for a single profile login result
 */
export async function notifySingleProfileResult(result: any): Promise<void> {
  const telegramConfig = config.telegram;
  if (!telegramConfig?.enabled || !telegramConfig.botToken || !telegramConfig.chatId) {
    return;
  }

  const icon = result.success ? '✅' : (result.status === 'checkpoint_human_verification' || result.status === 'checkpoint_detected') ? '🛡️' : result.status === 'recapcha_detected' ? '🧩' : '❌';
  const header = result.success ? '*BÁO CÁO ĐĂNG NHẬP THÀNH CÔNG*' : '*BÁO CÁO CẦN XỬ LÝ / THẤT BẠI*';

  let msg = `${icon} ${header}\n\n`;
  msg += `👤 *Profile:* ${result.profileName || result.profileId}\n`;
  msg += `📌 *Trạng thái:* \`${(result.status || '').toUpperCase()}\`\n`;
  msg += `💬 *Chi tiết:* ${result.message}\n`;
  if (result.currentUrl) {
    msg += `🌐 *URL:* ${result.currentUrl}\n`;
  }
  if (result.twoFactorCodeUsed) {
    msg += `🔑 *Mã 2FA đã dùng:* \`${result.twoFactorCodeUsed}\`\n`;
  }
  msg += `⏰ *Thời gian:* ${new Date().toLocaleTimeString('vi-VN')}`;

  await sendTelegramMessage(telegramConfig.botToken, telegramConfig.chatId, msg);
}
