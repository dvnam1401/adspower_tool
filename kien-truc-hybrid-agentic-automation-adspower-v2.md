# Kiến trúc Hybrid Agentic Automation cho AdsPower (v2 — Cập nhật)

> Bản cập nhật dựa trên đề xuất gốc, bổ sung: phân tầng xử lý lỗi, vòng lặp self-healing skill, tách lớp thao tác DOM, kiểm soát chi phí vision, quản lý tài nguyên đa profile, và observability.

---

## 1. Vấn đề cần giải quyết

Xây dựng automation cho AdsPower mà:

- Điều khiển nhiều profile trình duyệt (mở/đóng, điều hướng, click, nhập liệu, đọc dữ liệu).
- Xử lý được website thay đổi hoặc tình huống bất ngờ.
- Chạy đồng thời nhiều profile (có thể tới hàng trăm).
- Có retry khi lỗi, dễ mở rộng workflow mới.
- **Không gọi LLM cho từng thao tác** để tránh tốn token và chậm.

---

## 2. Nguyên tắc cốt lõi

> **Workflow xử lý việc bình thường. Agent xử lý việc bất thường. Skill Library ghi nhớ để Agent không phải xử lý lại việc đã từng gặp.**

Không xây theo kiểu mỗi thao tác đều qua Agent:

```
Agent → Click → Agent → Fill → Agent → Navigate → Agent → Click   ❌ Quá tốn token
```

Mà xây theo hướng workflow cố định, chỉ escalate lên Agent khi thật sự cần, và mọi lần Agent xử lý xong đều được **ghi lại thành skill** để lần sau dùng trực tiếp:

```
Workflow chạy bình thường → 0 lần gọi Agent
Workflow gặp lỗi chưa biết → gọi Agent → Agent xử lý → lưu skill mới → Workflow tiếp tục
Lần sau gặp lỗi tương tự → dùng skill đã lưu → 0 lần gọi Agent
```

---

## 3. Kiến trúc tổng thể (cập nhật)

```
                              ┌─────────────┐
                              │    USER     │
                              └──────┬──────┘
                                     │
                                     ▼
                         ┌────────────────────┐
                         │       AGENT        │
                         │  (LLM: Claude/GPT..)│
                         │                     │
                         │ Planning            │
                         │ Reasoning           │
                         │ Error Recovery      │
                         │ (chỉ gọi khi cần)   │
                         └─────────┬───────────┘
                                   │
                    ghi/đọc skill │  đọc skill trước khi gọi Agent
                                   ▼
                         ┌────────────────────┐
                         │   SKILL LIBRARY     │◄── vòng lặp self-healing
                         │  (candidate/verified │    (chi tiết mục 5)
                         │   /active/rollback)  │
                         └─────────┬───────────┘
                                   │
                                   ▼
                         ┌────────────────────┐
                         │  WORKFLOW ENGINE    │
                         │                      │
                         │ Queue                │
                         │ Concurrency limit    │
                         │ Retry theo tầng      │
                         │ Schedule / Checkpoint│
                         └─────────┬───────────┘
                                   │
                    ┌──────────────┴───────────────┐
                    ▼                               ▼
        ┌────────────────────┐         ┌────────────────────┐
        │   AdsPower MCP      │         │  Lớp thao tác DOM   │
        │ (quản lý profile:   │         │  (Playwright/CDP,   │
        │  mở/đóng/fingerprint│         │  click/fill/wait    │
        │  /proxy/group/tag)  │         │  xác định, rẻ, nhanh)│
        └─────────┬───────────┘         └─────────┬──────────┘
                  │                                │
                  └───────────────┬────────────────┘
                                  ▼
                         ┌────────────────────┐
                         │      AdsPower       │
                         │ Profile 1..N         │
                         └────────────────────┘
```

**Thay đổi chính so với bản gốc:**
- Thêm **Skill Library** như một node riêng, nằm giữa Agent và Workflow Engine, có vòng đời rõ ràng thay vì chỉ là "kho lưu trữ thụ động".
- **Tách lớp thao tác DOM khỏi MCP**: MCP chỉ quản lý profile (mở/đóng/fingerprint/proxy), còn click/fill/wait dùng Playwright/CDP kết nối trực tiếp qua remote debugging port — nhanh và rẻ hơn, không tốn round-trip qua MCP tool call cho mỗi thao tác nhỏ.

---

## 4. Tầng phát hiện và phân loại lỗi (mới)

Trước khi quyết định "gọi Agent hay không", cần một lớp phân loại lỗi rõ ràng — không phải mọi lỗi đều đáng gọi Agent, và có loại lỗi Agent không giải quyết được.

| Loại lỗi | Ví dụ | Xử lý | Có gọi Agent? |
|---|---|---|---|
| **Tạm thời** | Timeout, mất kết nối mạng, trang load chậm | Retry tự động (backoff) | Không |
| **Cấu trúc** | Selector không tìm thấy, DOM/UI thay đổi | Tra Skill Library trước → nếu không có, gọi Agent | Có (nếu chưa có skill) |
| **Chặn truy cập** | CAPTCHA, IP bị chặn, rate-limit | Escalate cho con người / đổi proxy theo policy có sẵn | Không (Agent không giải CAPTCHA) |
| **Dữ liệu** | Sai mật khẩu, tài khoản bị khoá | Escalate cho con người | Không |

**Luồng xử lý 3 tầng:**

```
Lỗi xảy ra
   │
   ▼
[Tầng 1] Phân loại lỗi tự động (rule-based, không cần LLM)
   │
   ├── Tạm thời        → Retry tự động (giới hạn số lần) → thành công/thất bại hẳn
   ├── Chặn/Dữ liệu     → Escalate cho con người ngay
   └── Cấu trúc         → [Tầng 2] Tra Skill Library
                              │
                              ├── Có skill khớp   → Áp dụng skill, không gọi Agent
                              └── Không có skill   → [Tầng 3] Gọi Agent
                                                        │
                                                        ├── Agent xử lý được → lưu skill mới (candidate)
                                                        └── Agent không xử lý được → Escalate cho con người
```

---

## 5. Vòng lặp Self-Healing Skill (cải tiến quan trọng nhất)

Đây là điểm biến hệ thống từ "cố định" thành "tự cải thiện": mỗi lần Agent xử lý xong một lỗi, kết quả phải được lưu lại để **không phải gọi Agent lần nữa cho cùng loại lỗi trên cùng site**.

### 5.1 Vòng đời một skill

```
candidate → testing → verified/active → (rollback nếu fail lại)
```

- **candidate**: Agent vừa tìm ra cách xử lý (VD: selector mới cho nút Login). Chưa được tin dùng ngay.
- **testing**: Workflow Engine áp dụng thử skill này trong N lần chạy tiếp theo (canary), song song theo dõi tỷ lệ thành công.
- **verified/active**: Sau N lần thành công liên tiếp (VD: 5 lần), skill được promote thành chính thức, Workflow Engine dùng trực tiếp không cần gọi Agent.
- **rollback**: Nếu skill active bắt đầu fail lại (site đổi UI lần nữa), tự động hạ về `candidate`, gọi lại Agent, giữ nguyên lịch sử skill cũ để so sánh/khôi phục nếu cần.

### 5.2 Schema đề xuất cho một Skill

```json
{
  "skill_id": "login_website_x_button_selector",
  "site": "website-x.com",
  "action_type": "click_login_button",
  "status": "verified",
  "selector_chain": [
    { "type": "css", "value": "#login-btn", "priority": 1 },
    { "type": "text", "value": "Đăng nhập", "priority": 2 },
    { "type": "aria-label", "value": "login", "priority": 3 }
  ],
  "created_by": "agent",
  "created_at": "2026-08-10T10:00:00Z",
  "last_verified_at": "2026-08-19T09:00:00Z",
  "success_count": 12,
  "fail_count": 0,
  "version": 3,
  "previous_versions": ["v1_selector_old", "v2_selector_old"]
}
```

### 5.3 Nguyên tắc quan trọng

- **Không promote skill ngay sau 1 lần Agent xử lý thành công** — cần qua giai đoạn `testing` để tránh một fix "ăn may" bị áp dụng hàng loạt cho 100 profile.
- **Giữ lịch sử phiên bản selector cũ** — nếu site rollback giao diện, hệ thống có thể nhận diện lại thay vì học từ đầu.
- Skill nên lưu ở dạng **có cấu trúc (JSON/DB)**, không phải văn bản tự do, để dễ audit, dễ rollback, dễ tính success rate.

---

## 6. Thứ tự ưu tiên khi Agent cần "nhìn" trang (mới)

Khi selector fail và cần Agent phân tích lại trang, ưu tiên theo thứ tự để tối ưu chi phí:

1. **DOM / accessibility tree (text-based)** — rẻ nhất, nên thử trước.
2. **Vision / screenshot** — chỉ dùng khi DOM không đọc được hoặc không đủ thông tin (VD: trang render bằng canvas, hình ảnh).

Vision fallback là **phương án cuối**, không phải mặc định.

---

## 7. Quản lý tài nguyên khi chạy nhiều profile song song (mới)

Mỗi AdsPower profile là một tiến trình Chrome riêng, tốn RAM/CPU đáng kể. Workflow Engine cần:

- **Concurrency limit**: giới hạn số profile chạy đồng thời trên một máy.
- **Queue theo batch**: chia 100+ profile thành các đợt chạy, không mở tất cả cùng lúc.
- **Checkpoint**: lưu tiến trình theo profile để resume nếu hệ thống crash giữa chừng.
- **Chia tải đa máy/VM**: nếu số lượng profile lớn, cân nhắc phân phối qua nhiều máy thay vì dồn vào một máy.

---

## 8. Observability (mới)

Nên log và theo dõi:

- **Tần suất gọi Agent theo từng site/skill** — chỉ số này cho biết skill nào đang "mong manh" (dễ gãy khi site đổi giao diện), cần được ưu tiên cập nhật logic cứng hơn.
- **Tỷ lệ thành công/thất bại theo skill** — dùng cho quyết định promote/rollback ở mục 5.
- **Số lần escalate lên con người** — theo loại lỗi, để phát hiện sớm các site có nhiều CAPTCHA/chặn IP cần đổi chiến lược proxy.

---

## 9. Kiến trúc chi tiết — luồng xử lý một tác vụ

```
Workflow Engine lấy 1 task (VD: login profile #045 vào website X)
   │
   ▼
Gọi AdsPower MCP → mở profile #045
   │
   ▼
Lớp thao tác DOM (Playwright/CDP) → điều hướng, tìm nút Login
   │
   ├── Thành công → thực hiện tiếp các bước → DONE
   │
   └── Lỗi → [Tầng phát hiện lỗi, mục 4]
              │
              ├── Tạm thời → retry
              ├── Chặn/Dữ liệu → escalate người
              └── Cấu trúc → tra Skill Library
                     │
                     ├── Có skill (active) → áp dụng → tiếp tục workflow
                     └── Không có → gọi Agent
                            │
                            ├── DOM/accessibility text trước
                            ├── Vision nếu cần (phương án cuối)
                            │
                            ▼
                     Agent trả action + lưu skill (candidate)
                            │
                            ▼
                     Workflow tiếp tục, skill vào giai đoạn testing
```

---

## 10. Lưu ý vận hành

Vì hệ thống điều khiển nhiều profile trình duyệt tự động trên nhiều website ở quy mô lớn, nên rà soát điều khoản sử dụng (ToS) của từng site đích trước khi triển khai — điều này không ảnh hưởng đến kiến trúc kỹ thuật nhưng cần lưu tâm khi đưa vào vận hành thực tế.

---

## 11. Tóm tắt thay đổi so với bản gốc

| Hạng mục | Bản gốc | Bản cập nhật (v2) |
|---|---|---|
| Xử lý lỗi | 2 tầng: bình thường / gọi Agent | 3 tầng: retry tự động / Skill Library / Agent / escalate người |
| Skill Library | Nhắc tên, chưa có cơ chế | Có vòng đời rõ ràng (candidate → testing → verified → rollback) + schema JSON cụ thể |
| Thao tác DOM | Đi qua MCP | Tách riêng qua Playwright/CDP, MCP chỉ quản lý profile |
| Agent "nhìn" trang | Không nói rõ | Ưu tiên DOM/text trước, vision là phương án cuối |
| Quản lý nhiều profile | Chưa đề cập | Concurrency limit, queue theo batch, checkpoint, chia tải đa máy |
| Theo dõi hệ thống | Chưa có | Observability: tần suất gọi Agent, tỷ lệ thành công skill, số lần escalate |

---

*Tài liệu này là bản mở rộng dựa trên kiến trúc Hybrid Agentic Automation gốc, giữ nguyên tư tưởng cốt lõi "Agent là bộ não, Workflow Engine là động cơ, MCP là cầu nối, Skill Library là trí nhớ".*
