# Kế hoạch Triển khai: Ứng dụng AdsPower Hybrid Agentic Automation (Local App & GUI)

Phát triển hệ thống thành **Ứng dụng hoàn chỉnh chạy trên máy cục bộ (Local App)** với **Giao diện Trực quan (Modern Web Dashboard)**, cho phép quản lý profiles AdsPower, trực quan hóa kho kỹ năng tự sửa lỗi (Self-Healing Skill Library), tạo & chạy workflow đa luồng, theo dõi Live Logs và can thiệp lỗi theo thời gian thực.

---

## User Review Required

> [!IMPORTANT]
> **Kiến trúc Ứng dụng (Local Desktop / Web App):**
> - **Backend Service:** Node.js + Express + SSE (Server-Sent Events) kết nối trực tiếp với AdsPower Local API và Playwright CDP.
> - **Frontend GUI:** Giao diện Dashboard hiện đại (Dark theme chuẩn công nghệ, Tailwind CSS, Lucide icons, Reactive UI), phục vụ tại `http://localhost:3000`.
> - **Quy trình tương tác:** Sau mỗi giai đoạn hoàn thành, ứng dụng sẽ được khởi động để bạn trực tiếp kiểm tra và trải nghiệm giao diện.

---

## Các Module & Giao diện của Ứng dụng

```
┌────────────────────────────────────────────────────────────────────────┐
│             ADSPOWER HYBRID AUTOMATION APP (GIAO DIỆN CỤC BỘ)          │
│                                                                        │
│  [ Header: AdsPower Status (Online 🟢) | Concurrency Limit: 5 | LLM ]  │
│                                                                        │
│  ┌───────────────────────┬──────────────────────────────────────────┐  │
│  │ 📂 Profiles Management│ ⚡ Active Workflows & Batch Runner       │  │
│  │ - List AdsPower profs │ - Chạy song song nhiều profile           │  │
│  │ - Start / Stop / CDP  │ - Tiến độ từng step, Retry counter       │  │
│  │ - Proxy & Fingerprint │ - Live Status (Running/Success/Failed)   │  │
│  ├───────────────────────┼──────────────────────────────────────────┤  │
│  │ 🧠 Skill Library (UI) │ 📜 Real-time Logs & Self-Healing Event   │  │
│  │ - candidate/verified  │ - 3-Tier error classification visualizer │  │
│  │ - Selector chains     │ - Token savings counter                  │  │
│  │ - History & Rollback  │ - Agent repair suggestions / Vision diff │  │
│  └───────────────────────┴──────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────────────┘
```

---

## Kế hoạch Triển khai Các Giai đoạn

### ✅ Giai đoạn 1 & 2: Nền tảng & AdsPower Connector (ĐÃ HOÀN THÀNH)
- Khởi tạo TypeScript, cấu hình, logger và hệ thống Type.
- Hoàn thành `AdsPowerClient` và kết nối thành công với AdsPower Local API (`10 profiles` được phát hiện).

---

### 🚀 Giai đoạn 3: Xây dựng Giao diện Ứng dụng Cục bộ (Local App GUI & Server)
*Mục tiêu: Đưa ứng dụng lên giao diện trực quan đầu tiên để người dùng có thể mở trên trình duyệt, xem danh sách profile, bấm mở/đóng browser AdsPower trực tiếp từ UI.*

1. **Backend Server (`src/server/`):**
   - Express server cung cấp REST API (`/api/status`, `/api/profiles`, `/api/browser/start`, `/api/browser/stop`).
   - SSE endpoint (`/api/events`) stream log và trạng thái thời gian thực.
2. **Frontend UI (`public/`):**
   - Giao diện Dashboard Responsive (Dark Mode chuyên nghiệp).
   - Card Trạng thái Hệ thống: AdsPower Local API, Bộ nhớ, Concurrency.
   - Bảng Quản lý Profile: Xem danh sách, tìm kiếm, nút Khởi động (Start) / Dừng (Stop) profile tức thì kèm chỉ báo trạng thái.
   - Panel Live Logs: Xem luồng log thời gian thực.
3. **Khởi chạy ứng dụng:** Chạy server và mở giao diện để bạn duyệt và tương tác.

---

### 🚀 Giai đoạn 4: Playwright CDP Driver & Action Engine
*Mục tiêu: Thao tác tự động hóa tốc độ cao không tốn token.*

1. **Playwright CDP Connector (`src/dom/cdp.ts`):**
   - Kết nối WebSocket DevTools Protocol từ AdsPower profile.
   - Điều hướng (navigate), click, fill, select, extract dữ liệu.
2. **Compact DOM Serializer (`src/dom/serializer.ts`):**
   - Trích xuất cấu trúc DOM & Accessibility Tree gọn gàng, loại bỏ rác để tiết kiệm 95% token khi chuyển cho Agent.
3. **Cập nhật Giao diện:** Bổ sung tab **"DOM Action Playground"** trên UI để test thử các hành động click/fill trực tiếp trên profile đang mở.

---

### 🚀 Giai đoạn 5: Self-Healing Skill Library (Trí nhớ thích ứng)
*Mục tiêu: Lưu trữ và tự động cải thiện selectors.*

1. **Skill Repository (`src/skills/repository.ts`):**
   - Lưu trữ dạng JSON/DB với schema v2 (`selector_chain`, `success_count`, `fail_count`, `version`).
   - Vòng đời: `candidate` $\rightarrow$ `testing` (canary) $\rightarrow$ `verified` $\rightarrow$ `rollback`.
2. **Cập nhật Giao diện:** Bổ sung tab **"Skill Library"** trên UI:
   - Danh sách các kỹ năng đã học theo từng website.
   - Chi tiết selector chain (CSS, Text, XPath, ARIA) và biểu đồ tỷ lệ thành công.
   - Nút quản lý: Thêm skill thủ công, Promote, Rollback.

---

### 🚀 Giai đoạn 6: Tầng Phân Loại Lỗi 3 Tầng & LLM Self-Healing Agent
*Mục tiêu: Tự sửa lỗi khi website đổi giao diện mà không tốn token thừa.*

1. **Error Classifier (`src/recovery/classifier.ts`):**
   - Tầng 1: Transient (Mạng lag/timeout) $\rightarrow$ Tự retry có backoff.
   - Tầng 2: Structural (Đổi nút/selector) $\rightarrow$ Tra cứu Skill Library $\rightarrow$ Nếu chưa có, gọi LLM Agent.
   - Tầng 3: Blocked/Data (CAPTCHA/Proxy die) $\rightarrow$ Escalate người dùng.
2. **LLM Agent Brain (`src/agent/resolver.ts`):**
   - Nhận DOM text/A11y tree, suy luận selector mới, xuất JSON chuẩn và lưu `candidate` skill.
   - Vision fallback (chụp màn hình) khi DOM không đủ thông tin.
3. **Cập nhật Giao diện:** Tab **"Self-Healing Monitor"** hiển thị chi tiết các lần Agent tự sửa lỗi, so sánh selector cũ/mới và số token tiết kiệm được.

---

### 🚀 Giai đoạn 7: Workflow Engine & Batch Concurrency Limiter
*Mục tiêu: Chạy hàng loạt nhiều profile song song có kiểm soát tài nguyên.*

1. **Workflow Engine (`src/workflow/engine.ts`):**
   - Queue điều phối batch, giới hạn concurrency (ví dụ: tối đa 5 profile cùng lúc).
   - Checkpoint lưu trạng thái từng bước để phục hồi nếu dừng đột ngột.
2. **Cập nhật Giao diện:** Tab **"Workflow Runner"**:
   - Chọn nhiều profile cùng lúc, bấm "Run Batch Workflow".
   - Thanh tiến độ (Progress Bar) từng profile theo thời gian thực.
   - Nút Tạm dừng / Tiếp tục / Hủy bỏ.

---

## Verification & Interactive Walkthrough

Sau mỗi giai đoạn:
- Khởi động App (`npm start`).
- Cung cấp đường link `http://localhost:3000` kèm hướng dẫn kiểm tra các tính năng vừa xây dựng trực tiếp trên màn hình giao diện.
