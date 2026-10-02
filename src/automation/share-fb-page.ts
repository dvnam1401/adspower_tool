import { chromium, devices } from 'playwright-core';
import axios from 'axios';
import { Command } from 'commander';

const ADSPOWER_API = 'http://127.0.0.1:50325';

const program = new Command();
program
  .requiredOption('-p, --profile-name <name>', 'Tên hoặc ID của Profile AdsPower')
  .requiredOption('-t, --target <uid>', 'Tên, Link hoặc UID Facebook của người nhận quyền')
  .requiredOption('-pw, --password <password>', 'Mật khẩu của tài khoản Facebook hiện tại (để xác nhận)')
  .parse(process.argv);

const options = program.opts();

async function runSharePageAutomation() {
    try {
        console.log(`Đang tìm ID cho profile có tên: "${options.profileName}"...`);

        const listResponse = await axios.get(`${ADSPOWER_API}/api/v1/user/list?page_size=2000`);
        const profiles = listResponse.data?.data?.list || [];
        const targetProfile = profiles.find((p: any) => p.name === options.profileName || p.user_id === options.profileName);

        if (!targetProfile) {
            throw new Error(`Không tìm thấy profile: "${options.profileName}".`);
        }

        const profileId = targetProfile.user_id;
        console.log(`✅ Đã tìm thấy ID: ${profileId}`);

        // Đảm bảo trình duyệt mở
        let wsEndpoint = '';
        const activeResponse = await axios.get(`${ADSPOWER_API}/api/v1/browser/active?user_id=${profileId}`);

        if (activeResponse.data.code === 0 && activeResponse.data.data.ws) {
            wsEndpoint = activeResponse.data.data.ws.puppeteer;
        } else {
            console.log('Trình duyệt chưa mở. Đang khởi động...');
            const startResponse = await axios.get(`${ADSPOWER_API}/api/v1/browser/start?user_id=${profileId}`);
            if (startResponse.data.code !== 0) throw new Error('Lỗi bật trình duyệt: ' + startResponse.data.msg);
            wsEndpoint = startResponse.data.data.ws.puppeteer;
            await new Promise(r => setTimeout(r, 5000));
        }

        const browser = await chromium.connectOverCDP(wsEndpoint);
        const context = browser.contexts()[0] || await browser.newContext();
        const page = context.pages().length > 0 ? context.pages()[0] : await context.newPage();

        console.log('Đang thiết lập môi trường Mobile...');
        await page.setViewportSize({ width: 430, height: 932 });

        const mobileUserAgent = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1';
        await page.route('**/*', async (route, request) => {
            const headers = request.headers();
            headers['user-agent'] = mobileUserAgent;
            await route.continue({ headers });
        });

        await page.addInitScript((ua) => {
            Object.defineProperty(navigator, 'userAgent', { get: () => ua });
            Object.defineProperty(navigator, 'platform', { get: () => 'iPhone' });
        }, mobileUserAgent);

        console.log('Điều hướng đến trang cấu hình quyền...');
        await page.goto('https://m.facebook.com/settings/?tab=profile_access', { waitUntil: 'networkidle' });

        console.log('Đang tìm nút "Thêm mới" (Add New)...');
        // Click vào nút "Thêm mới" đầu tiên (thường là quyền Admin)
        const addNewBtn = page.locator('text="Thêm mới"').first();
        await addNewBtn.waitFor({ state: 'visible', timeout: 15000 });
        await addNewBtn.click();

        console.log('Bỏ qua màn hình hướng dẫn...');
        const nextBtn = page.locator('text="Tiếp"');
        await nextBtn.waitFor({ state: 'visible', timeout: 5000 });
        await nextBtn.click();

        console.log(`Tìm kiếm người dùng mục tiêu: ${options.target}`);
        const searchInput = page.locator('input[type="text"], input[placeholder*="Tìm kiếm"]').first();
        await searchInput.waitFor({ state: 'visible' });
        await searchInput.fill(options.target);

        // Chờ kết quả search đổ về và click dòng kết quả đầu tiên
        console.log('Chờ kết quả tìm kiếm...');
        await page.waitForTimeout(3000); // Đợi Facebook load API search

        // Cố gắng tìm dòng đầu tiên của kết quả search (Thường có ảnh đại diện)
        const firstResult = page.locator('div[role="button"]:has(img)').first();
        await firstResult.waitFor({ state: 'visible', timeout: 5000 }).catch(() => null);

        if (await firstResult.isVisible()) {
             await firstResult.click();
        } else {
             // Fallback
             console.log('Dùng fallback click kết quả...');
             await page.mouse.click(200, 300); // Tọa độ giả định dưới ô search
        }

        console.log('Bật công tắc: Cho phép toàn quyền kiểm soát...');
        const fullControlSwitch = page.locator('div[role="switch"]').first();
        await fullControlSwitch.waitFor({ state: 'visible' });

        // Lấy trạng thái xem switch bật hay tắt, nếu tắt (aria-checked=false) thì click
        const isChecked = await fullControlSwitch.getAttribute('aria-checked');
        if (isChecked !== 'true') {
            await fullControlSwitch.click();
        }

        console.log('Click nút "Cấp quyền truy cập"...');
        const grantAccessBtn = page.locator('text="Cấp quyền truy cập"').first();
        await grantAccessBtn.click();

        console.log('Chờ popup nhập mật khẩu...');
        const passwordInput = page.locator('input[type="password"], input[name="pass"]').first();
        await passwordInput.waitFor({ state: 'visible', timeout: 10000 });

        console.log('Điền mật khẩu xác nhận...');
        await passwordInput.fill(options.password);

        console.log('Xác nhận mật khẩu...');
        const confirmBtn = page.locator('text="Xác nhận"').first();
        await confirmBtn.click();

        console.log('✅ Đã chia quyền thành công! Vui lòng kiểm tra lại trên trình duyệt.');

        // Hoàn thành
        await page.waitForTimeout(5000);
        await browser.close();

    } catch (error) {
        console.error('❌ Lỗi xảy ra:', error);
    }
}

runSharePageAutomation();
