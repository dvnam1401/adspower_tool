import { chromium, devices } from 'playwright-core';
import axios from 'axios';

// Bạn có thể để tên Profile (ví dụ: 'FB REUP Clone 13/07 5')
const PROFILE_NAME = 'FB REUP Clone 13/07 5';
const ADSPOWER_API = 'http://127.0.0.1:50325'; // Port mặc định của AdsPower

async function captureSharePageAPI() {
    try {
        console.log(`Đang tìm ID cho profile có tên: "${PROFILE_NAME}"...`);

        // 1. Tìm User ID từ Tên Profile (Lấy tối đa 2000 profile để tránh bị sót trang)
        const listResponse = await axios.get(`${ADSPOWER_API}/api/v1/user/list?page_size=2000`);
        const profiles = listResponse.data?.data?.list || [];
        const targetProfile = profiles.find((p: any) => p.name === PROFILE_NAME);

        if (!targetProfile) {
            throw new Error(`Không tìm thấy profile nào có tên là "${PROFILE_NAME}". Vui lòng kiểm tra lại tên.`);
        }

        const profileId = targetProfile.user_id;
        console.log(`✅ Đã tìm thấy ID: ${profileId}`);

        // 2. Bật profile hoặc lấy ws nếu đã bật
        let wsEndpoint = '';
        const activeResponse = await axios.get(`${ADSPOWER_API}/api/v1/browser/active?user_id=${profileId}`);

        if (activeResponse.data.code === 0 && activeResponse.data.data.ws) {
            wsEndpoint = activeResponse.data.data.ws.puppeteer;
            console.log('Trình duyệt đang mở, đang kết nối...');
        } else {
            console.log('Trình duyệt chưa mở. Đang tự động bật trình duyệt AdsPower...');
            const startResponse = await axios.get(`${ADSPOWER_API}/api/v1/browser/start?user_id=${profileId}`);
            if (startResponse.data.code !== 0) {
                 throw new Error('Lỗi khi bật trình duyệt: ' + startResponse.data.msg);
            }
            wsEndpoint = startResponse.data.data.ws.puppeteer;
            // Đợi vài giây cho browser load hoàn toàn
            await new Promise(r => setTimeout(r, 5000));
        }

        // 3. Kết nối Playwright
        const browser = await chromium.connectOverCDP(wsEndpoint);
        const context = browser.contexts()[0] || await browser.newContext();

        console.log('Đang thiết lập môi trường Mobile ngay trên cửa sổ hiện tại...');

        // Sử dụng luôn tab đầu tiên (hoặc tạo tab mới trong đúng cửa sổ đó)
        const page = context.pages().length > 0 ? context.pages()[0] : await context.newPage();

        // Ghi đè kích thước màn hình
        await page.setViewportSize({ width: 430, height: 932 }); // iPhone 14 Pro Max size

        // Ghi đè User-Agent ở mức Network để đánh lừa Server Facebook
        const mobileUserAgent = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1';

        await page.route('**/*', async (route, request) => {
            const headers = request.headers();
            headers['user-agent'] = mobileUserAgent;
            await route.continue({ headers });
        });

        // Ghi đè User-Agent ở mức Javascript để đánh lừa Client Facebook
        await page.addInitScript((ua) => {
            Object.defineProperty(navigator, 'userAgent', { get: () => ua });
            Object.defineProperty(navigator, 'platform', { get: () => 'iPhone' });
        }, mobileUserAgent);

        // Bắt tất cả các API gửi đi từ Facebook
        page.on('request', async request => {
            const url = request.url();
            if (url.includes('/api/graphql/') || url.includes('/graphql/')) {
                const postData = request.postData();
                if (postData && (postData.includes('profile_access') || postData.includes('admin_add') || postData.includes('target'))) {
                    console.log('\n=================================');
                    console.log('🔥 ĐÃ BẮT ĐƯỢC API GRAPHQL CÓ THỂ LÀ CHUYỂN QUYỀN!');
                    console.log('URL:', url);
                    console.log('Body (Payload):', postData.substring(0, 500) + '... [Cắt bớt cho gọn]');
                    console.log('=================================\n');
                }
            }
        });

        console.log('Đang mở trang cài đặt quyền trên giao diện Mobile...');
        await page.goto('https://m.facebook.com/settings/?tab=profile_access');

        console.log('✅ Đã mở xong! Hãy thao tác share quyền bằng tay trên cửa sổ trình duyệt đó.');
        console.log('Kịch bản đang chạy ngầm để bắt API... Nhấn Ctrl + C ở terminal để dừng.');

    } catch (error) {
        console.error('Có lỗi xảy ra:', error);
    }
}

captureSharePageAPI();
