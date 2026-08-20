# Account Hub — Baseline Report

> Tài liệu này ghi nhận trạng thái hệ thống trước khi Account Hub được tích hợp.
> Được tạo theo yêu cầu của mục 3 trong `ACCOUNT_DATA_HUB_IMPLEMENTATION_PLAN.md`.
> **Không tự động cập nhật** — đây là ảnh chụp thời điểm Phase 0.

---

## 1. Kết quả build

```
> adspower-hybrid-automation@1.0.0 build
> tsc

(Không có lỗi, exit code 0)
```

**Trạng thái**: ✅ Build sạch, 0 TypeScript error.

---

## 2. Trạng thái Git

- Branch: `main`
- Commits: 4 (`8601e11 ver3`, `426215c`, `e50d76b`, `6f5539e first commit`)
- Working tree: **clean** (không có uncommitted changes khi baseline được chụp)
- `.gitignore` đã bảo vệ: `.env`, `data/system_config.json`, `data/*.sqlite`

---

## 3. Route inventory hiện tại

Prefix được dùng trước khi Account Hub:

| Prefix | Mô tả |
|---|---|
| `POST /api/auth/login` | Đăng nhập |
| `POST /api/auth/status` | Kiểm tra session |
| `POST /api/auth/change-password` | Đổi mật khẩu |
| `GET /api/profiles` | Lấy danh sách AdsPower profile |
| `GET /api/groups` | Lấy danh sách nhóm |
| `POST /api/browser/start` | Mở browser |
| `POST /api/browser/close` | Đóng browser |
| `GET /api/browser/active` | Kiểm tra browser đang chạy |
| `POST /api/workflow/*` | Workflow engine |
| `GET /api/events` | SSE stream |
| `GET /api/status` | Health check |

**Xác nhận**: Prefix `/api/account-hub` **chưa tồn tại** → an toàn để mount mới.

---

## 4. Hành vi các endpoint quan trọng

### `GET /api/status`
Trả về health check của server và kết nối AdsPower. Không bị ảnh hưởng bởi Account Hub.

### `GET /api/profiles`
Đọc trực tiếp từ AdsPower Local API. Không có cache hay database. Không bị ảnh hưởng.

### Login (`POST /api/auth/login`)
Dùng `authRepository` với SQLite tại `DATABASE_PATH` (mặc định `./data/adspower_automation.sqlite`).
Account Hub dùng file **riêng** `./data/account-hub.sqlite` — không xung đột.

### UI cũ (`public/index.html`, `public/app.js`)
Không thay đổi. Account Hub sẽ tạo trang riêng tại `public/account-hub/`.

---

## 5. Ghi chú về `google-sheet.ts` hiện tại

File `src/automation/google-sheet.ts` là **mock stub**:

```typescript
export class GoogleSheetService {
  async getBackupData(profileId: string): Promise<BackupCredentials | null> {
    // Returns hardcoded mock data — NOT a real Sheets API call
  }
  async updateStatus(profileId: string, status: AccountStatus): Promise<void> {
    // No-op log only
  }
}
```

Account Hub **không** sửa file này. Client Sheets thật sẽ được tạo mới tại
`src/account-hub/google-sheets/client.ts` trong Phase 3.

---

## 6. Dependencies cần thêm ở phase sau

| Package | Phase | Mục đích |
|---|---|---|
| `better-sqlite3` + `@types/better-sqlite3` | Phase 1 | SQLite database, WAL mode |
| `googleapis` | Phase 3 | Google Sheets API v4 |
| `zod` | Phase 1 | Đã có trong dependencies ✅ |

---

## 7. Checklist hoàn thành

- [x] `npm run build` thành công, 0 lỗi
- [x] Không có test hiện có bị break (không có test framework nào được cấu hình trước Phase 0)
- [x] Kiểm tra kết nối AdsPower: chỉ read-only, không start/close/delete
- [x] Liệt kê route hiện tại, xác nhận không trùng `/api/account-hub`
- [x] Git status: clean, không ghi đè uncommitted changes của người dùng
- [x] Database test sẽ dùng file riêng (không chạm `adspower_automation.sqlite`)
- [x] Hành vi `/api/status`, `/api/profiles`, login và UI cũ được ghi nhận
- [x] Feature flag mặc định `ACCOUNT_HUB_ENABLED=false` — build mới = build cũ

---

*Tạo bởi agent Phase 0 — ngày 2026-08-20*
