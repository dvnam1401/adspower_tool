# Kế hoạch triển khai Account Data Hub trên `adspower_tool`

## 0. Mục đích tài liệu

Tài liệu này là chỉ dẫn triển khai dành cho coding agent. Mục tiêu là bổ sung một phân hệ quản lý tài khoản, đồng bộ Google Sheets và đối soát AdsPower vào mã nguồn hiện tại mà không làm thay đổi hành vi của các chức năng đang hoạt động ổn định.

Agent phải thực hiện lần lượt theo từng phase, dừng kiểm tra sau mỗi phase và không mở rộng phạm vi nếu chưa đạt điều kiện nghiệm thu.

## 1. Mục tiêu nghiệp vụ

Xây dựng `Account Data Hub` làm nguồn dữ liệu trung tâm cho:

- Profile AdsPower.
- Tài khoản mạng xã hội và thông tin đăng nhập.
- Nội dung liên kết từ các Google Sheets.
- Link kênh YouTube.
- Trạng thái tài khoản: sống, die, chờ kiểm tra và trạng thái tùy chỉnh.
- Trạng thái AdsPower: chưa nhập, đang nhập, đang tồn tại, chờ xóa, đã xóa và lỗi đồng bộ.
- Trường dữ liệu tùy chỉnh do người quản lý tự tạo.
- Mapping một trường hệ thống tới một hoặc nhiều file/tab/cột Google Sheets.
- Import hàng loạt tài khoản chưa có trên AdsPower và đưa vào hàng đợi auto login.
- Đồng bộ có kiểm soát từ hệ thống lên Google Sheets và, ở phase sau, từ các cột được phép của Google Sheets về hệ thống.

## 2. Nguyên tắc không phá chức năng đang chạy

### 2.1 Phạm vi được bảo vệ

Không refactor hoặc thay đổi hành vi của các module hiện có sau:

- `src/adspower/client.ts`
- `src/automation/batch-runner.ts`
- `src/automation/facebook-login.ts`
- `src/workflow/engine.ts`
- `src/recovery/**`
- `src/dom/**`
- Các API `/api/profiles`, `/api/groups`, `/api/browser/*`, `/api/workflow/*` hiện tại.
- Giao diện quản lý profile/automation hiện tại trong `public/app.js` và `public/index.html`.

Chỉ được sửa một file được bảo vệ khi không còn cách tích hợp khác. Trước khi sửa, agent phải ghi rõ lý do trong PR/nhật ký triển khai và giữ thay đổi ở mức nhỏ nhất.

### 2.2 Cách mở rộng bắt buộc

- Tạo module mới dưới `src/account-hub/**`.
- Tạo router mới, không chèn hàng loạt route vào `src/server/app.ts`.
- Tạo giao diện mới dưới `public/account-hub/**`, không viết thêm logic lớn vào `public/app.js`.
- Chỉ thêm một điểm mount router và một liên kết điều hướng khi phân hệ đã vượt qua kiểm thử.
- Tất cả scheduler/worker mới phải được bảo vệ bằng feature flag.
- Feature flag mặc định phải là `false` để bản build mới vẫn hoạt động như phiên bản cũ.
- Không tự động xóa profile AdsPower trong MVP.
- Không tự động ghi Google Sheets trong chế độ dry-run.
- Không dùng dữ liệu thật để test thao tác xóa.

### 2.3 Feature flags

Thêm cấu hình nhưng mặc định tắt:

```env
ACCOUNT_HUB_ENABLED=false
ACCOUNT_HUB_DB_PATH=./data/account-hub.sqlite
ACCOUNT_HUB_SHEET_SYNC_ENABLED=false
ACCOUNT_HUB_ADSPOWER_RECONCILE_ENABLED=false
ACCOUNT_HUB_AUTO_IMPORT_ENABLED=false
ACCOUNT_HUB_AUTO_LOGIN_ENABLED=false
ACCOUNT_HUB_DRY_RUN=true
```

Nếu `ACCOUNT_HUB_ENABLED=false`, không router, worker hoặc kết nối Google nào của phân hệ mới được khởi động.

## 3. Khảo sát và baseline bắt buộc trước khi code

Agent phải hoàn thành checklist sau và lưu kết quả ngắn gọn trong `docs/account-hub-baseline.md`:

1. Chạy `npm run build` và ghi kết quả.
2. Chạy các test hiện có, nếu có.
3. Chạy kiểm tra kết nối AdsPower bằng phương thức read-only; không start/close/delete profile.
4. Liệt kê các route hiện tại và xác nhận không trùng prefix `/api/account-hub`.
5. Kiểm tra trạng thái Git và không ghi đè thay đổi chưa commit của người dùng.
6. Sao lưu file cấu hình/dữ liệu chỉ khi test migration trên dữ liệu thật; ưu tiên database test riêng.
7. Ghi lại hành vi hiện tại của `/api/status`, `/api/profiles`, đăng nhập và trang chính.

Không tiếp tục nếu baseline đã lỗi. Khi đó agent chỉ báo cáo lỗi có sẵn, không sửa lỗi ngoài phạm vi.

## 4. Kiến trúc module mới

Tạo cấu trúc dự kiến:

```text
src/account-hub/
  index.ts
  config.ts
  domain/
    account.ts
    custom-field.ts
    sheet-mapping.ts
    sync-job.ts
    status.ts
  db/
    connection.ts
    migrations.ts
    repositories/
      account-repository.ts
      custom-field-repository.ts
      mapping-repository.ts
      sync-job-repository.ts
      audit-log-repository.ts
  services/
    account-service.ts
    matching-service.ts
    custom-field-service.ts
    merged-cell-service.ts
    conflict-service.ts
  adspower/
    adapter.ts
    reconcile-service.ts
    import-queue.ts
    login-queue.ts
  google-sheets/
    client.ts
    source-service.ts
    schema-reader.ts
    row-reader.ts
    row-writer.ts
    formatting-service.ts
    sync-service.ts
  jobs/
    scheduler.ts
    worker.ts
  api/
    router.ts
    validation.ts
    serializers.ts
  events/
    event-bus.ts
    sse-router.ts

public/account-hub/
  index.html
  app.js
  style.css

tests/account-hub/
  fixtures/
  unit/
  integration/
```

Không import ngược module `account-hub` vào workflow/recovery cũ. Phân hệ mới chỉ gọi các API public của hệ thống cũ qua adapter.

## 5. Database và migration

### 5.1 Lựa chọn

MVP dùng SQLite riêng tại `ACCOUNT_HUB_DB_PATH`, bật WAL và foreign keys. Không dùng chung hoặc thay thế các file JSON hiện có. Không sử dụng `DATABASE_PATH` cũ để tránh ảnh hưởng auth và cấu hình đang chạy.

### 5.2 Bảng tối thiểu

#### `accounts`

- `id`: UUID nội bộ, khóa chính.
- `profile_name`: tên hiển thị.
- `normalized_profile_name`: tên đã chuẩn hóa, có index nhưng không unique.
- `adspower_user_id`: nullable, unique khi có giá trị.
- `adspower_serial_number`: nullable.
- `adspower_group_id`: nullable.
- `linked_content`: nội dung liên kết, có thể map với cột D.
- `login_id`, `password`, `two_factor_secret`.
- `hotmail`, `hotmail_password`, `recovery_mail`.
- `cookie`, `token`.
- `youtube_channel_url`.
- `account_status`.
- `adspower_status`.
- `assigned_to`.
- `last_seen_adspower_at`, `die_marked_at`, `deleted_from_adspower_at`.
- `version`: optimistic locking.
- `created_at`, `updated_at`, `created_by`, `updated_by`.
- `archived_at`: soft delete; không xóa cứng trong MVP.

#### `custom_field_definitions`

- Tên kỹ thuật, tên hiển thị, kiểu dữ liệu.
- Cờ sensitive/copyable/searchable/filterable/list-visible.
- Validation JSON và display order.

#### `custom_field_values`

- `account_id`, `field_definition_id`.
- Giá trị dạng text/JSON đã chuẩn hóa.
- Unique trên cặp account-field.

#### `sheet_sources`

- Spreadsheet ID, tên nguồn, credential reference.
- Sync direction, enabled, priority.
- Header row, first data row, poll interval.
- Không lưu private key trực tiếp trong database.

#### `sheet_tabs`

- `source_id`, Google Sheet numeric ID, tab title.
- Quy tắc xử lý hàng, vùng dữ liệu và vùng merge.

#### `field_mappings`

- Trường hệ thống hoặc custom field.
- Source/tab/column.
- Chiều đồng bộ.
- Transform/normalization rule.
- Conflict policy.
- Có phải key candidate hay không.

#### `sheet_row_bindings`

- `account_id`, source/tab, row index gần nhất.
- Row fingerprint.
- Last-read/last-written hash.
- Last sync timestamp.

#### `sync_jobs` và `sync_job_items`

- Loại job, trạng thái, tiến độ, lỗi, retry count.
- Idempotency key để retry không ghi trùng.

#### `audit_logs`

- Actor, action, entity, before JSON, after JSON, source, timestamp.
- Không ghi plaintext password/cookie/token/2FA vào log.

#### `conflicts`

- Dữ liệu database, dữ liệu Sheet, nguồn, field, trạng thái xử lý.

### 5.3 Migration rules

- Migration chỉ tiến, có số phiên bản.
- Mỗi migration phải chạy được nhiều lần an toàn hoặc có bảng migration lock.
- Test migration trên database tạm trước.
- Không tự động migrate nếu feature flag chưa bật.

## 6. Domain model và trạng thái

### 6.1 `account_status`

```text
LIVE | DIE | CHECKING | LOCKED | NEED_LOGIN | ERROR | CUSTOM
```

### 6.2 `adspower_status`

```text
NOT_IMPORTED
IMPORT_PENDING
IMPORTING
LOGIN_PENDING
LOGIN_RUNNING
ACTIVE
DELETE_PENDING
DELETED
MISSING
SYNC_ERROR
```

### 6.3 Quy tắc quan trọng

- `DIE + ACTIVE/MISSING chưa xác nhận`: giao diện viền sáng; Sheet dùng nền đỏ, chữ đậm và viền dày.
- `DIE + DELETED`: nền đỏ nhạt, chữ thường, không viền sáng.
- `LIVE + DELETED/MISSING`: cảnh báo nghiêm trọng, không tự đổi `account_status`.
- Đánh dấu DIE không gọi API xóa tự động trong MVP.
- Xóa AdsPower phải là hành động riêng, có xác nhận và phân quyền.

## 7. Matching profile theo tên

Tên chỉ dùng để bootstrap liên kết ban đầu.

### 7.1 Chuẩn hóa

- Trim khoảng trắng.
- Gom nhiều khoảng trắng thành một.
- Lowercase để so sánh.
- Chuẩn hóa `/`, `-` và khoảng trắng quanh ký tự phân cách.
- Không bỏ số hoặc ngày vì đây có thể là thành phần phân biệt profile.

### 7.2 Kết quả matching

- Đúng một kết quả: tạo đề xuất liên kết.
- Không có kết quả: `NOT_IMPORTED`.
- Nhiều kết quả: tạo conflict, không tự liên kết.
- Chỉ lưu `adspower_user_id` sau khi người dùng xác nhận hoặc exact match duy nhất qua job được phê duyệt.
- Sau khi đã bind, mọi đối soát dùng `adspower_user_id`; tên chỉ còn là dữ liệu hiển thị.

Không được tự động fuzzy-match rồi ghi dữ liệu thật.

## 8. Google Sheets connector tùy chỉnh

### 8.1 Xác thực

- Hỗ trợ service account trước.
- Credential lấy từ biến môi trường hoặc file ngoài repository.
- Không commit credential, token hoặc private key.
- Trang cấu hình chỉ lưu `credential reference`.

### 8.2 Cấu hình nguồn

Người dùng có thể nhập:

- Spreadsheet URL/ID.
- Tab cần xử lý.
- Header row và first data row.
- Trường hệ thống ↔ cột Sheet.
- Chế độ read/write/two-way.
- Cột khóa và chính sách xung đột.

### 8.3 Đọc đúng hàng/cột/merge

Connector phải đọc đồng thời values, formulas và metadata merge.

Quy tắc:

1. Ô trên-trái của merge là giá trị gốc.
2. Giá trị được kế thừa logic xuống các hàng thuộc vùng merge khi dựng record.
3. Lưu metadata vùng merge trong kết quả import.
4. Khi ghi, chỉ ghi ô trên-trái.
5. Nếu các record thuộc cùng vùng merge yêu cầu giá trị khác nhau, tạo conflict; không unmerge.
6. Không thay đổi công thức hoặc format ngoài cột được mapping.

### 8.4 Row identity

Không dùng row index làm khóa duy nhất. Dùng thứ tự ưu tiên:

1. `adspower_user_id` nếu Sheet có cột này.
2. `account internal id` nếu đã được hệ thống ghi ra Sheet.
3. Exact normalized profile name kết hợp login ID/email.
4. Row fingerprint.
5. Nếu vẫn không chắc chắn: conflict cần xác nhận.

### 8.5 Đồng bộ ghi

- MVP chỉ ghi khi người dùng bấm `Lưu và đồng bộ` hoặc `Đồng bộ`.
- Trước khi ghi phải đọc lại các ô đích và so với last-read hash.
- Nếu Sheet đã đổi từ lần đọc trước, không ghi đè; tạo conflict.
- Gom batch update theo spreadsheet/tab.
- Sau khi ghi phải đọc lại để verify.
- Job có thể thành công một phần theo từng nguồn; retry chỉ chạy item lỗi.

### 8.6 Format trạng thái

- `DIE + chưa xóa`: nền đỏ/cam, chữ đậm, viền dày.
- `DIE + đã xóa`: nền đỏ nhạt, chữ thường, bỏ viền dày.
- Format bằng Sheets API/Apps Script adapter, không coi màu ô là nguồn trạng thái.
- Format chỉ áp dụng vùng/cột đã cấu hình.

## 9. AdsPower adapter và reconciliation

### 9.1 Adapter

Tạo wrapper trong `src/account-hub/adspower/adapter.ts` dùng instance `adsPowerClient` hiện có. Không sao chép logic request, cache hoặc auth API key.

Các năng lực:

- Lấy toàn bộ profile read-only.
- Tìm theo `user_id`.
- Tạo profile qua phương thức được bổ sung có test riêng, nếu client hiện chưa có.
- Xóa profile chỉ ở phase có xác nhận.
- Không thay đổi hành vi các method start/close/list hiện có.

Nếu phải bổ sung method vào `src/adspower/client.ts`, chỉ append method mới và type mới; không refactor method cũ.

### 9.2 Reconcile job

- Tải danh sách AdsPower theo batch/page.
- So sánh bằng `adspower_user_id` trước, tên chỉ dùng cho record chưa bind.
- Cập nhật `last_seen_adspower_at`.
- Không thấy profile sau một lần polling chưa được coi là deleted.
- Chỉ chuyển `DELETED/MISSING` sau tối thiểu hai lần kiểm tra liên tiếp và một full reconciliation thành công.
- Nếu AdsPower API lỗi hoặc trả danh sách thiếu trang, hủy kết luận xóa.
- Mặc định polling 30 giây; full reconciliation 5 phút; có thể cấu hình.

## 10. Import hàng loạt và auto login

### 10.1 Import preview

Trước khi tạo profile phải hiển thị:

- Bao nhiêu record hợp lệ.
- Bao nhiêu record thiếu dữ liệu.
- Bao nhiêu record đã có AdsPower ID.
- Bao nhiêu record trùng tên.
- Nhóm, proxy và cấu hình fingerprint sẽ dùng.

### 10.2 Queue

- Import và login là hai job độc lập.
- Mỗi item có trạng thái, retry count và lỗi cụ thể.
- Giới hạn concurrency riêng; không dùng hoặc sửa concurrency của workflow hiện tại.
- Có pause/resume/cancel.
- Idempotency key ngăn tạo trùng profile khi retry.
- Sau khi tạo thành công phải lưu `adspower_user_id` trước khi chạy login.
- Login thất bại không được rollback/xóa profile vừa tạo tự động.
- CAPTCHA hoặc xác minh thủ công chuyển thành `NEEDS_ATTENTION`.

### 10.3 Dry-run

Khi `ACCOUNT_HUB_DRY_RUN=true`:

- Không tạo/xóa AdsPower profile.
- Không ghi Google Sheets.
- Vẫn cho phép preview, validate, matching và xuất báo cáo dự kiến thay đổi.

## 11. API mới

Prefix bắt buộc: `/api/account-hub`.

### Accounts

```text
GET    /accounts
GET    /accounts/:id
POST   /accounts
PATCH  /accounts/:id
POST   /accounts/:id/sync
POST   /accounts/bulk-sync
POST   /accounts/import-preview
POST   /accounts/bulk-import-adspower
```

### Status và AdsPower

```text
POST   /accounts/:id/mark-die
POST   /accounts/:id/recheck-adspower
POST   /accounts/:id/request-delete
POST   /accounts/:id/confirm-delete
POST   /reconcile/adspower
GET    /reconcile/summary
```

`confirm-delete` không triển khai hoạt động thật trong MVP đầu tiên; trả về `feature disabled` nếu flag xóa chưa được cấp.

### Google Sheets

```text
GET    /sheet-sources
POST   /sheet-sources
PATCH  /sheet-sources/:id
POST   /sheet-sources/:id/test
POST   /sheet-sources/:id/inspect
POST   /sheet-sources/:id/import-preview
POST   /sheet-sources/:id/import
GET    /field-mappings
POST   /field-mappings
PATCH  /field-mappings/:id
```

### Custom fields, jobs và conflicts

```text
GET/POST/PATCH /custom-fields
GET            /sync-jobs
GET            /sync-jobs/:id
POST           /sync-jobs/:id/retry
GET            /conflicts
POST           /conflicts/:id/resolve
GET            /events
```

Tất cả endpoint ghi phải dùng auth middleware hiện có, validation schema, audit log và optimistic locking.

## 12. Giao diện mới

Tạo trang riêng `/account-hub/`, không thay cấu trúc trang profile hiện tại trong phase đầu.

### 12.1 Bảng tài khoản

- Server-side pagination hoặc virtual scrolling.
- Search Profile, ID, Hotmail, YouTube URL.
- Lọc trạng thái tài khoản và AdsPower.
- Chọn/ẩn/sắp xếp cột; lưu preference theo user.
- Trường mặc định read-only.
- Nút copy riêng cho từng trường.
- Password/2FA/cookie/token che mặc định.
- Chỉ sửa sau khi bấm `Edit`.
- `Save draft` chỉ ghi database.
- `Save & Sync` ghi database rồi tạo sync job.
- Không gửi plaintext secret vào DOM cho đến khi người có quyền yêu cầu xem.

### 12.2 Hiển thị trạng thái

- `DIE + chưa xóa`: class viền glow đỏ/cam.
- `DIE + DELETED`: đỏ nhạt, không glow, không bold.
- Có bộ lọc nhanh `DIE chưa xóa`.
- Có cột `Đồng bộ gần nhất` và biểu tượng lỗi/xung đột.

### 12.3 Các màn hình phụ

- Chi tiết tài khoản và lịch sử.
- Cấu hình nguồn Google Sheets.
- Mapping field/cột.
- Import preview.
- Import/login queue.
- Sync center.
- Conflict resolution.
- Custom field manager.

## 13. Bảo mật

- Không log password, cookie, token, 2FA hoặc private key.
- Secret API response phải được redaction trước logger.
- Dữ liệu nhạy cảm được mã hóa at rest; khóa mã hóa lấy từ environment/OS secret store, không nằm trong DB.
- Phân quyền tối thiểu: viewer, operator, manager, admin.
- Viewer không được xem/copy secret.
- Operator chỉ thao tác tài khoản được giao.
- Chỉ manager/admin được import AdsPower, resolve conflict hoặc yêu cầu xóa.
- Audit thao tác xem/copy/sửa secret.

## 14. Kiểm thử bắt buộc

### 14.1 Unit tests

- Chuẩn hóa tên.
- Exact match/no match/duplicate match.
- State transition.
- Merge inheritance và ghi ô trên-trái.
- Row fingerprint.
- Conflict detection.
- Secret redaction.
- Idempotency của sync/import job.

### 14.2 Integration tests

- Database migration trên file tạm.
- CRUD account và optimistic locking.
- Google Sheets client bằng fake adapter/fixture; không dùng Sheet thật trong CI.
- AdsPower adapter bằng mock HTTP server.
- Pagination lỗi giữa chừng không được đánh dấu profile deleted.
- Ghi nhiều source: một source lỗi, source khác thành công, retry đúng item lỗi.

### 14.3 Regression tests

Sau mỗi phase:

- `npm run build` thành công.
- Các test cũ vẫn qua.
- `/api/status`, `/api/profiles`, đăng nhập và UI cũ không đổi hành vi.
- Khi feature flag tắt, không tạo database mới, scheduler hoặc request Google Sheets.
- Không có route cũ bị đổi response schema.

### 14.4 Manual acceptance

Dùng Sheet test copy, không dùng file vận hành:

1. Import sheet có hàng thường và ô merge.
2. Kiểm tra dữ liệu hiển thị đúng theo hàng/cột.
3. Sửa account ở chế độ Edit.
4. Preview sync và kiểm tra đúng file/tab/cột.
5. Ghi thử rồi verify lại.
6. Tạo thay đổi xung đột trên Sheet và xác nhận hệ thống không ghi đè.
7. Đánh dấu DIE khi profile còn tồn tại: có glow/viền dày.
8. Mock profile đã xóa: bỏ glow/viền, giữ đỏ nhạt.
9. Import preview tài khoản chưa có AdsPower.
10. Dry-run xác nhận không tạo profile hoặc ghi Sheet.

## 15. Thứ tự triển khai

### Phase 0 — Baseline và feature flags

Deliverables:

- Baseline report.
- Config/feature flags.
- Router mới trả health response khi bật.

Gate: feature flag tắt phải cho kết quả build và hành vi giống baseline.

### Phase 1 — Database và Account API

Deliverables:

- Migration.
- Repository/service.
- CRUD account, custom fields, audit log.
- Unit/integration tests.

Chưa kết nối Google Sheets và chưa ghi AdsPower.

### Phase 2 — Giao diện quản lý read-only/edit

Deliverables:

- Trang `/account-hub/`.
- Bảng, filter, copy, mask secret, edit/save draft.
- Status visuals và SSE refresh.

Chưa bật sync thật.

### Phase 3 — Google Sheets inspect/import preview

Deliverables:

- Source/tab/mapping UI.
- Đọc schema, values, formulas, merge metadata.
- Import preview, matching/conflict report.
- Import vào DB sau xác nhận.

Chưa ghi Sheet.

### Phase 4 — Google Sheets outbound sync

Deliverables:

- `Save & Sync`.
- Batch writer, formatting, verify, retry và sync center.
- Dry-run mặc định.

Chỉ bật ghi trên Sheet test trước.

### Phase 5 — AdsPower reconciliation

Deliverables:

- Adapter read-only.
- Binding theo tên lần đầu và lưu `user_id`.
- Polling/full reconciliation.
- Trạng thái DIE/chờ xóa/đã xóa.

Chưa xóa profile tự động.

### Phase 6 — Bulk create và auto login queue

Deliverables:

- Import preview.
- Create queue.
- Login queue.
- Pause/resume/cancel/retry.
- Manual-attention state.

Chỉ bật trên nhóm AdsPower test trước.

### Phase 7 — Controlled inbound/two-way sync

Deliverables:

- Chỉ đọc ngược các cột được whitelist.
- Conflict resolution UI.
- Version/hash protection.

Không bật hai chiều cho password/cookie/token mặc định.

### Phase 8 — Controlled deletion

Chỉ triển khai khi người dùng phê duyệt riêng:

- Request delete.
- Confirm dialog hiển thị tên và AdsPower ID.
- Role permission.
- Recheck trước khi xóa.
- Gọi xóa một profile hoặc batch có giới hạn.
- Verify sau xóa và audit.

Không bao giờ suy diễn quyền xóa từ trạng thái DIE.

## 16. Chiến lược commit và review

- Một phase tương ứng một PR/nhóm commit độc lập.
- Không trộn refactor unrelated.
- Commit migration riêng với UI.
- Không commit `.env`, credential, database thật hoặc dữ liệu tài khoản.
- Mỗi PR ghi rõ files created, files existing modified và lý do.
- Ưu tiên tạo file mới; mọi sửa file cũ phải nhỏ và có regression test.

## 17. Rollback

- Tắt toàn bộ phân hệ bằng `ACCOUNT_HUB_ENABLED=false`.
- Scheduler phải dừng sạch khi flag tắt hoặc app shutdown.
- Database Account Hub là file riêng nên rollback không ảnh hưởng dữ liệu cũ.
- Các thay đổi Google Sheets phải có audit và before value để hỗ trợ restore theo job.
- Không rollback bằng cách ghi đè toàn bộ Sheet; chỉ phục hồi các ô thuộc job đã xác định.
- Nếu phase mới lỗi, revert riêng commit phase đó; không reset hoặc xóa thay đổi của người dùng.

## 18. Definition of Done toàn dự án

Chỉ coi hoàn thành khi:

- Chức năng cũ vượt qua regression baseline.
- Có database trung tâm và audit log.
- Người dùng cấu hình được nhiều Spreadsheet/tab và mapping tùy chỉnh.
- Import đọc đúng hàng, cột và merge.
- Bảng tài khoản read-only mặc định, copy từng trường và chỉ sửa qua Edit.
- `Save & Sync` ghi đúng các nguồn được map, verify sau ghi và báo partial failure.
- DIE chưa xóa có glow/viền; DIE đã xóa không glow/không bold.
- Profile được bind sang AdsPower ID sau matching theo tên.
- Bulk import và auto login chạy bằng queue có idempotency.
- Có dry-run, conflict resolution, retry và rollback.
- Không tự động xóa AdsPower khi chưa có phê duyệt riêng.
- Không có secret trong Git hoặc log.

## 19. Lệnh bắt đầu dành cho agent triển khai

Agent nhận tài liệu này phải bắt đầu bằng Phase 0, không code toàn bộ một lần. Trình tự bắt buộc:

1. Đọc toàn bộ repository instructions và tài liệu kiến trúc hiện có.
2. Kiểm tra Git/worktree và baseline.
3. Báo cáo những file dự kiến tạo/sửa.
4. Triển khai Phase 0.
5. Build/test/regression.
6. Chờ phê duyệt hoặc yêu cầu tiếp tục Phase 1.

Nếu phát hiện yêu cầu của phase buộc phải sửa lớn module đang chạy, agent phải dừng, mô tả điểm tích hợp và đề xuất phương án ít xâm lấn hơn trước khi thay đổi.
