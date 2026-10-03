# Project Context — AdsPower Hybrid Automation Platform

> **Audit Date**: 2026-08-22
> **Task Ref**: `LOGIN-AUDIT-001`
> **Repository**: `adspower_tool` (`D:\workspace\adspower_tool`)

---

## 1. Project Purpose & High-Level Overview

The **AdsPower Hybrid Agentic Automation Platform** is a local application and automation engine designed for high-concurrency, resilient browser automation against Facebook and web platforms.

Key capabilities include:
- **AdsPower Integration**: Management of local AdsPower profiles via AdsPower Local REST API (`127.0.0.1:50325`).
- **Direct CDP Automation**: Low-overhead Chrome DevTools Protocol (CDP) control using `playwright-core` without spawning duplicate browser instances (window reuse).
- **Autonomous Facebook Login Engine**: A 14-state machine handling login forms, 2FA TOTP generation, 2FA modal selection, cookie fallback, One-Tap popups, "Trust this device" prompts, and Facebook checkpoints.
- **3-Tier Error Recovery & AI Self-Healing**: Automated classification of transient, structural, and blocked errors; DOM compression (`CompactDOMSerializer`); self-healing skill library (`data/skills.json`); and Gemini/OpenAI vision/DOM analysis.
- **Account Data Hub Subsystem**: SQLite Write-Ahead Logging (WAL) database, Google Sheets v4 integration, profile reconciliation, and conflict resolution.
- **Real-Time Observability**: Web Dashboard SPA (`http://localhost:3000`), Server-Sent Events (SSE) streaming logs, and Telegram notification alerts.

---

## 2. Architecture & Component Map

```
 +-------------------------------------------------------------------------+
 |                            WEB DASHBOARD UI                             |
 |                     (public/index.html, app.js)                         |
 +------------------------------------+------------------------------------+
                                      |
                                      v
 +-------------------------------------------------------------------------+
 |                           EXPRESS REST SERVER                           |
 |               (src/server/app.ts, router.ts, port 3000)                 |
 +------------------+-----------------+-------------------+----------------+
                    |                 |                   |
                    v                 v                   v
 +------------------+---+   +---------+---------+   +-----+----------------+
 |   ACCOUNT HUB    |   |  WORKFLOW ENGINE  |   | ADSPOWER CONNECTOR   |
 |  (src/account-hub)   |   | (src/workflow)    |   | (src/adspower)       |
 |                      |   |                   |   |                      |
 | - SQLite WAL DB      |   | - Checkpoint Log  |   | - Profile Start/Stop |
 | - Repositories       |   | - Batch Runner    |   | - CDP Attachment     |
 | - Sheets Connector   |   | - Retry Loops     |   | - Window Reuse       |
 +----------------------+   +---------+---------+   +-----+----------------+
                                      |                   |
                                      v                   v
                            +---------+-------------------+----------------+
                            |      AUTOMATION ENGINE & CDP DRIVER      |
                            |     (src/automation, src/dom/cdp.ts)     |
                            +-------------------------+----------------+
                                                      |
                                                      v
                            +-------------------------+----------------+
                            |      3-TIER SELF-HEALING ENGINE          |
                            |     (src/recovery, src/skills, src/utils)|
                            |                                          |
                            | Tier 1: Selector Fallback Retry          |
                            | Tier 2: Skill Store Lookup (JSON/DB)     |
                            | Tier 3: LLM AI Analyzer (Gemini/9router) |
                            +------------------------------------------+
```

### Component Breakdown
1. **AdsPower Connector (`src/adspower/client.ts`)**: Wraps AdsPower Local REST API, manages rate limiting (1.1s interval), caches profile lists, and starts/stops browser instances.
2. **Playwright CDP Driver (`src/dom/cdp.ts`)**: Connects over WebSocket CDP (`chromium.connectOverCDP`), reuses active tabs, handles navigation timeouts with auto-stop/reload retries, and executes DOM actions.
3. **Facebook Login Automation (`src/automation/facebook-login.ts`)**: End-to-end 14-state machine for Facebook authentication, 2FA TOTP handling, intermediate page clearing, and checkpoint detection.
4. **Batch Runner (`src/automation/batch-runner.ts`, `src/automation/run-fb-batch.ts`)**: Manages multi-threaded parallel execution across profiles with concurrency caps and launch staggering.
5. **Workflow Engine (`src/workflow/engine.ts`)**: Executes multi-step workflows, manages progress checkpoints (`data/workflow-checkpoints.json`), supports pause/resume/cancel, and triggers AI batch summaries.
6. **3-Tier Recovery Engine (`src/recovery/`, `src/skills/`, `src/utils/`)**:
   - `classifier.ts`: Categorizes failures into Transient (Tier 1), Structural (Tier 2), Blocked (Tier 3), or Data (Tier 3).
   - `healing-orchestrator.ts`: Manages multi-stage recovery.
   - `repository.ts`: Skill Store persistence (`data/skills.json`).
   - `ai-analyzer.ts`: Compact DOM serialization and LLM prompt generation.
7. **Account Data Hub (`src/account-hub/`)**: SQLite database (`data/adspower_automation.sqlite`), Google Sheets v4 connector, reconciliation adapter, and sync job runner.
8. **AdsPower 2FA Extension Bridge (`adspower_login/`)**: Chrome Extension Manifest v3 bridge for reading TOTP codes from AdsPower start page and injecting into Facebook 2FA inputs.

---

## 3. Main Entry Points

- **Express Server & Web Application**: `src/server/app.ts` (listens on port 3000 via `src/index.ts`).
- **Single Profile Login CLI**: `src/automation/run-fb-login.ts` (`tsx src/automation/run-fb-login.ts "[Profile Name]"`).
- **Batch Login CLI**: `src/automation/run-fb-batch.ts` (`npm run run-fb-batch -- --profiles "P1,P2" --concurrency 3`).
- **Facebook Page Inventory CLI**: `src/automation/facebook-page-inventory.ts`.
- **Facebook Page Share CLI**: `src/automation/share-fb-page.ts`.
- **Desktop Electron Application**: `src/desktop/main.ts` (`npm run desktop`).

---

## 4. Operational Commands & Package Scripts

| Script / Command | Action / Execution Path | Description |
| :--- | :--- | :--- |
| `npm run build` | `tsc` | Transpiles TypeScript source code to `./dist`. |
| `npx tsc --noEmit` | Typecheck | Validates TypeScript types across `src/` without emitting files. |
| `npm start` | `tsx src/index.ts` | Starts local Express server listening on `http://localhost:3000`. |
| `npm run dev` | `tsx watch src/index.ts` | Development mode with live file watching. |
| `npm run cli` | `tsx src/cli/index.ts` | Currently broken: `src/cli/index.ts` is referenced by `package.json` but is absent from this worktree. |
| `npm run test:adspower` | `tsx src/adspower/test-connection.ts` | Tests connectivity to AdsPower Local API (`/status`). |
| `npm run run-fb-batch` | `tsx src/automation/run-fb-batch.ts` | Runs multi-threaded Facebook login batch automation. |
| `npm run run-fb-share` | `tsx src/automation/share-fb-page.ts` | Runs Facebook page post sharing script. |
| `npx tsx tests/facebook-page-inventory.test.ts` | Unit Test Suite | Runs 19 behavioral & unit tests for Facebook Page Inventory. |
| `npx tsx tests/account-hub/unit/config.test.ts` | Unit Test Suite | Runs 12 unit tests for Account Hub configuration flags. |

---

## 5. Configuration & Environment Variables

All environment variables are loaded via `dotenv` from `.env` at repository root. Sensitive secret values MUST NOT be hardcoded or checked into source control.

### Environment Variable Keys
- **AdsPower Local API**: `ADSPOWER_API_URL`, `ADSPOWER_API_KEY`, `ADSPOWER_TIMEOUT_MS`.
- **LLM / AI Self-Healing**: `LLM_PROVIDER`, `LLM_MODEL`, `NINEROUTER_BASE_URL`, `NINEROUTER_API_KEY`, `NINEROUTER_GROUP`, `GEMINI_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`.
- **Telegram Alert System**: `TELEGRAM_ENABLED`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`.
- **Concurrency & Browser Behavior**: `MAX_CONCURRENT_PROFILES`, `PROFILE_START_TIMEOUT_MS`, `DOM_ACTION_TIMEOUT_MS`, `CLOSE_SUCCESS_BROWSERS`.
- **Persistence & Logging**: `DATABASE_PATH`, `LOG_LEVEL`.
- **Account Data Hub**: `ACCOUNT_HUB_ENABLED`, `ACCOUNT_HUB_DB_PATH`, `ACCOUNT_HUB_SHEET_SYNC_ENABLED`, `ACCOUNT_HUB_ADSPOWER_RECONCILE_ENABLED`, `ACCOUNT_HUB_AUTO_IMPORT_ENABLED`, `ACCOUNT_HUB_AUTO_LOGIN_ENABLED`, `ACCOUNT_HUB_DRY_RUN`.

---

## 6. Persistence & Data Files

- `./data/adspower_automation.sqlite`: Main SQLite Write-Ahead Logging (WAL) database storing Account Hub entities, audit logs, and sync jobs.
- `./data/system_config.json`: Runtime configuration overrides saved from Web Dashboard settings.
- `./data/workflow-checkpoints.json`: Workflow Engine step progress and recovery state for active/paused batch tasks.
- `./data/skills.json`: Persistent Skill Store containing selector chains, success counts, and version histories (`candidate` / `testing` / `verified` / `rollback`).
- `./data/healing-log.json`: Event log recording self-healing interventions, tokens consumed, and resolution paths.

---

## 7. Current Working-Tree Caveats

> [!IMPORTANT]
> - **Pre-existing Dirty Worktree Notice**: At audit time (2026-08-22), the repository contains numerous modified and untracked user-owned files. Counts are intentionally omitted because this active worktree can change while the audit is being reviewed.
> - **Preservation Requirement**: All uncommitted changes represent active user work in progress. They MUST NOT be reverted, reset, stashed, committed, or deleted.
> - **Type Check Baseline**: Running `npx tsc --noEmit` reports 6 compilation errors (5 DOM global errors in `src/dom/cdp.ts` and 1 `.disconnect()` call error in `src/automation/share-fb-page.ts`).

---

## 8. Conventions & Authority Matrix

- `MASTER_TODO.md`: Single source of truth for overall system inventory, architecture, roadmap, technical debt, and risk log.
- `TODO.md`: Operational execution queue containing active task IDs, acceptance criteria, file scope, and verification steps.
- `CHANGELOG.md`: Chronological log of committed changes and uncommitted working-tree state under `[Unreleased]`.
- `implementation_plan.md`: Phase-by-phase feature development roadmap.
- `activity_diagram_guide.md`: Detailed Mermaid activity diagrams and step-by-step operational descriptions.

---

## 9. Recommended Onboarding Reading Order

For engineers (Codex / Lien) taking over or extending the project:
1. `docs/PROJECT_CONTEXT.md` *(this document)* — System baseline and architecture.
2. `docs/LOGIN_WORKFLOW_STATUS.md` — Detailed audit of Facebook/AdsPower login pipeline.
3. `MASTER_TODO.md` — Complete system inventory and multi-phase roadmap.
4. `TODO.md` — Active task queue (`FEAT-007`, `BUG-001`, `BUG-002`, etc.).
5. `activity_diagram_guide.md` — Visual activity flow for login and error recovery.
6. `src/automation/facebook-login.ts` — Core 14-state Facebook login implementation.
