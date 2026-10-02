# Facebook / AdsPower Login Workflow Audit & Handoff Report

> **Audit Date**: 2026-08-22
> **Task Ref**: `LOGIN-AUDIT-001`
> **Repository**: `adspower_tool` (`D:\workspace\adspower_tool`)

---

## 1. Audit Scope & Audit Summary

- **Objective**: Inspect the codebase, trace the Facebook/AdsPower login workflow end-to-end, evaluate current implementation completeness and test coverage, record empirical verification outcomes, and document exact known blockers and a safe manual verification checklist for Codex/Lien.
- **Overall Result Status**: `pass` (Audit & handoff documentation completed cleanly without touching forbidden source files or exposing secrets).
- **Working-Tree Constraint**: All pre-existing user modifications (+2.4k lines across 12 files) and 6 untracked files/directories are preserved intact.

---

## 2. End-to-End Login Sequence Architecture

```
  +-------------------+      +--------------------+      +--------------------+
  | Web UI / REST /   | ---> | Batch Runner &     | ---> | AdsPower REST API  |
  | CLI Trigger       |      | Concurrency Queue  |      | /api/v1/browser/   |
  +-------------------+      +--------------------+      +---------+----------+
                                                                   |
  +-------------------+      +--------------------+                v
  | Facebook Login    | <--- | Playwright CDP     | <--- +--------------------+
  | State Engine (14S)|      | WebSocket Driver   |      | Window Reuse       |
  +---------+---------+      +--------------------+      | (No launch_args)   |
            |                                            +--------------------+
            v
  +-------------------+      +--------------------+      +--------------------+
  | 2FA TOTP / Modal  | ---> | Checkpoint & Error | ---> | Result Persistence |
  | Option Switcher   |      | Classification     |      | SSE & Telegram     |
  +-------------------+      +--------------------+      +--------------------+
```

### Stage-by-Stage Flow Description

1. **Stage 1: Trigger & Parameter Ingestion**:
   - Web UI triggers `/api/automation/facebook-login` (single) or `/api/automation/facebook-login/batch` (multi-profile) via Express server (`src/server/app.ts`).
   - CLI triggers via `src/automation/run-fb-login.ts` or `src/automation/run-fb-batch.ts`.
   - Parameters: profile names/IDs, target URL, concurrency limit, auto-close preference.

2. **Stage 2: Batch Execution & Concurrency Control**:
   - `BatchFacebookLoginRunner` (`src/automation/batch-runner.ts`) dispatches worker threads across profiles with a concurrency cap (default 3–5) and launch staggering (default 2s delay between AdsPower starts to prevent API rate limits).
   - Alternatively, `WorkflowEngine` (`src/workflow/engine.ts`) runs multi-step preset tasks with checkpoint logging (`data/workflow-checkpoints.json`).

3. **Stage 3: AdsPower Profile Startup & Window Reuse**:
   - Calls AdsPower Local API `POST /api/v1/browser/start` via `AdsPowerClient` (`src/adspower/client.ts`).
   - Enforces a 1.1s rate-limit interval between AdsPower API requests with backoff retries on `Too many requests`.
   - Omits `launch_args` by default to instruct AdsPower to **reuse existing open browser windows** instead of launching duplicate Chrome instances.

4. **Stage 4: Playwright CDP Attachment & Navigation**:
   - `PlaywrightCDPManager` (`src/dom/cdp.ts`) connects to `wsEndpoint` via `chromium.connectOverCDP`.
   - Attaches directly to the existing browser context and active tab without creating new windows.
   - Enforces a 30s navigation timeout; on hang/network error, executes `window.stop()`, waits 1.5s, and reloads.

5. **Stage 5: Autonomous State Machine Execution**:
   - `FacebookLoginAutomation.execute()` (`src/automation/facebook-login.ts`) resolves profile credentials (username, password, 2FA secret key) from AdsPower API.
   - Checks `isRealLoggedIn()` using positive indicators (avatar, search bar, messenger, feed) and negative indicators (email/password inputs).
   - Runs `runAutonomousLoginEngine()` up to 12 cycles across 14 distinct page states.

6. **Stage 6: 2FA TOTP & Challenge Resolution**:
   - Detects 2FA URLs (`/two_step_verification/two_factor`, `/two_factor`, etc.).
   - Generates RFC 6238 TOTP 6-digit passcode from profile `fakey` using `generateTOTP()`.
   - If presented with "Check your notifications on another device" (TH1) or modal options (TH2), automatically clicks "Try another way", selects the "Authentication app" radio button, clicks "Continue", and populates the 6-digit input.
   - Handles intermediate pages ("Remember browser", "Trust this device", "Save login info", One-Tap popups).
   - Backup Google Sheet retry loop (`googleSheetService.getBackupData`): if password login fails, injects backup cookies from Google Sheets and retries up to 6 times.

7. **Stage 7: Checkpoint & Error Classification**:
   - `detectCheckpoint()` checks for human verification challenges, account suspension/lock (956/282), and identity upload prompts.
   - Categorizes failures using `errorClassifier` (`src/recovery/classifier.ts`) into Tier 1 (Transient), Tier 2 (Structural), Tier 3 (Blocked/Data).

8. **Stage 8: Results Persistence, SSE Broadcast & Telegram Alert**:
   - Broadcasts real-time events (`profile_login_started`, `profile_login_finished`, `system_alert`, `batch_completed`) via SSE to Web UI.
   - Calls `synthesizeBatchReportAndNotify()` (`src/utils/telegram.js`) to generate an AI batch summary and send Telegram alerts.
   - Auto-closes browser windows for successful logins if `closeSuccessBrowsers=true`; keeps browser open for checkpointed/failed profiles to allow human intervention.

---

## 3. Evidence Table per Stage

| Stage # | Stage Name | Implementation Status | Primary File References | Technical Evidence & Logic Summary |
| :---: | :--- | :--- | :--- | :--- |
| **1** | **Trigger & API** | Implemented & Statically Connected | `src/server/app.ts`<br>`src/automation/run-fb-login.ts`<br>`src/automation/run-fb-batch.ts` | Express REST routes (`/api/automation/facebook-login`, `/batch`) and CLI entry points accept parameters and launch background tasks. |
| **2** | **Batch & Concurrency** | Implemented & Statically Connected | `src/automation/batch-runner.ts`<br>`src/workflow/engine.ts` | Concurrency pool dispatcher with `Promise.race` capping, 2s launch staggering, progress tracking, and emergency stop (`stopBatch()`). |
| **3** | **AdsPower Startup** | Implemented & Statically Connected | `src/adspower/client.ts` | Rate-limited (1.1s interval) API wrapper; omits `launch_args` to enforce window reuse; profile cache with 60s TTL. |
| **4** | **CDP Attachment** | Covered by Build/Typecheck (Note Baseline Errors) | `src/dom/cdp.ts` | Playwright `connectOverCDP` attaching to existing contexts; 30s timeout check with `window.stop()` reload retries. |
| **5** | **State Machine** | Implemented & Statically Connected | `src/automation/facebook-login.ts` (L627–L1082) | 12-cycle loop evaluating 14 distinct states: feed check, 404 handler, wrong password detection, non-existent account detection, 2FA, and guest page redirects. |
| **6** | **2FA & OTP Engine** | Implemented & Statically Connected | `src/automation/facebook-login.ts` (L1653–L1960)<br>`src/utils/totp.js`<br>`adspower_login/` | TOTP generation via `otplib`/crypto; handles "Try another way" (TH1) and "Authentication app" radio modal (TH2); 6-attempt Google Sheet backup cookie fallback. |
| **7** | **Checkpoint & Recovery** | Implemented & Statically Connected | `src/automation/facebook-login.ts` (L1535–L1648)<br>`src/recovery/classifier.ts`<br>`src/recovery/healing-orchestrator.ts` | Detects human verification, account suspension, and ID upload; classifies errors into Tier 1 (retry), Tier 2 (skill store / LLM), Tier 3 (escalate human). |
| **8** | **Events & Reporting** | Implemented & Statically Connected | `src/server/app.ts`<br>`src/utils/telegram.js` | SSE broadcasting (`broadcastEvent`), batch report synthesis via Gemini/OpenAI, Telegram message delivery, and conditional auto-close. |
| **9** | **AI Self-Healing** | Implemented & Statically Connected | `src/utils/ai-analyzer.ts`<br>`src/skills/repository.ts`<br>`src/agent/resolver.ts` | Compact DOM serialization (<5KB A11y tree), Vision screenshot fallback, candidate skill store persistence (`data/skills.json`). |

---

## 4. Verification Commands & Empirical Outcomes

### 1. Type Check Verification (`npx tsc --noEmit`)
- **Command**: `npx tsc --noEmit`
- **Exit Code**: `1` (6 recorded baseline errors)
- **Error Detail**:
  ```
  src/automation/share-fb-page.ts(128,23): error TS2551: Property 'disconnect' does not exist on type 'Browser'.
  src/dom/cdp.ts(166,37): error TS2304: Cannot find name 'window'.
  src/dom/cdp.ts(203,35): error TS2304: Cannot find name 'window'.
  src/dom/cdp.ts(230,22): error TS2584: Cannot find name 'document'.
  src/dom/cdp.ts(249,22): error TS2584: Cannot find name 'document'.
  src/dom/cdp.ts(283,39): error TS2304: Cannot find name 'window'.
  ```
- **Analysis**: These 6 compilation errors are tracked as `BUG-001` (DOM types in `cdp.ts`) and `BUG-002` (Browser `.disconnect()` method in `share-fb-page.ts`). They pre-existed in the working tree and block clean build.

### 2. Facebook Page Inventory Behavioral Test (`npx tsx tests/facebook-page-inventory.test.ts`)
- **Command**: `npx tsx tests/facebook-page-inventory.test.ts`
- **Exit Code**: `0` (Clean Pass)
- **Outcome**: `19 passed, 0 failed` across 13 test suites (1690ms duration). Verified DOM filtering, switcher polling, personal identity protection, scroll progress helpers, and fail-closed safety assertions.

### 3. Account Hub Config Unit Test (`npx tsx tests/account-hub/unit/config.test.ts`)
- **Command**: `npx tsx tests/account-hub/unit/config.test.ts`
- **Exit Code**: `0` (Clean Pass)
- **Outcome**: `12 passed, 0 failed`. Verified environment feature flag evaluation and dry-run defaults.

### 4. Live AdsPower / Facebook Verification
- **Status**: `Blocked` (Requires local AdsPower API running on `127.0.0.1:50325`, populated profile ID, and valid Facebook account credentials / TOTP seed).

---

## 5. Exact Known Blockers & Risks

1. **TypeScript Build Blocker (`BUG-001`, `BUG-002`)**:
   - `src/dom/cdp.ts` uses `window` and `document` inside `page.evaluate()` callbacks without DOM type definitions in `tsconfig.json`.
   - `src/automation/share-fb-page.ts` attempts to call `.disconnect()` on a Playwright `Browser` instance instead of `browser.close()`.
   - *Impact*: Prevents `npm run build` (`tsc`) from completing cleanly.

2. **Environment & Live Dependency Blocker**:
   - Live execution depends on AdsPower software running locally and valid AdsPower profiles with active Facebook credentials.
   - *Impact*: Automated CI cannot perform live login without an active AdsPower desktop application instance.

3. **Facebook Structural & Security Challenges**:
   - Facebook frequently tests new 2FA option dialog layouts, Arkose MatchKey challenges, and 956/282 account lock checkpoints.
   - *Impact*: Tier 3 checkpoints (account suspension or puzzle CAPTCHA) require human intervention by design and cannot be bypassed automatically.

---

## 6. Proven Working Boundary

### What is GENUINELY Proven Working
1. **Account Hub configuration tests**: 12/12 passed. These tests cover feature-flag defaults and do not exercise Facebook login.
2. **Facebook Page Inventory tests**: 19/19 passed. This is adjacent post-login functionality and is not evidence that login itself works.

### Implemented and Statically Traced, but Not Runtime-Proven in This Audit
1. **REST API & SSE wiring**: Endpoint declarations, request parsing, authentication middleware (`authMiddleware`), and log-broadcasting code are connected in source.
2. **Login state-machine branches**: `facebook-login.ts` contains the traced branches for credentials, TOTP/2FA, One-Tap dismissal, backup handling, and alerts.
3. **AdsPower window reuse**: `startBrowser()` contains query-parameter handling intended to reuse an existing browser window.
4. **Skill and checkpoint persistence**: Serialization paths exist for `data/skills.json` and `data/workflow-checkpoints.json`.

There are currently **zero automated tests in this repository that directly validate** Facebook login, 2FA submission, the AdsPower CDP handshake, batch login, login recovery, SSE delivery during a login run, or persistence produced by a login run. In addition, the repository-wide TypeScript check currently fails, so static connectivity is not equivalent to a clean build.

### What REQUIRES Live Local Testing
1. Active WebSocket CDP handshake with live AdsPower browser instances.
2. Real-time DOM interaction against live Facebook login forms under actual network conditions.
3. Actual TOTP code submission against Facebook's current 2FA endpoints.

---

## 7. Safe Manual Live Test Checklist

For Codex / Lien / Anh An to verify the Facebook login workflow on a live local machine:

1. **Prerequisites**:
   - Ensure AdsPower application is running on local machine.
   - Verify AdsPower Local API is enabled in AdsPower Settings (`http://127.0.0.1:50325`).
   - Create or select an AdsPower profile configured with a Facebook username, password, and 2FA secret key (`fakey`).

2. **Step 1: Verify AdsPower API Connectivity**:
   ```bash
   npm run test:adspower
   ```
   *Expected Output*: `AdsPower Local API is healthy` with profile count data.

3. **Step 2: Run Single Profile Facebook Login**:
   ```bash
   npx tsx src/automation/run-fb-login.ts "[Profile Name or User ID]"
   ```
   *Verification Points*:
   - AdsPower opens the profile window (or reuses existing open window).
   - Console logs show `[Step 1/5] Khởi động trình duyệt AdsPower...` through `[Step 3/4] Phân tích trạng thái đăng nhập...`.
   - If a 2FA prompt appears, confirm that the 2FA branch runs without recording the generated code. Logs and screenshots must redact the TOTP value.
   - **Security risk**: `facebook-login.ts` currently logs the complete generated TOTP at the `[2FA B5]` step. Do not share or retain that output; replace it with redacted logging before routine live use.
   - On completion, final result JSON displays `"status": "logged_in"` or `"status": "already_logged_in"`.

4. **Step 3: Run Multi-Profile Batch Login**:
   ```bash
   npm run run-fb-batch -- --profiles "[ProfileID1],[ProfileID2]" --concurrency 2
   ```
   *Verification Points*:
   - Batch runner launches 2 concurrent worker threads with 2s staggering delay.
   - Successful profiles are auto-closed (if `closeSuccessBrowsers=true`); failed/checkpointed profiles remain open for inspection.
   - Final batch report summary is printed to console.

5. **Step 4: Verify Web Dashboard**:
   ```bash
   npm start
   ```
   - Open `http://localhost:3000` in browser.
   - In the profile list, select at least one profile and use the visible `Auto Login` action (the page also contains the batch label `Auto Login Facebook (Đa Luồng)`).
   - Observe the Live Logs area and network/API response; do not record credentials, cookies, or TOTP values.

---

## 8. Secret Hygiene & Write-Scope Compliance Confirmation

- **Secret Hygiene**: Zero secret values, passwords, tokens, API keys, cookies, 2FA seeds, profile credentials, or personal data have been included in this document or any created files.
- **Scope Compliance**: Exactly two files (`docs/PROJECT_CONTEXT.md` and `docs/LOGIN_WORKFLOW_STATUS.md`) were created/modified during this audit task. All pre-existing source files, test files, package files, lockfiles, runtime data, and root documentation files remain untouched.
