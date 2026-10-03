# Kịch bản triển khai — Data Warehouse đồng bộ TK / BC / Reup / AdsPower

Phiên bản: cập nhật sau khi chốt các quyết định nghiệp vụ. Tài liệu này dành cho agent/dev triển khai trực tiếp.

---

## 0. Nguyên tắc đã chốt (không thảo luận lại)

| # | Chủ đề | Quyết định cuối cùng |
|---|---|---|
| 1 | Trùng lặp dữ liệu | Dữ liệu trong TK/BC được giả định là duy nhất theo nghiệp vụ, nhưng hệ thống **phải tự kiểm tra và cảnh báo ngay lập tức** nếu phát hiện trùng (Profile, ID). Không tự động xử lý, chỉ cảnh báo. |
| 2 | Cấu hình mapping | **100% tự cấu hình qua UI**: file/spreadsheet, tab, cột nguồn, cột đích, kể cả bảng ánh xạ quốc gia → tab Reup. Không hard-code bất kỳ tên tab hay tên cột nào trong code. |
| 3 | Trạng thái DIE | Chỉ đọc/ghi màu **đỏ tại đúng vùng ô F:G** trong BC (và toàn dòng trong TK) để biểu diễn DIE. Các màu khác trên sheet là ký hiệu riêng của người dùng, **hệ thống không đọc, không diễn giải, không đụng vào**. |
| 4 | Khớp kênh (BC ↔ Reup) | Tìm thấy → copy link kênh từ Reup sang trường "Link kênh kết nối" ở BC/warehouse. Không tìm thấy → để trống, đưa vào danh sách "cần xử lý", **không chặn** bất kỳ luồng nào khác. |
| 5 | Rate limit / lock | Cần cơ chế ổn định cho dữ liệu lớn — thiết kế ở mục 6. |
| 6 | Phân quyền Sheets | Người dùng tự cấp quyền ghi/sửa cho service account trên từng Google Sheet. |
| 7 | Đồng bộ | Mục tiêu **near-real-time** (Apps Script push + polling đối soát), không có webhook gốc theo ô của Google Sheets. |

---

## 1. Kiến trúc tổng quan

```
Google Sheets (TK / BC / Reup)
   │  (Apps Script onEdit/onChange trigger)
   ▼
Webhook Ingest API  ──────────────► Change Queue (per spreadsheet+tab)
                                          │
                                          ▼
                                 Sync Worker Pool
                              (rate-limited, ≤ N job song song)
                                          │
                     ┌────────────────────┼────────────────────┐
                     ▼                    ▼                    ▼
              Sheets Gateway       Normalization &        Conflict/Dup
              (batchGet/Update,    Matching Engine        Detector
               token bucket)                                    │
                     │                                           ▼
                     ▼                                    Notification
              Warehouse DB                                (in-app + badge)
         (profiles, credentials, channels,
          assignments, proxies, source_mappings,
          sync_jobs, sync_logs, audit_logs)
                     │
                     ▼
        Reconciliation Poller (định kỳ, đọc toàn bộ + so hash)
                     │
                     ▼
              AdsPower Integration ── Automation Job Queue
```

Ba lớp tách biệt rõ ràng:
- **Sheets Gateway**: điểm duy nhất được phép gọi Google Sheets API (đọc lẫn ghi).
- **Sync Engine**: chuẩn hóa, đối chiếu, phát hiện trùng/xung đột.
- **Warehouse DB**: nguồn sự thật cho web app và automation.

---

## 2. Cấu hình nguồn dữ liệu tự phục vụ (self-service mapping)

### 2.1. Bảng `source_mappings` — không hard-code

Mỗi dòng mapping gồm: `spreadsheet_id`, `tab_name`, `header_row`, `data_start_row`, `source_column` (letter hoặc tên header), `target_field` (trường warehouse), `sync_direction` (read-only / write-only / read-write / disabled), `normalization_rule`, `priority`.

UI cấu hình (theo đúng mục 9 bản thiết kế gốc) cho phép:
- Dán link/ID spreadsheet → hệ thống liệt kê danh sách tab thật (gọi Sheets API `spreadsheets.get`).
- Chọn tab → preview 10–20 dòng đầu để chọn header row / data start row.
- Kéo-thả hoặc chọn cột nguồn → cột đích, xem trước dữ liệu ánh xạ theo hàng ngang trước khi lưu.
- Với bảng quốc gia → tab Reup: màn hình riêng cho phép thêm/sửa/xóa cặp (mã quốc gia, tên tab, alias) — **không giới hạn 3 quốc gia mặc định**, admin có thể thêm quốc gia mới bất cứ lúc nào.

### 2.2. Cơ chế tự phục hồi khi người dùng đổi tên cột/tab

- Job đồng bộ, trước khi chạy, kiểm tra checksum cấu trúc (tên cột đã cấu hình có còn tồn tại không).
- Nếu mất khớp: **tạm dừng mapping đó**, gợi ý cột có tên gần giống (fuzzy match tên cột), yêu cầu người dùng xác nhận lại trong UI. Không tự chuyển mapping rồi ghi dữ liệu.

---

## 3. Phát hiện trùng lặp — cảnh báo ngay lập tức

Áp dụng cho cả batch-import lẫn sync theo thời gian thực (không chỉ chạy 1 lần offline):

| Kiểm tra | Phạm vi | Hành động khi phát hiện |
|---|---|---|
| Trùng `Profile` | Trong TK | Toast/thông báo ngay trong UI + entry mới trong "Lỗi dữ liệu" |
| Trùng `ID` (tài khoản) | Trong TK | Thông báo ngay, gắn cờ `duplicate_id = true` lên cả 2 bản ghi |
| Trùng `Hotmail` | Trong TK | Thông báo ngay (mức cảnh báo thấp hơn, vì 1 hotmail có thể phục vụ nhiều tài khoản) |
| Trùng `channel_name` sau chuẩn hóa | Trong 1 tab Reup | Thông báo ngay, không tự chọn kênh nào khi khớp |

Cơ chế kỹ thuật: mỗi lần Sync Worker ghi nhận thay đổi (từ webhook hoặc reconciliation), chạy kiểm tra unique-constraint tại tầng ứng dụng **trước khi commit** vào DB. Nếu vi phạm → vẫn lưu bản ghi (không chặn dữ liệu vào warehouse) nhưng gắn `flag: DUPLICATE` + đẩy **thông báo real-time** (in-app notification/badge đỏ trên Dashboard, không chỉ nằm im trong màn hình lỗi).

---

## 4. Trạng thái DIE — chỉ đỏ, chỉ F:G / toàn dòng TK

### Đọc (import)
- TK: một dòng được coi là DIE khi **toàn bộ dòng** có `fill.fgColor.rgb == FFFF0000` (hoặc theme tương đương đỏ chuẩn — cần chốt đúng 1 mã màu cụ thể với người dùng khi cấu hình lần đầu, vì Google Sheets có thể xuất nhiều sắc đỏ khác nhau).
- BC: một Profile được coi là DIE khi **đúng vùng ô F:G gộp tương ứng với Profile đó** có màu đỏ. Tuyệt đối không đọc màu của cột D hay bất kỳ cột nào khác — kể cả khi cột đó cũng đang có màu đỏ (đây là ký hiệu riêng của người dùng, bỏ qua).
- Nếu TK và BC cho ra 2 kết luận trạng thái khác nhau cho cùng 1 Profile → đưa vào danh sách xung đột (mục "Lỗi dữ liệu"), không tự ý chọn bên nào đúng.

### Ghi (export trạng thái DIE từ warehouse ra Sheets)
- Trước khi ghi: lưu lại màu cũ của vùng ô sẽ bị đổi (để hoàn tác được).
- Ghi đỏ đúng toàn dòng TK / đúng vùng F:G gộp của BC.
- Nếu chuyển từ DIE → trạng thái khác: khôi phục lại màu đã lưu trước đó (không phải luôn revert về trắng, vì ô có thể vốn đã có màu nền khác trước khi bị đánh DIE).
- Không bao giờ ghi màu vào Reup.
- Luôn có bước preview số dòng sẽ đổi màu trước khi ghi hàng loạt (mục 6).

### 4.1. Đối soát DIE ↔ AdsPower — thông báo khi Profile đã DIE nhưng chưa xóa trên AdsPower

Nguyên tắc: Profile bị đánh dấu DIE (dù đánh trên website hay đọc được từ màu đỏ trên Google Sheet) thì về logic không còn lý do tồn tại trên AdsPower. Hệ thống **không tự động xóa** (xóa là hành động phá hủy, cần xác nhận của người dùng), mà có trách nhiệm **phát hiện và cảnh báo** cho đến khi người dùng xử lý xong.

**Khi nào kiểm tra:**
1. **Theo sự kiện (event-driven)** — ngay khi trạng thái 1 Profile chuyển sang `DIE`, bất kể nguồn gốc thay đổi là gì:
   - Người dùng đổi trạng thái trực tiếp trên website.
   - Sync engine đọc được màu đỏ mới xuất hiện ở F:G (BC) hoặc toàn dòng (TK) từ Google Sheet.
   → Nếu Profile này có `adspower_profile_id` đã liên kết, gọi AdsPower API kiểm tra profile đó còn tồn tại không.
2. **Theo chu kỳ (reconciliation sweep)** — quét định kỳ (VD mỗi vài giờ, cấu hình được) toàn bộ Profile có `status = DIE` và `adspower_profile_id != null`, đối chiếu lại với AdsPower để bắt các trường hợp bị bỏ sót (VD lỗi tạm thời khi gọi API ở bước 1, hoặc Profile bị tạo/liên kết AdsPower sau khi đã DIE).

**Khi phát hiện Profile DIE mà AdsPower vẫn còn:**
- Tạo một bản ghi thông báo (bảng `notifications`, xem 4.2) với loại `DIE_ADSPOWER_STILL_EXISTS`, gắn `profile_id`, thời điểm phát hiện, trạng thái `OPEN`.
- Hiển thị ngay trên Dashboard: badge cảnh báo + danh sách "Profile đã DIE nhưng còn AdsPower Profile chưa xóa" (tên Profile, AdsPower Profile ID, thời gian DIE).
- Thông báo **tồn tại liên tục** (không tự biến mất) cho đến khi:
  - Reconciliation sweep xác nhận AdsPower Profile đó **không còn tồn tại nữa** (người dùng đã tự xóa) → hệ thống tự đóng thông báo (`status = RESOLVED`), tự xóa `adspower_profile_id` khỏi bản ghi Profile, ghi audit log.
  - Hoặc người dùng chủ động chọn "Xác nhận đã xử lý" trên UI kèm lý do (trường hợp cố tình giữ lại) — vẫn ghi audit log nhưng để tùy chọn cho các trường hợp đặc biệt.

**Ràng buộc bổ sung cho Automation (khuyến nghị, cần bạn xác nhận):**
- Vì một Profile DIE thì không nên được dùng để chạy automation nữa, đề xuất bổ sung điều kiện chặn cứng: bước "Kiểm tra trạng thái tài khoản" trong quy trình Automation (mục 13 bản thiết kế gốc) sẽ **từ chối chạy** nếu `status = DIE`, tương tự cách proxy thiếu bị chặn. Nếu bạn có kịch bản cần chạy automation trên Profile DIE (VD để xác minh trước khi xóa hẳn), báo lại để làm ngoại lệ có kiểm soát (VD chỉ role Admin mới được ép chạy, có cảnh báo xác nhận).

### 4.2. Bảng `notifications` (mới)

| Trường | Mô tả |
|---|---|
| id | Khóa chính |
| type | VD `DIE_ADSPOWER_STILL_EXISTS`, mở rộng được cho các loại cảnh báo khác sau này |
| profile_id | Profile liên quan |
| message | Nội dung hiển thị |
| status | `OPEN` / `RESOLVED` / `DISMISSED` |
| detected_at | Thời điểm phát hiện |
| resolved_at | Thời điểm đóng (tự động hoặc thủ công) |
| resolved_by | `SYSTEM` (reconciliation xác nhận đã xóa) hoặc user id (xác nhận thủ công) |

Dashboard (mục 15 bản thiết kế gốc) bổ sung chỉ số: **"Số Profile DIE còn tồn tại trên AdsPower"**.

---

## 5. Khớp kênh BC ↔ Reup — không chặn

Quy trình giữ nguyên theo thiết kế gốc (đọc quốc gia ở cột H → xác định tab Reup theo mapping tự cấu hình → trích nội dung trong ngoặc ở cột D → chuẩn hóa → so khớp `channel_name`), nhưng bổ sung rule mới:

- Khớp đúng 1 kết quả → ghi `channel_url`/`Link Kênh` (tùy cột nào có sẵn trong tab Reup đã cấu hình) vào trường "Link kênh kết nối".
- Không tìm thấy → để trống, gắn `channel_match_status = PENDING`, xuất hiện trong danh sách "cần xử lý" nhưng **không** là điều kiện chặn tạo Profile AdsPower hay chạy automation. Chỉ **proxy** vẫn là điều kiện chặn cứng.
- Tìm thấy nhiều kết quả → không tự chọn, gắn `channel_match_status = AMBIGUOUS`, đưa vào danh sách cần xử lý để người dùng chọn tay.

---

## 6. Rate limit & Locking — đảm bảo ổn định với dữ liệu lớn

### 6.1. Ngân sách quota Google Sheets API
Google Sheets API giới hạn theo project và theo user (mặc định khoảng 300 request đọc/phút và 300 request ghi/phút mỗi project, cộng thêm giới hạn per-user thấp hơn — **cần agent tự kiểm tra số liệu hiện hành trong Google Cloud Console tại thời điểm triển khai vì Google có thể thay đổi**). Nguyên tắc thiết kế không phụ thuộc con số chính xác:

1. **Sheets Gateway là điểm truy cập duy nhất** — không cho phép bất kỳ module nào khác gọi thẳng Sheets API.
2. **Batch mọi thao tác**: dùng `spreadsheets.values.batchGet` / `batchUpdate` thay vì gọi từng ô, từng dòng riêng lẻ.
3. **Token bucket rate limiter** theo từng `spreadsheet_id`, cấu hình số request/giây an toàn (thấp hơn quota thật ~20-30% để có đệm).
4. **Hàng đợi ghi (write queue)**: mọi lệnh ghi đi qua queue (VD BullMQ/RabbitMQ), 1 nhóm worker nhỏ xử lý tuần tự theo rate limiter, không ghi song song trực tiếp.
5. **Exponential backoff + jitter** khi gặp lỗi 429/500 từ Google, tối đa N lần retry rồi đẩy vào `sync_logs` với trạng thái lỗi để người dùng xem.
6. **Cache đọc ngắn hạn** (TTL vài giây) cho các lần đọc lặp lại gần nhau, tránh đọc lại toàn bộ tab liên tục khi có nhiều webhook dồn dập.

### 6.2. Locking

- **Lock theo bản ghi (application-level, lưu trong DB)**: khi automation chọn một Profile để tạo AdsPower Profile / chạy workflow, set `locked_by`, `locked_at` trên bản ghi `profiles`. Mọi automation khác cố dùng Profile này trong lúc lock còn hiệu lực sẽ bị từ chối ngay (kèm timeout tự nhả lock nếu job treo quá lâu).
- **Lock theo vùng ghi Sheets (distributed lock, VD Redis/Redlock)**: khi 1 sync job chuẩn bị ghi vào 1 vùng (VD tô màu DIE hàng loạt trên 1 tab), giữ lock theo khóa `spreadsheet_id:tab_name` trong suốt thời gian ghi để job khác không ghi đè cùng lúc lên cùng vùng.
- Sheets tự thân không hỗ trợ khóa cell nguyên tử qua API theo cách đáng tin cậy để dùng làm cơ chế đồng thời chính — vì vậy **DB là nguồn khóa thật sự**, Sheets chỉ là nơi phản ánh kết quả.
- Idempotency key cho mỗi thao tác ghi (dựa trên `sync_job_id` + `warehouse_profile_id` + `field`) để chạy lại job không tạo ra thay đổi trùng lặp.

---

## 7. Đồng bộ Near-Real-Time

Vì Google Sheets không phát sự kiện thay đổi theo ô ra ngoài, dùng mô hình lai:

### 7.1. Kênh đẩy (push) — độ trễ vài giây
- Gắn **Apps Script container-bound** vào từng spreadsheet (TK, BC, Reup) với trigger `onEdit`/`onChange`.
- Script gửi payload nhẹ (spreadsheet_id, sheet_name, range, timestamp) tới **Webhook Ingest API** của hệ thống, ký bằng HMAC secret để xác thực nguồn.
- Backend nhận webhook → chỉ enqueue một job "đọc lại vùng bị ảnh hưởng" (không đọc lại toàn bộ tab), giữ chi phí API thấp.

### 7.2. Kênh đối soát (polling) — lưới an toàn
- Poller chạy định kỳ (VD mỗi 5–15 phút, có thể cấu hình) đọc lại toàn bộ các tab đã cấu hình mapping, so sánh hash nội dung với lần đọc trước để phát hiện thay đổi bị bỏ sót (do Apps Script lỗi, mất quota, sheet bị sửa khi offline, v.v.).
- Đây là cơ chế bù trừ bắt buộc phải có, không được bỏ qua, vì kênh push có thể fail âm thầm.

### 7.3. Giới hạn cần lưu ý với người dùng
- Đây là **near-real-time** (thường vài giây đến vài chục giây), không phải tức thời tuyệt đối, vì phụ thuộc độ trễ của Apps Script trigger và hàng đợi xử lý.
- Nếu nhiều thay đổi dồn dập trong thời gian ngắn (VD sửa hàng loạt bằng script khác), hệ thống sẽ gộp thành một lần đọc lại thay vì xử lý từng sự kiện — tránh bão request.

---

## 8. Phân quyền & bảo mật

- Người dùng tự cấp quyền **Editor** cho service account (email dạng `xxx@project.iam.gserviceaccount.com`) trên từng file Google Sheet trong màn hình cấu hình nguồn dữ liệu.
- Service account credentials lưu ở secret manager (không lưu trong code/DB dạng plaintext).
- Toàn bộ thao tác ghi vào Sheets đều được ghi `audit_logs` (ai/khi nào/thay đổi gì) kể cả khi thực hiện bởi hệ thống tự động (ghi `source_of_change = SYSTEM_SYNC`).
- Các trường nhạy cảm (Pass, 2FA, Pass Hotmail, Cookie, Token, proxy credentials) mã hóa tại DB, che mặc định trên UI, ghi audit khi có người xem/copy — giữ nguyên như thiết kế gốc.

---

## 9. Lộ trình triển khai cập nhật

**Giai đoạn 1 — Import chỉ đọc + cấu hình mapping tự phục vụ**
- Xây UI cấu hình nguồn (mục 2) cho cả 3 file, không hard-code tab/cột nào.
- Import TK, BC (chỉ đọc), Reup theo mapping do người dùng tự chọn.
- Bật kiểm tra trùng lặp (mục 3) và cảnh báo ngay.
- Đọc trạng thái DIE từ đúng vùng F:G/TK (mục 4), báo cáo lỗi đối chiếu TK–BC, BC–Reup.
- Chưa ghi ngược Sheets, chưa automation.

**Giai đoạn 2 — Warehouse là nơi chỉnh sửa tập trung**
- Sửa dữ liệu trên web, audit log, phân quyền vai trò, quản lý hiển thị (`is_visible`).

**Giai đoạn 3 — Ghi ngược Google Sheets + Near-real-time**
- Triển khai Sheets Gateway, rate limiter, write queue (mục 6).
- Triển khai Apps Script push + reconciliation poller (mục 7).
- Ghi trạng thái DIE (chỉ F:G/TK), preview trước khi ghi hàng loạt, backup & undo theo phiên.
- Ghi "Link kênh kết nối" khi khớp được (mục 5), không chặn khi chưa khớp.

**Giai đoạn 4 — AdsPower**
- Đọc Profile/proxy từ AdsPower, liên kết `AdsPower Profile ID`, kiểm tra proxy bắt buộc (chặn cứng nếu thiếu).
- Triển khai đối soát DIE ↔ AdsPower (mục 4.1): kiểm tra theo sự kiện + theo chu kỳ, tạo thông báo, tự đóng khi xác nhận đã xóa.

**Giai đoạn 5 — Automation**
- Hàng đợi job, lock theo bản ghi (mục 6.2), chạy workflow, retry có giới hạn, log kết quả.

---

## 10. Điều kiện nghiệm thu (cập nhật)

Bổ sung so với bản gốc:

- Người dùng có thể tự đổi tab/cột mapping cho cả 3 nguồn (TK, BC, Reup) và bảng quốc gia→tab **mà không cần sửa code**.
- Trùng lặp Profile/ID/Hotmail/channel_name được cảnh báo **ngay khi phát hiện**, kể cả trong luồng đồng bộ real-time, không chỉ trong báo cáo batch.
- Đọc/ghi trạng thái DIE **chỉ** dựa vào màu đỏ đúng vùng F:G (BC) / toàn dòng (TK); mọi màu khác trên sheet không ảnh hưởng đến hệ thống.
- Không tìm thấy hoặc nhiều kết quả khi khớp kênh **không** chặn tạo Profile AdsPower hay automation; chỉ thiếu/lỗi proxy mới chặn.
- Hệ thống chịu tải ổn định với dữ liệu lớn: không vượt quota Google Sheets API, không ghi đè chồng chéo giữa các job chạy song song, chạy lại job không tạo dữ liệu trùng.
- Bất kỳ Profile nào chuyển sang `DIE` (từ website hoặc từ Sheet) mà vẫn còn `adspower_profile_id` tồn tại thực trên AdsPower đều phải xuất hiện thông báo trên website trong lần kiểm tra gần nhất, và thông báo phải tự đóng khi AdsPower Profile đó được xóa.
- Độ trễ đồng bộ đạt near-real-time (có SLA cụ thể agent cần thống nhất, VD "trong vòng 30 giây kể từ khi sửa trên Sheets" là mục tiêu hợp lý ban đầu), có cơ chế đối soát bù trừ khi kênh đẩy lỗi.
