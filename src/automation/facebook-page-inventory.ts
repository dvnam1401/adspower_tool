import { Page } from 'playwright-core';
import { adsPowerClient } from '../adspower/client.js';
import { cdpManager } from '../dom/cdp.js';
import { facebookLoginAutomation } from './facebook-login.js';
import { logger } from '../utils/logger.js';

export type PageInventoryPhase =
  | 'OPEN_SWITCHER'
  | 'SELECT_CANDIDATE'
  | 'CLASSIFY'
  | 'CAPTURE'
  | 'REOPEN'
  | 'LOCATE_CHECKPOINT'
  | 'EXPAND'
  | 'COMPLETE'
  | 'FAILED';

export interface PageInventoryItem {
  pageName: string;
  pageUrl: string | null;
  pageId?: string;
  evidenceSource: 'graphql' | 'dom' | 'dom_unresolved';
  verified: boolean;
  category?: string;
  rawHref?: string;
  profileType?: 'page' | 'personal';
}

export interface CheckpointInfo {
  key: string;
  name: string;
  url: string | null;
}

export interface PageInventoryOptions {
  maxExpansions?: number;
  timeoutMs?: number;
  keepBrowserOpen?: boolean;
  showUnresolved?: boolean;
  onProgress?: (msg: string, current: number, total: number) => void;
  cancelSignal?: { cancelled: boolean };
  pageInstance?: Page;
}

export interface ValidatedScanInput {
  profileId: string;
  maxExpansions: number;
  timeoutMs: number;
  keepBrowserOpen: boolean;
  showUnresolved: boolean;
}

export interface PageInventoryJobProgress {
  percent: number;
  stage: string;
  phase: PageInventoryPhase;
  detail: string;
  expansionsCount: number;
  seeMoreClicks: number;
  checkpoint: CheckpointInfo | null;
  processedCount: number;
  discoveredCount: number;
  verifiedCount: number;
}

export interface PageInventoryJobResult {
  verifiedPages: PageInventoryItem[];
  unresolvedItems: PageInventoryItem[];
  totalScanned: number;
  discoveredPageCount: number;
  verifiedPageCount: number;
  unresolvedPageCount: number;
  missingPageNames: string[];
}

export interface PageInventoryJob {
  jobId: string;
  profileId: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  progress: PageInventoryJobProgress;
  result?: PageInventoryJobResult;
  error?: string;
  options: {
    maxExpansions: number;
    timeoutMs: number;
    keepBrowserOpen: boolean;
    showUnresolved: boolean;
  };
  startedAt: string;
  finishedAt?: string;
  cancelled?: boolean;
}

export interface SwitcherItem {
  index: number;
  raw: string;
  cleanName: string;
  pageId?: string;
  href?: string;
  itemKey: string;
  isSelected?: boolean;
}

export interface RawSwitcherRow {
  index: number;
  raw: string;
  ariaLabel: string;
  href?: string;
  pageId?: string;
  isSelected: boolean;
  top: number;
}

export const YOUR_PROFILE_SELECTORS = [
  '[aria-label="Your profile" i]',
  '[aria-label="Trang cá nhân của bạn" i]',
  '[aria-label="Trang cá nhân" i]',
  '[aria-label="Tài khoản" i]',
  '[aria-label="Account" i]',
  '[aria-label="Tài khoản, cài đặt và hơn thế nữa" i]',
  '[aria-label="Account controls and settings" i]',
];

export const SEE_ALL_PROFILES_SELECTORS = [
  '[aria-label="See all profiles" i]',
  '[aria-label="Xem tất cả trang cá nhân" i]',
  '[aria-label="Xem tất cả các trang cá nhân" i]',
  '[aria-label="Chuyển sang trang cá nhân khác" i]',
  'div[role="button"]:has-text("Xem tất cả trang cá nhân")',
  'div[role="button"]:has-text("See all profiles")',
  'span:has-text("Xem tất cả trang cá nhân")',
  'span:has-text("See all profiles")',
];

export const SEE_MORE_PROFILES_SELECTORS = [
  '[aria-label="See more profiles" i]',
  '[aria-label="Xem thêm trang cá nhân" i]',
  'div[role="button"]:has-text("Xem thêm trang cá nhân")',
  'div[role="button"]:has-text("See more profiles")',
  'span:has-text("Xem thêm trang cá nhân")',
  'span:has-text("See more profiles")',
];

// Nút avatar-image bên trong switcher/menu dùng để thực sự điều hướng vào trang identity đã chọn.
export const SWITCHER_AVATAR_IMAGE_SELECTORS = [
  '[aria-label="Trang cá nhân của bạn" i][aria-expanded]',
  '[aria-label="Your profile" i][aria-expanded]',
  '[aria-expanded="false"][role="button"] svg image',
  '[aria-expanded] svg image',
];

// Nhãn nút toggle "Show/Hide menu" — tín hiệu nhận biết một identity là Page.
export const PAGE_MENU_TOGGLE_LABELS = ['show menu', 'hide menu', 'hiển thị menu', 'ẩn menu'];

// Vấn đề 2b: nút "Xem thêm trang" / "See more pages" (khác với "Xem thêm trang cá nhân").
export const SEE_MORE_PAGES_SELECTORS = [
  '[aria-label="See more pages" i]',
  '[aria-label="Xem thêm trang" i]',
  'div[role="button"]:has-text("Xem thêm trang")',
  'div[role="button"]:has-text("See more pages")',
  'span:has-text("Xem thêm trang")',
  'span:has-text("See more pages")',
];

// Vấn đề 1: thông báo "Chào mừng bạn đến với Trang mới!" — cần bấm "Dùng Trang" để tắt.
// Vấn đề 2a: khớp đa ngôn ngữ bằng token nên liệt kê cả biến thể phổ biến.
export const USE_PAGE_BUTTON_TOKENS = ['dùng trang', 'use page', 'sử dụng trang'];
export const WELCOME_NEW_PAGE_TOKENS = [
  'chào mừng bạn đến với trang mới',
  'welcome to your new page',
  'welcome to the new page',
];

const SYSTEM_PATH_PREFIXES = [
  '/',
  '/home.php',
  '/home',
  '/index.php',
  '/login',
  '/logout',
  '/checkpoint',
  '/settings',
  '/messages',
  '/notifications',
  '/friends',
  '/watch',
  '/marketplace',
  '/gaming',
  '/groups',
  '/events',
  '/saved',
  '/pages',
  '/memories',
  '/adsmanager',
  '/business',
  '/meta',
  '/help',
  '/privacy',
  '/terms',
  '/policies',
  '/recover',
  '/allactivity',
  '/dyi',
  '/me',
  '/bookmarks',
  '/stories',
  '/reels',
  '/live',
  '/pay',
  '/ads',
  '/insights',
  '/search',
];

// ==========================================
// Node-side helper functions
// MUST NOT be called inside page.evaluate()
// ==========================================

export function isWorkTabUrl(urlStr: string): boolean {
  if (!urlStr || typeof urlStr !== 'string') return false;
  try {
    const parsed = new URL(urlStr);
    const host = parsed.hostname.toLowerCase();
    if (host === 'business.facebook.com' || host.includes('adspower')) return false;
    return host === 'www.facebook.com' || host === 'facebook.com' || host === 'web.facebook.com';
  } catch {
    return false;
  }
}

export function cleanPageName(raw: string | null | undefined): string {
  if (!raw || typeof raw !== 'string') return '';
  let s = raw.trim();
  if (!s) return '';

  s = s.split('\n')[0].trim();
  s = s.replace(/^Switch to\s+/gi, '');
  s = s.replace(/^Chuyển sang\s+/gi, '');

  s = s.replace(/,?\s*\d+\s*(?:unseen\s*)?notifications?/gi, '');
  s = s.replace(/,?\s*\d+\s*unseen\s*updates?/gi, '');
  s = s.replace(/,?\s*currently\s*selected/gi, '');
  s = s.replace(/,?\s*đang\s*được\s*chọn/gi, '');
  s = s.replace(/\s*\(\d+\s*thông\s*báo\s*mới\)/gi, '');
  s = s.replace(/\s*\(\d+\s*cập\s*nhật\s*chưa\s*xem\)/gi, '');
  s = s.replace(/\s*\(\s*id\s*=\s*[^)]+\)/gi, '');

  return s.trim();
}

export function isControlName(name: string): boolean {
  if (!name || name.trim().length < 2) return true;
  const lower = name.toLowerCase().trim();
  const controls = [
    'see more',
    'xem thêm',
    'create',
    'tạo trang',
    'see all',
    'xem tất cả',
    'accounts center',
    'trung tâm tài khoản',
    'close',
    'đóng',
    'settings & privacy',
    'help & support',
    'report a problem',
    'display & accessibility',
    'log out',
    'footer links',
    'quản lý',
    'manage',
  ];

  return controls.some(c => lower === c || lower.includes(c));
}

export function escapeSelectorText(text: string): string {
  if (!text || typeof text !== 'string') return '';
  return text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export function isFacebookSystemPath(pathname: string): boolean {
  if (!pathname || typeof pathname !== 'string') return true;
  let clean = pathname.trim().toLowerCase();
  if (clean.length > 1 && clean.endsWith('/')) {
    clean = clean.slice(0, -1);
  }
  if (!clean || clean === '' || clean === '/') return true;

  for (const prefix of SYSTEM_PATH_PREFIXES) {
    if (clean === prefix) return true;
    if (prefix !== '/' && clean.startsWith(`${prefix}/`)) return true;
  }

  if (/^\/pages(?:\/|$)/.test(clean) && !/^\/pages\/[^\/]+\/\d+$/.test(clean)) {
    return true;
  }

  return false;
}

export function isValidPageUrl(urlStr: string): boolean {
  if (!urlStr || typeof urlStr !== 'string') return false;
  try {
    const u = new URL(urlStr, 'https://www.facebook.com');
    const host = u.hostname.toLowerCase();
    if (!host.endsWith('facebook.com') && !host.endsWith('fb.com')) return false;

    let pathname = u.pathname;
    if (pathname.length > 1 && pathname.endsWith('/')) {
      pathname = pathname.slice(0, -1);
    }

    if (isFacebookSystemPath(pathname)) return false;
    return true;
  } catch {
    return false;
  }
}

export function formatCanonicalPageUrl(rawUrl: string): string {
  try {
    const u = new URL(rawUrl, 'https://www.facebook.com');
    if (u.pathname === '/profile.php' && u.searchParams.has('id')) {
      return `${u.origin}/profile.php?id=${u.searchParams.get('id')}`;
    }
    return `${u.origin}${u.pathname}`;
  } catch {
    return rawUrl;
  }
}

export function normalizeFacebookUrl(rawUrl: string): string | null {
  if (!isValidPageUrl(rawUrl)) return null;
  return formatCanonicalPageUrl(rawUrl);
}

export function generateItemKey(
  item: { cleanName: string; pageId?: string; href?: string | null },
  occurrenceIndex: number
): string {
  if (item.pageId) {
    return `id:${item.pageId}`;
  }
  if (item.href) {
    const normalized = normalizeFacebookUrl(item.href);
    if (normalized) return `url:${normalized.toLowerCase()}`;
  }
  const clean = cleanPageName(item.cleanName).toLowerCase();
  return `occurrence:${clean}_${occurrenceIndex}`;
}

export function isBottomReached(currentScrollTop: number, maxScrollTop: number, tolerance = 15): boolean {
  return currentScrollTop >= Math.max(0, maxScrollTop - tolerance);
}

export function isScrollProgressMade(beforeScrollTop: number, afterScrollTop: number, tolerance = 5): boolean {
  return afterScrollTop > beforeScrollTop + tolerance;
}

export function shouldIncrementSeeMoreProgress(
  clickSuccess: boolean,
  beforeKeys: string[],
  afterKeys: string[],
  beforeScrollHeight: number,
  afterScrollHeight: number
): boolean {
  if (!clickSuccess) return false;
  const beforeSet = new Set(beforeKeys);
  const newKeysFound = afterKeys.some(k => !beforeSet.has(k));
  const scrollHeightGrew = afterScrollHeight > beforeScrollHeight + 10;
  return newKeysFound || scrollHeightGrew;
}

export function evaluateCheckpointMatch(
  eligibleItems: Array<{ itemKey: string; cleanName: string; pageId?: string }>,
  checkpoint: CheckpointInfo | null
): { index: number; ambiguous: boolean } {
  if (!checkpoint) return { index: -1, ambiguous: false };

  const keyIdx = eligibleItems.findIndex(i => i.itemKey === checkpoint.key);
  if (keyIdx >= 0) return { index: keyIdx, ambiguous: false };

  const matchingNameIndices = eligibleItems
    .map((item, idx) => (cleanPageName(item.cleanName).toLowerCase() === checkpoint.name.toLowerCase() ? idx : -1))
    .filter(idx => idx >= 0);

  if (matchingNameIndices.length === 1) {
    return { index: matchingNameIndices[0], ambiguous: false };
  } else if (matchingNameIndices.length > 1) {
    return { index: -1, ambiguous: true };
  }

  return { index: -1, ambiguous: false };
}

export function findNextUnprocessedItem<T extends { itemKey: string }>(
  eligibleItems: T[],
  processedKeys: Set<string>,
  startIndex = 0
): { item: T; index: number } | null {
  for (let i = startIndex; i < eligibleItems.length; i++) {
    if (!processedKeys.has(eligibleItems[i].itemKey)) {
      return { item: eligibleItems[i], index: i };
    }
  }
  return null;
}

export async function waitForSwitcherOpen(
  isExpandedSwitcherOpen: () => Promise<boolean>,
  timeoutMs = 8000,
  pollIntervalMs = 300
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await isExpandedSwitcherOpen()) {
      return true;
    }
    await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
  }
  return await isExpandedSwitcherOpen();
}

export function deriveOriginalPersonalIdentity(
  eligibleItems: Array<{ cleanName: string; isPersonal?: boolean; isSelected?: boolean }>,
  selectedEvidenceName?: string | null
): { name: string | null; valid: boolean } {
  if (selectedEvidenceName) {
    const clean = cleanPageName(selectedEvidenceName);
    if (clean) return { name: clean, valid: true };
  }

  const checkedItem = eligibleItems.find(item => item.isSelected);
  if (checkedItem) {
    return { name: checkedItem.cleanName, valid: true };
  }

  if (eligibleItems.length > 0 && (eligibleItems[0].isPersonal || !isControlName(eligibleItems[0].cleanName))) {
    return { name: eligibleItems[0].cleanName, valid: true };
  }

  return { name: null, valid: false };
}

export function parseBooleanStrict(val: any, defaultVal: boolean): boolean | null {
  if (val === undefined || val === null) return defaultVal;
  if (typeof val === 'boolean') return val;
  if (typeof val === 'string') {
    const s = val.trim().toLowerCase();
    if (s === 'true' || s === '1') return true;
    if (s === 'false' || s === '0') return false;
  }
  return null;
}

export function validatePageInventoryScanInput(input: any): { valid: boolean; data?: ValidatedScanInput; error?: string } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { valid: false, error: 'Input body phải là JSON object.' };
  }

  const rawId = input.profileId || input.profileNo || input.id || input.profile;
  if (rawId === undefined || rawId === null || typeof rawId !== 'string') {
    return { valid: false, error: 'profileId là bắt buộc và phải là chuỗi ký tự.' };
  }

  const profileId = rawId.trim();
  if (profileId.length === 0) {
    return { valid: false, error: 'profileId không được để rỗng.' };
  }

  let maxExpansions = 100;
  if (input.maxExpansions !== undefined && input.maxExpansions !== null) {
    const num = Number(input.maxExpansions);
    if (!Number.isFinite(num) || !Number.isInteger(num) || num < 1 || num > 200) {
      return { valid: false, error: 'maxExpansions phải là số nguyên hữu hạn từ 1 đến 200.' };
    }
    maxExpansions = num;
  }

  let timeoutMs = 30000;
  if (input.timeoutMs !== undefined && input.timeoutMs !== null) {
    const num = Number(input.timeoutMs);
    if (!Number.isFinite(num) || !Number.isInteger(num) || num < 5000 || num > 120000) {
      return { valid: false, error: 'timeoutMs phải là số nguyên hữu hạn từ 5000 đến 120000.' };
    }
    timeoutMs = num;
  }

  const keepBrowserOpen = parseBooleanStrict(input.keepBrowserOpen, true);
  if (keepBrowserOpen === null) {
    return { valid: false, error: 'keepBrowserOpen phải là giá trị boolean (true hoặc false).' };
  }

  const showUnresolved = parseBooleanStrict(input.showUnresolved, true);
  if (showUnresolved === null) {
    return { valid: false, error: 'showUnresolved phải là giá trị boolean (true hoặc false).' };
  }

  return {
    valid: true,
    data: {
      profileId,
      maxExpansions,
      timeoutMs,
      keepBrowserOpen,
      showUnresolved,
    },
  };
}

export function isPersonalProfile(entity: any, loggedInUserId?: string): boolean {
  if (!entity || typeof entity !== 'object') return false;

  const typename = entity.__typename || entity.typename || '';
  if (typename === 'User' || typename === 'Actor' || typename === 'Person') {
    return true;
  }

  if (entity.is_user === true || entity.is_personal_profile === true) {
    return true;
  }

  const id = String(entity.id || entity.user_id || '');
  if (loggedInUserId && id && id === String(loggedInUserId)) {
    return true;
  }

  return false;
}

export function parseGraphQLResponse(responseText: string): any[] {
  if (!responseText || typeof responseText !== 'string') return [];

  let text = responseText.trim();
  text = text.replace(/^(?:for\s*\(\s*;\s*;\s*\);?|while\s*\(\s*1\s*\);?)/i, '').trim();
  if (!text) return [];

  try {
    const singleDoc = JSON.parse(text);
    return [singleDoc];
  } catch {
    const results: any[] = [];
    const lines = text.split('\n');

    for (const line of lines) {
      const cleanLine = line.trim();
      if (!cleanLine) continue;
      try {
        const parsed = JSON.parse(cleanLine);
        results.push(parsed);
      } catch {}
    }

    return results;
  }
}

export function extractPageEntitiesFromGraphQL(parsedJson: any, loggedInUserId?: string): PageInventoryItem[] {
  const items: PageInventoryItem[] = [];
  const visited = new Set<any>();

  function traverse(obj: any) {
    if (!obj || typeof obj !== 'object' || visited.has(obj)) return;
    visited.add(obj);

    if (Array.isArray(obj)) {
      for (const child of obj) traverse(child);
      return;
    }

    if (obj.profile_switcher_comet_login && typeof obj.profile_switcher_comet_login === 'object') {
      const loginObj = obj.profile_switcher_comet_login;
      const rawName = loginObj.name || loginObj.page_name || '';
      const pageName = cleanPageName(rawName);
      const pageId = loginObj.id ? String(loginObj.id) : undefined;
      if (pageName && !isControlName(pageName) && !isPersonalProfile(loginObj, loggedInUserId)) {
        items.push({
          pageName,
          pageUrl: pageId ? `https://www.facebook.com/profile.php?id=${pageId}` : null,
          pageId,
          evidenceSource: 'graphql',
          verified: true,
        });
      }
    }

    const typename = obj.__typename || '';
    const isPageType =
      typename === 'Page' ||
      typename === 'ProfileSwitcherPage' ||
      typename === 'DelegatePage' ||
      obj.category_type !== undefined ||
      obj.page_likers !== undefined ||
      obj.fan_count !== undefined ||
      obj.delegate_page !== undefined;

    if (isPageType && !isPersonalProfile(obj, loggedInUserId)) {
      const rawName = obj.name || obj.page_name || obj.title || '';
      const pageName = cleanPageName(rawName);
      const pageId = obj.id || obj.page_id || obj.delegate_page?.id;
      const rawUrl = obj.url || obj.uri || obj.link || obj.vanity;
      const normalizedUrl = rawUrl ? normalizeFacebookUrl(rawUrl) : null;

      if (pageName && !isControlName(pageName)) {
        if (normalizedUrl || pageId) {
          items.push({
            pageName,
            pageUrl: normalizedUrl || (pageId ? `https://www.facebook.com/profile.php?id=${pageId}` : null),
            pageId: pageId ? String(pageId) : undefined,
            evidenceSource: 'graphql',
            verified: true,
            category: obj.category || obj.category_type,
          });
        } else {
          items.push({
            pageName,
            pageUrl: null,
            pageId: undefined,
            evidenceSource: 'graphql',
            verified: false,
          });
        }
      }
    }

    for (const key of Object.keys(obj)) {
      if ((key === 'user' || key === 'viewer') && isPersonalProfile(obj[key], loggedInUserId)) {
        continue;
      }
      traverse(obj[key]);
    }
  }

  traverse(parsedJson);
  return items;
}

export function isProfilesAndPagesDialog(dialogText: string): boolean {
  if (!dialogText || typeof dialogText !== 'string') return false;
  const t = dialogText.toLowerCase();
  return (
    t.includes('your profiles & pages') ||
    t.includes('trang cá nhân & trang') ||
    t.includes('trang cá nhân và trang') ||
    t.includes('profiles & pages') ||
    t.includes('trang & trang cá nhân') ||
    t.includes('trang và trang cá nhân') ||
    t.includes('pages & profiles')
  );
}

export function extractDOMSwitcherItemsFromContainer(doc: any): Array<{ name: string; href: string | null }> {
  if (!doc) return [];
  const docObj: any = doc || (globalThis as any).document;
  if (!docObj || !docObj.querySelectorAll) return [];
  const dialogs: any[] = Array.from(docObj.querySelectorAll('[role="dialog"], [role="menu"]'));

  const switcherContainer: any = dialogs.find((d: any) => {
    const text = ((d && (d.innerText || d.textContent)) || '').toLowerCase();
    return isProfilesAndPagesDialog(text);
  });

  if (!switcherContainer) return [];

  const entryNodes: any[] = Array.from(
    switcherContainer.querySelectorAll('[role="radio"], [role="button"], a[href], [role="listitem"]')
  );

  const items: Array<{ name: string; href: string | null }> = [];
  const visitedNames = new Set<string>();

  for (const node of entryNodes) {
    const rawText: string = ((node && (node.innerText || node.textContent)) || '').trim();
    const ariaLabel: string = (node && node.getAttribute ? (node.getAttribute('aria-label') || '') : '').trim();
    const rawCandidate = ariaLabel ? ariaLabel.split(',')[0].trim() : rawText;

    const cleaned = cleanPageName(rawCandidate);
    if (!cleaned || isControlName(cleaned)) continue;

    if (visitedNames.has(cleaned.toLowerCase())) continue;
    visitedNames.add(cleaned.toLowerCase());

    let hrefAttr: string | null = (node && node.getAttribute ? node.getAttribute('href') : null) || null;
    if (!hrefAttr && node && node.querySelector) {
      const anchor = node.querySelector('a[href]');
      if (anchor) hrefAttr = anchor.getAttribute('href');
    }

    items.push({
      name: cleaned,
      href: hrefAttr,
    });
  }

  return items;
}

export function deduplicatePageInventory(items: PageInventoryItem[]): {
  verified: PageInventoryItem[];
  unresolved: PageInventoryItem[];
} {
  const verifiedMap = new Map<string, PageInventoryItem>();
  const unresolvedList: PageInventoryItem[] = [];

  for (const item of items) {
    const cleanName = cleanPageName(item.pageName);
    if (!cleanName || isControlName(cleanName)) continue;

    if (!item.verified || !item.pageUrl) {
      const exists = unresolvedList.some(u => u.pageName.toLowerCase() === cleanName.toLowerCase());
      if (!exists) {
        unresolvedList.push({
          pageName: cleanName,
          pageUrl: null,
          pageId: item.pageId,
          evidenceSource: item.evidenceSource,
          verified: false,
        });
      }
      continue;
    }

    const key = item.pageId ? `id:${item.pageId}` : `url:${item.pageUrl.toLowerCase()}`;
    const existing = verifiedMap.get(key);

    if (!existing) {
      verifiedMap.set(key, { ...item, pageName: cleanName });
    } else {
      if (existing.evidenceSource !== 'graphql' && item.evidenceSource === 'graphql') {
        verifiedMap.set(key, { ...item, pageName: cleanName });
      } else if (!existing.pageId && item.pageId) {
        existing.pageId = item.pageId;
      } else if (!existing.pageUrl && item.pageUrl) {
        existing.pageUrl = item.pageUrl;
      }
    }
  }

  const verifiedList = Array.from(verifiedMap.values());
  const finalUnresolved = unresolvedList.filter(u => {
    return !verifiedList.some(
      v => v.pageName.toLowerCase() === u.pageName.toLowerCase() || (u.pageId && v.pageId === u.pageId)
    );
  });

  return {
    verified: verifiedList,
    unresolved: finalUnresolved,
  };
}

export function cleanupTerminalJobs(
  jobMap: Map<string, PageInventoryJob>,
  maxTerminalRetained = 50
): number {
  const terminalJobs = Array.from(jobMap.values()).filter(
    j => j.status === 'completed' || j.status === 'failed' || j.status === 'cancelled'
  );

  if (terminalJobs.length <= maxTerminalRetained) return 0;

  terminalJobs.sort((a, b) => new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime());

  const toRemove = terminalJobs.length - maxTerminalRetained;
  let removed = 0;

  for (let i = 0; i < toRemove; i++) {
    const job = terminalJobs[i];
    if (job && job.status !== 'running') {
      jobMap.delete(job.jobId);
      removed++;
    }
  }

  return removed;
}

export interface DriverItem {
  cleanName: string;
  pageId?: string;
  href?: string;
  isPersonal?: boolean;
  isSelected?: boolean;
}

export interface DriverState {
  visibleItems: DriverItem[];
  hasSeeMore: boolean;
  scrollTop: number;
  maxScrollTop: number;
  seeMoreAppendsItems?: DriverItem[];
  seeMoreFails?: boolean;
  isOpenedAsyncMs?: number;
}

export interface DriverOptions {
  maxExpansions?: number;
  maxIterations?: number;
  originalPersonalIdentity?: string | null;
  restoreFails?: boolean;
}

export interface DriverOutput {
  status: 'completed' | 'failed';
  error?: string;
  verifiedPages: Array<{ name: string; key: string }>;
  processedKeys: string[];
  iterations: number;
  seeMoreClicks: number;
  switcherOpenClicks: number;
}

export function runInventoryPhaseDriver(
  initialState: DriverState,
  options: DriverOptions = {}
): DriverOutput {
  const processedKeys = new Set<string>();
  const verifiedPages: Array<{ name: string; key: string }> = [];
  let currentCheckpoint: CheckpointInfo | null = null;
  let seeMoreClicksCount = 0;
  let seeMoreNoProgressFailures = 0;
  let switcherOpenClicks = 0;
  let iterationCount = 0;
  const maxIterations = options.maxIterations || 50;

  const state: DriverState = {
    ...initialState,
    visibleItems: [...initialState.visibleItems],
  };

  if (state.isOpenedAsyncMs !== undefined) {
    if (state.isOpenedAsyncMs === 0) {
      switcherOpenClicks = 0;
    } else if (state.isOpenedAsyncMs <= 8000) {
      switcherOpenClicks = 1;
    } else {
      return {
        status: 'failed',
        error: 'Không thể mở menu "Your profiles & Pages" hoặc "See all profiles".',
        verifiedPages: [],
        processedKeys: [],
        iterations: 0,
        seeMoreClicks: 0,
        switcherOpenClicks: 1,
      };
    }
  }

  while (iterationCount < maxIterations) {
    iterationCount++;

    const occurrenceMap = new Map<string, number>();
    const eligibleItems: SwitcherItem[] = state.visibleItems.map((item, idx) => {
      const lowerClean = cleanPageName(item.cleanName).toLowerCase();
      const currOcc = occurrenceMap.get(lowerClean) || 0;
      occurrenceMap.set(lowerClean, currOcc + 1);
      const itemKey = generateItemKey(item, currOcc);
      return {
        index: idx,
        raw: item.cleanName,
        cleanName: item.cleanName,
        pageId: item.pageId,
        href: item.href,
        itemKey,
        isSelected: item.isSelected,
      };
    });

    let candidateToSelect: SwitcherItem | null = null;
    let checkpointFoundIndex = -1;

    if (!currentCheckpoint) {
      if (options.originalPersonalIdentity && eligibleItems.length > 0) {
        const personalItem = eligibleItems.find(item => item.cleanName.toLowerCase() === options.originalPersonalIdentity?.toLowerCase());
        if (personalItem) {
          processedKeys.add(personalItem.itemKey);
        }
      }

      const nextMatch = findNextUnprocessedItem<SwitcherItem>(eligibleItems, processedKeys, 0);
      candidateToSelect = nextMatch ? nextMatch.item : null;
    } else {
      const matchResult = evaluateCheckpointMatch(eligibleItems, currentCheckpoint);
      if (matchResult.ambiguous) {
        return {
          status: 'failed',
          error: 'Checkpoint bị mơ hồ (Ambiguous checkpoint): có nhiều tài khoản cùng tên trong switcher.',
          verifiedPages,
          processedKeys: Array.from(processedKeys),
          iterations: iterationCount,
          seeMoreClicks: seeMoreClicksCount,
          switcherOpenClicks,
        };
      }

      checkpointFoundIndex = matchResult.index;

      if (checkpointFoundIndex >= 0) {
        const nextMatch = findNextUnprocessedItem<SwitcherItem>(eligibleItems, processedKeys, checkpointFoundIndex + 1);
        candidateToSelect = nextMatch ? nextMatch.item : null;
      } else {
        const beforeScrollTop = state.scrollTop;
        state.scrollTop = Math.min(state.maxScrollTop, state.scrollTop + 300);
        const scrolled = isScrollProgressMade(beforeScrollTop, state.scrollTop, 5);

        if (scrolled) {
          continue;
        }

        const isBottom = isBottomReached(state.scrollTop, state.maxScrollTop, 15);
        if (!scrolled && isBottom) {
          candidateToSelect = null;
        } else if (!scrolled && !isBottom) {
          return {
            status: 'failed',
            error: 'Checkpoint bị thất lạc (Lost checkpoint): không tìm thấy checkpoint và không thể cuộn thêm.',
            verifiedPages,
            processedKeys: Array.from(processedKeys),
            iterations: iterationCount,
            seeMoreClicks: seeMoreClicksCount,
            switcherOpenClicks,
          };
        }
      }
    }

    if (!candidateToSelect) {
      const isBottom = isBottomReached(state.scrollTop, state.maxScrollTop, 15);

      if (state.hasSeeMore) {
        const beforeKeys = eligibleItems.map(i => i.itemKey);
        const beforeHeight = state.maxScrollTop;

        if (state.seeMoreFails) {
          seeMoreNoProgressFailures++;
          if (seeMoreNoProgressFailures >= 3) {
            return {
              status: 'failed',
              error: 'Nút Xem thêm trang cá nhân hiển thị nhưng không thể thực hiện click hoặc không tải thêm dữ liệu.',
              verifiedPages,
              processedKeys: Array.from(processedKeys),
              iterations: iterationCount,
              seeMoreClicks: seeMoreClicksCount,
              switcherOpenClicks,
            };
          }
          continue;
        }

        if (state.seeMoreAppendsItems && state.seeMoreAppendsItems.length > 0) {
          state.visibleItems.push(...state.seeMoreAppendsItems);
          state.seeMoreAppendsItems = [];
          state.hasSeeMore = false;
          state.maxScrollTop += 300;
          state.scrollTop = state.maxScrollTop;

          const afterOccurrenceMap = new Map<string, number>();
          const afterKeys = state.visibleItems.map(item => {
            const lowerClean = cleanPageName(item.cleanName).toLowerCase();
            const currOcc = afterOccurrenceMap.get(lowerClean) || 0;
            afterOccurrenceMap.set(lowerClean, currOcc + 1);
            return generateItemKey(item, currOcc);
          });

          const hasProgress = shouldIncrementSeeMoreProgress(
            true,
            beforeKeys,
            afterKeys,
            beforeHeight,
            state.maxScrollTop
          );

          if (hasProgress) {
            seeMoreClicksCount++;
            seeMoreNoProgressFailures = 0;
          }
          continue;
        }
      }

      if (isBottom && !state.hasSeeMore) {
        break;
      }
      continue;
    }

    const driverItem = state.visibleItems[candidateToSelect.index];
    if (driverItem && driverItem.isPersonal) {
      processedKeys.add(candidateToSelect.itemKey);
      continue;
    }

    verifiedPages.push({ name: candidateToSelect.cleanName, key: candidateToSelect.itemKey });
    currentCheckpoint = {
      key: candidateToSelect.itemKey,
      name: candidateToSelect.cleanName,
      url: `https://facebook.com/${candidateToSelect.cleanName}`,
    };
    processedKeys.add(candidateToSelect.itemKey);
  }

  if (iterationCount >= maxIterations) {
    return {
      status: 'failed',
      error: `Đạt giới hạn số lần lặp tối đa (MAX_ITERATIONS=${maxIterations}) mà chưa hoàn tất quét.`,
      verifiedPages,
      processedKeys: Array.from(processedKeys),
      iterations: iterationCount,
      seeMoreClicks: seeMoreClicksCount,
      switcherOpenClicks,
    };
  }

  if (options.originalPersonalIdentity && options.restoreFails) {
    return {
      status: 'failed',
      error: `Khôi phục trang cá nhân chính "${options.originalPersonalIdentity}" thất bại.`,
      verifiedPages,
      processedKeys: Array.from(processedKeys),
      iterations: iterationCount,
      seeMoreClicks: seeMoreClicksCount,
      switcherOpenClicks,
    };
  }

  return {
    status: 'completed',
    verifiedPages,
    processedKeys: Array.from(processedKeys),
    iterations: iterationCount,
    seeMoreClicks: seeMoreClicksCount,
    switcherOpenClicks,
  };
}

// ==========================================
// Browser Evaluation Helpers (Pure Inline JS inside page.evaluate)
// NO top-level DOM types or outer function calls!
// ==========================================

export async function isExpandedSwitcherOpen(page: Page): Promise<boolean> {
  if (!page || page.isClosed()) return false;
  return await page.evaluate(() => {
    const doc: any = (globalThis as any).document;
    if (!doc || !doc.querySelectorAll) return false;
    const dialogs: any[] = Array.from(doc.querySelectorAll('div[role="dialog"], div[role="aria-modal"], [role="menu"]'));
    return dialogs.some((d: any) => {
      const t = ((d && (d.innerText || d.textContent)) || '').toLowerCase();
      return (
        t.includes('your profiles & pages') ||
        t.includes('trang cá nhân & trang') ||
        t.includes('trang cá nhân và trang') ||
        t.includes('profiles & pages') ||
        t.includes('trang & trang cá nhân') ||
        t.includes('trang và trang cá nhân') ||
        t.includes('pages & profiles')
      );
    });
  }).catch(() => false);
}

export async function isInitialMenuOpen(page: Page): Promise<boolean> {
  if (!page || page.isClosed()) return false;
  return await page.evaluate(() => {
    const doc: any = (globalThis as any).document;
    if (!doc || !doc.querySelectorAll) return false;
    const dialogs: any[] = Array.from(doc.querySelectorAll('div[role="dialog"], div[role="aria-modal"], [role="menu"]'));
    return dialogs.some((d: any) => {
      const t = ((d && (d.innerText || d.textContent)) || '').toLowerCase();
      return t.includes('see all profiles') || t.includes('xem tất cả trang cá nhân');
    });
  }).catch(() => false);
}

export async function isPageHeaderMenuPresent(page: Page, timeoutMs = 3500): Promise<boolean> {
  if (!page || page.isClosed()) return false;
  try {
    return await page.evaluate(({ timeout }) => {
      return new Promise<boolean>((resolve) => {
        const startTime = Date.now();

        function check() {
          const doc: any = (globalThis as any).document;
          if (!doc || !doc.querySelectorAll) {
            if (Date.now() - startTime >= timeout) return resolve(false);
            setTimeout(check, 200);
            return;
          }

          const headers: any[] = Array.from(
            doc.querySelectorAll('header, div[role="main"] header, div[role="banner"]')
          );

          for (const header of headers) {
            const buttons: any[] = Array.from(header.querySelectorAll('[role="button"]'));
            for (const btn of buttons) {
              const label = (btn.getAttribute ? (btn.getAttribute('aria-label') || '') : '').trim().toLowerCase();
              const exact =
                label === 'show menu' ||
                label === 'hide menu' ||
                label === 'hiển thị menu' ||
                label === 'ẩn menu';
              // Vấn đề 2a: fallback đa ngôn ngữ — nút toggle trong header có nhãn chứa token "menu".
              const tokenMatch = /\bmenu\b|menú|menü/.test(label);
              if (exact || tokenMatch) {
                const rect = btn.getBoundingClientRect ? btn.getBoundingClientRect() : { width: 1, height: 1 };
                if (rect.width > 0 && rect.height > 0) {
                  return resolve(true);
                }
              }
            }
          }

          const allButtons: any[] = Array.from(doc.querySelectorAll('[role="button"][aria-label]'));
          for (const btn of allButtons) {
            const label = (btn.getAttribute ? (btn.getAttribute('aria-label') || '') : '').trim().toLowerCase();
            if (
              label === 'show menu' ||
              label === 'hide menu' ||
              label === 'hiển thị menu' ||
              label === 'ẩn menu'
            ) {
              const rect = btn.getBoundingClientRect ? btn.getBoundingClientRect() : { width: 1, height: 1 };
              if (rect.width > 0 && rect.height > 0) {
                return resolve(true);
              }
            }
          }

          if (Date.now() - startTime >= timeout) {
            return resolve(false);
          }
          setTimeout(check, 200);
        }

        check();
      });
    }, { timeout: timeoutMs });
  } catch {
    return false;
  }
}

export async function captureCanonicalPageDetails(page: Page): Promise<{ name: string; url: string | null; id?: string }> {
  if (!page || page.isClosed()) return { name: '', url: null };

  const currentUrl = page.url();
  return await page.evaluate(({ currentUrl }) => {
    const doc: any = (globalThis as any).document;
    if (!doc) return { name: '', url: currentUrl };

    let name = '';
    const h1 = doc.querySelector('h1');
    if (h1) name = ((h1.innerText || h1.textContent) || '').trim();

    if (!name) {
      const ogTitle = doc.querySelector('meta[property="og:title"]');
      if (ogTitle) name = (ogTitle.getAttribute('content') || '').trim();
    }
    if (!name) {
      name = doc.title || '';
      name = name.replace(/\s*\|.*$/, '').replace(/\s*-.*$/, '').trim();
    }

    let url: string | null = null;
    const canonical = doc.querySelector('link[rel="canonical"]');
    if (canonical) {
      url = canonical.getAttribute('href') || null;
    }
    if (!url) {
      const ogUrl = doc.querySelector('meta[property="og:url"]');
      if (ogUrl) url = ogUrl.getAttribute('content') || null;
    }
    if (!url) {
      url = currentUrl;
    }

    let id: string | undefined = undefined;
    if (url) {
      const match = url.match(/id=(\d+)/) || currentUrl.match(/id=(\d+)/);
      if (match) id = match[1];
    }

    return { name, url, id };
  }, { currentUrl }).catch(() => ({ name: '', url: currentUrl }));
}

/**
 * Diagnostic: chụp trạng thái UI để biết vì sao không mở được switcher.
 * Trả về: danh sách tiêu đề menu/dialog đang mở + selector avatar nào đang visible.
 */
export async function snapshotSwitcherState(page: Page): Promise<any> {
  if (!page || page.isClosed()) return { closed: true };
  const dom: any = await page.evaluate(() => {
    const doc: any = (globalThis as any).document;
    const win: any = (globalThis as any).window;
    if (!doc || !doc.querySelectorAll) return { url: win?.location?.href };
    const containers: any[] = Array.from(doc.querySelectorAll('div[role="dialog"], div[role="aria-modal"], [role="menu"]'));
    const titles = containers.map((d: any) => ({
      role: d.getAttribute ? d.getAttribute('role') : '',
      text: (((d.innerText || d.textContent) || '').trim().slice(0, 120)),
    }));
    // Các nút có aria-label ở banner/top-bar (ứng viên mở menu tài khoản).
    const banner = doc.querySelector('div[role="banner"], [role="navigation"]');
    const bannerBtns = banner
      ? Array.from(banner.querySelectorAll('[role="button"][aria-label]')).map((b: any) => b.getAttribute('aria-label')).slice(0, 20)
      : [];
    return { url: win?.location?.href, lang: doc.documentElement?.lang || '', containerCount: containers.length, titles, bannerBtns };
  }).catch((e: any) => ({ evalError: String(e) }));

  const visibleSelectors: string[] = [];
  for (const sel of YOUR_PROFILE_SELECTORS) {
    try {
      if (await page.locator(sel).first().isVisible({ timeout: 300 }).catch(() => false)) visibleSelectors.push(sel);
    } catch {}
  }
  return { ...dom, visibleAvatarSelectors: visibleSelectors };
}

export async function openSwitcherDialog(page: Page): Promise<boolean> {
  if (!page || page.isClosed()) return false;

  if (await isExpandedSwitcherOpen(page)) return true;

  for (let i = 0; i < 3; i++) {
    if (await isInitialMenuOpen(page)) {
      for (const sel of SEE_ALL_PROFILES_SELECTORS) {
        try {
          const loc = page.locator(sel).first();
          if (await loc.isVisible({ timeout: 1500 }).catch(() => false)) {
            await loc.click({ force: true });
            const opened = await waitForSwitcherOpen(() => isExpandedSwitcherOpen(page), 8000, 300);
            if (opened) return true;
            break;
          }
        } catch {}
      }
    }

    if (await isExpandedSwitcherOpen(page)) return true;

    let clickedNavbar = false;
    for (const sel of YOUR_PROFILE_SELECTORS) {
      try {
        const loc = page.locator(sel).first();
        if (await loc.isVisible({ timeout: 1500 }).catch(() => false)) {
          await loc.click({ force: true });
          clickedNavbar = true;
          break;
        }
      } catch {}
    }

    if (!clickedNavbar) {
      try {
        const lastBannerBtn = page.locator('div[role="banner"] [role="button"]').last();
        if (await lastBannerBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
          await lastBannerBtn.click({ force: true });
          clickedNavbar = true;
        }
      } catch {}
    }

    if (clickedNavbar) {
      await waitForSwitcherOpen(async () => {
        return (await isExpandedSwitcherOpen(page)) || (await isInitialMenuOpen(page));
      }, 5000, 300);

      if (await isExpandedSwitcherOpen(page)) return true;

      if (await isInitialMenuOpen(page)) {
        for (const sel of SEE_ALL_PROFILES_SELECTORS) {
          try {
            const loc = page.locator(sel).first();
            if (await loc.isVisible({ timeout: 1500 }).catch(() => false)) {
              await loc.click({ force: true });
              const openedExpanded = await waitForSwitcherOpen(() => isExpandedSwitcherOpen(page), 8000, 300);
              if (openedExpanded) return true;
              break;
            }
          } catch {}
        }
      }
    }

    if (await isExpandedSwitcherOpen(page)) return true;
    await page.waitForTimeout(1000);
  }

  if (!(await isExpandedSwitcherOpen(page))) {
    try {
      const snap = await snapshotSwitcherState(page);
      logger.warn(`[PageInventory] openSwitcherDialog thất bại. DOM snapshot: ${JSON.stringify(snap)}`);
    } catch {}
  }
  return await isExpandedSwitcherOpen(page);
}

// ==========================================
// Checkpoint-anchored live DOM helpers
// ==========================================

/**
 * Đọc toàn bộ row trong switcher "Your profiles & Pages", đồng thời gắn thuộc tính
 * runtime `data-pageinv-row` theo đúng thứ tự DOM để click sau này bám đúng node
 * (diệt lỗi index-scope của locator .nth()).
 */
export async function readAndTagSwitcherRows(page: Page): Promise<RawSwitcherRow[]> {
  if (!page || page.isClosed()) return [];
  const rows: any = await page.evaluate(() => {
    const doc: any = (globalThis as any).document;
    if (!doc || !doc.querySelectorAll) return [];

    // Xóa tag cũ trên toàn document để tránh lẫn giữa các lần đọc.
    Array.from(doc.querySelectorAll('[data-pageinv-row]')).forEach((n: any) => {
      if (n.removeAttribute) n.removeAttribute('data-pageinv-row');
    });

    const dialogs: any[] = Array.from(doc.querySelectorAll('div[role="dialog"], div[role="aria-modal"], [role="menu"]'));
    const switcher: any = dialogs.find((d: any) => {
      const t = ((d && (d.innerText || d.textContent)) || '').toLowerCase();
      return (
        t.includes('your profiles & pages') ||
        t.includes('trang cá nhân & trang') ||
        t.includes('trang cá nhân và trang') ||
        t.includes('profiles & pages') ||
        t.includes('trang & trang cá nhân') ||
        t.includes('trang và trang cá nhân') ||
        t.includes('pages & profiles')
      );
    });
    if (!switcher) return [];

    const rawNodes: any[] = Array.from(switcher.querySelectorAll('[role="button"], [role="radio"], [role="listitem"]'));
    return rawNodes.map((n: any, idx: number) => {
      if (n.setAttribute) n.setAttribute('data-pageinv-row', String(idx));
      const label = n.getAttribute ? (n.getAttribute('aria-label') || '') : '';
      const text = ((n.innerText || n.textContent) || '').split('\n')[0].trim();
      const raw = label ? label.split(',')[0].trim() : text;

      let href: string | undefined = undefined;
      if (n.getAttribute) href = n.getAttribute('href') || undefined;
      if (!href && n.querySelector) {
        const anchor = n.querySelector('a[href]');
        if (anchor) href = anchor.getAttribute('href') || undefined;
      }

      let pageId: string | undefined = undefined;
      if (label) {
        const match = label.match(/id=(\d+)/);
        if (match) pageId = match[1];
      }

      const isSelected =
        label.includes('currently selected') ||
        label.includes('đang được chọn') ||
        (n.getAttribute && n.getAttribute('aria-checked') === 'true') ||
        (n.getAttribute && n.getAttribute('aria-selected') === 'true');

      const rect = n.getBoundingClientRect ? n.getBoundingClientRect() : { top: 0 };
      return { index: idx, raw, ariaLabel: label, href, pageId, isSelected, top: rect.top || 0 };
    });
  }).catch(() => []);
  return Array.isArray(rows) ? rows : [];
}

/** Click 1 row theo tag runtime data-pageinv-row (cùng node mà readAndTagSwitcherRows đã thấy). */
async function clickTaggedRow(page: Page, rowIndex: number): Promise<boolean> {
  try {
    const loc = page.locator(`[data-pageinv-row="${rowIndex}"]`).first();
    if (!(await loc.isVisible({ timeout: 2000 }).catch(() => false))) return false;
    await loc.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
    await loc.click({ force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Sau khi chọn 1 identity trong switcher, click nút avatar-image để thực sự điều hướng
 * vào trang profile của identity đó (thay cho việc click avatar top-bar mở menu).
 */
export async function openSelectedIdentityProfile(page: Page): Promise<void> {
  if (!page || page.isClosed()) return;
  for (const sel of SWITCHER_AVATAR_IMAGE_SELECTORS) {
    try {
      const loc = page.locator(sel).first();
      if (await loc.isVisible({ timeout: 1500 }).catch(() => false)) {
        await loc.click({ force: true });
        break;
      }
    } catch {}
  }
  // Chờ trang profile ổn định: có tên header + URL không phải feed.
  const start = Date.now();
  while (Date.now() - start < 8000) {
    await page.waitForTimeout(400);
    const details = await captureCanonicalPageDetails(page);
    let pathname = '';
    try { pathname = new URL(page.url()).pathname; } catch {}
    if (details.name && details.name.trim().length > 0 && !isFacebookSystemPath(pathname)) {
      return;
    }
  }
}

/** Chứng minh identity thực sự đã đổi (thay waitForSwitchConfirmation luôn-true). */
export async function proveIdentitySwitch(
  page: Page,
  expected: { name: string; urlBefore: string },
  timeoutMs = 8000
): Promise<boolean> {
  if (!page || page.isClosed()) return false;
  const expectedName = cleanPageName(expected.name).toLowerCase();
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await page.waitForTimeout(400);
    const url = page.url();
    let pathname = '';
    try { pathname = new URL(url).pathname; } catch {}
    const urlChanged = url !== expected.urlBefore && !isFacebookSystemPath(pathname);

    const details = await captureCanonicalPageDetails(page);
    const headerName = cleanPageName(details.name || '').toLowerCase();
    const nameMatch =
      !!headerName &&
      !!expectedName &&
      (headerName.includes(expectedName) || expectedName.includes(headerName));

    if (urlChanged && (nameMatch || !expectedName)) return true;
    if (urlChanged && headerName) return true;
  }
  return false;
}

/**
 * Mở lại switcher rồi click dòng tài khoản cá nhân (identity gốc) để chắc chắn context
 * đúng trước khi phân loại — theo đúng lưu ý re-selection của người dùng.
 */
export async function reopenSwitcherAndClickPersonalEntry(page: Page, originalName: string): Promise<void> {
  if (!page || page.isClosed() || !originalName) return;
  const opened = await openSwitcherDialog(page);
  if (!opened) return;
  const rows = await readAndTagSwitcherRows(page);
  const target = rows.find(r => {
    const clean = cleanPageName(r.raw).toLowerCase();
    return r.isSelected || clean === originalName.toLowerCase();
  });
  if (target) {
    await clickTaggedRow(page, target.index);
    await openSelectedIdentityProfile(page);
  }
}

/** Click nút "See more profiles" trong switcher; trả về true nếu danh sách dài thêm. */
export async function clickSeeMoreProfiles(page: Page): Promise<boolean> {
  if (!page || page.isClosed()) return false;
  const before = await readAndTagSwitcherRows(page);
  const beforeKeys = before.map(r => `${r.index}:${r.raw}`);
  let clicked = false;
  for (const sel of SEE_MORE_PROFILES_SELECTORS) {
    try {
      const loc = page.locator(sel).first();
      if (await loc.isVisible({ timeout: 1000 }).catch(() => false)) {
        await loc.scrollIntoViewIfNeeded({ timeout: 1500 }).catch(() => {});
        await loc.click({ force: true });
        clicked = true;
        break;
      }
    } catch {}
  }
  if (!clicked) return false;
  await page.waitForTimeout(1200);
  const after = await readAndTagSwitcherRows(page);
  const afterKeys = after.map(r => `${r.index}:${r.raw}`);
  return shouldIncrementSeeMoreProgress(true, beforeKeys, afterKeys, before.length, after.length);
}

/** Cuộn danh sách switcher; trả về {progressed, bottomReached}. */
export async function scrollSwitcher(page: Page): Promise<{ progressed: boolean; bottomReached: boolean }> {
  if (!page || page.isClosed()) return { progressed: false, bottomReached: true };
  const res: any = await page.evaluate(() => {
    const doc: any = (globalThis as any).document;
    if (!doc || !doc.querySelectorAll) return null;
    const dialogs: any[] = Array.from(doc.querySelectorAll('div[role="dialog"], div[role="aria-modal"], [role="menu"]'));
    const switcher: any = dialogs.find((d: any) => {
      const t = ((d && (d.innerText || d.textContent)) || '').toLowerCase();
      return (
        t.includes('your profiles & pages') ||
        t.includes('trang cá nhân & trang') ||
        t.includes('trang cá nhân và trang') ||
        t.includes('profiles & pages') ||
        t.includes('trang & trang cá nhân') ||
        t.includes('trang và trang cá nhân') ||
        t.includes('pages & profiles')
      );
    });
    if (!switcher) return null;

    // Tìm descendant có thể cuộn.
    let scrollable: any = null;
    const candidates: any[] = [switcher, ...Array.from(switcher.querySelectorAll('*'))];
    for (const el of candidates) {
      if (el && el.scrollHeight > el.clientHeight + 20) { scrollable = el; break; }
    }
    if (!scrollable) return null;

    const before = scrollable.scrollTop;
    const maxScrollTop = scrollable.scrollHeight - scrollable.clientHeight;
    scrollable.scrollTop = Math.min(before + 400, maxScrollTop);
    return { before, after: scrollable.scrollTop, maxScrollTop };
  }).catch(() => null);

  if (!res) return { progressed: false, bottomReached: true };
  await page.waitForTimeout(600);
  return {
    progressed: isScrollProgressMade(res.before, res.after),
    bottomReached: isBottomReached(res.after, res.maxScrollTop),
  };
}

// ==========================================
// Vấn đề 1 & 2: dismiss welcome dialog + "Xem thêm trang"
// ==========================================

/**
 * Vấn đề 1: khi vào 1 Page đôi khi hiện thông báo "Chào mừng bạn đến với Trang mới!".
 * Bấm nút "Dùng Trang" (đa ngôn ngữ) để tắt. Trả về true nếu đã bấm.
 */
export async function dismissWelcomeToNewPage(page: Page): Promise<boolean> {
  if (!page || page.isClosed()) return false;
  try {
    const clicked = await page.evaluate(({ welcomeTokens, useTokens }) => {
      const doc: any = (globalThis as any).document;
      if (!doc || !doc.querySelectorAll) return false;

      const bodyText = ((doc.body && (doc.body.innerText || doc.body.textContent)) || '').toLowerCase();
      const hasWelcome = welcomeTokens.some((t: string) => bodyText.includes(t));
      if (!hasWelcome) return false;

      const buttons: any[] = Array.from(
        doc.querySelectorAll('[role="button"], button, [role="menuitem"]')
      );
      for (const btn of buttons) {
        const txt = ((btn.innerText || btn.textContent) || '').trim().toLowerCase();
        const aria = (btn.getAttribute ? (btn.getAttribute('aria-label') || '') : '').trim().toLowerCase();
        if (useTokens.some((t: string) => txt.includes(t) || aria.includes(t))) {
          const rect = btn.getBoundingClientRect ? btn.getBoundingClientRect() : { width: 1, height: 1 };
          if (rect.width > 0 && rect.height > 0) {
            btn.click();
            return true;
          }
        }
      }
      return false;
    }, { welcomeTokens: WELCOME_NEW_PAGE_TOKENS, useTokens: USE_PAGE_BUTTON_TOKENS }).catch(() => false);

    if (clicked) await page.waitForTimeout(800);
    return clicked;
  } catch {
    return false;
  }
}

/** Vấn đề 2b: click nút "Xem thêm trang"/"See more pages"; trả về true nếu danh sách dài thêm. */
export async function clickSeeMorePages(page: Page): Promise<boolean> {
  if (!page || page.isClosed()) return false;
  const before = await readAndTagSwitcherRows(page);
  const beforeKeys = before.map(r => `${r.index}:${r.raw}`);
  let clicked = false;
  for (const sel of SEE_MORE_PAGES_SELECTORS) {
    try {
      const loc = page.locator(sel).first();
      if (await loc.isVisible({ timeout: 1000 }).catch(() => false)) {
        await loc.scrollIntoViewIfNeeded({ timeout: 1500 }).catch(() => {});
        await loc.click({ force: true });
        clicked = true;
        break;
      }
    } catch {}
  }
  if (!clicked) return false;
  await page.waitForTimeout(1200);
  const after = await readAndTagSwitcherRows(page);
  const afterKeys = after.map(r => `${r.index}:${r.raw}`);
  return shouldIncrementSeeMoreProgress(true, beforeKeys, afterKeys, before.length, after.length);
}

// ==========================================
// Mandatory 7-step Automation Collection Flow
// Order: trusted click identity -> wait/prove switch -> reacquire/navigate profile -> wait resulting profile -> Show/Hide classify -> Page capture -> reopen switcher
// ==========================================

export async function collectFacebookPages(options: PageInventoryOptions): Promise<{
  success: boolean;
  pages: PageInventoryItem[];
  totalProcessed: number;
  error?: string;
}> {
  const maxIterations = options.maxExpansions || 50;
  const pages: PageInventoryItem[] = [];
  const processedKeys = new Set<string>();

  if (!options.pageInstance || options.pageInstance.isClosed()) {
    return { success: false, pages: [], totalProcessed: 0, error: 'pageInstance required and must be open' };
  }

  const page = options.pageInstance;

  const opened = await openSwitcherDialog(page);
  if (!opened) {
    return { success: false, pages: [], totalProcessed: 0, error: 'Failed to open Your profiles & Pages switcher dialog' };
  }

  let originalIdentityName: string | null = null;
  let checkpoint: CheckpointInfo | null = null;
  let iterations = 0;

  try {
    // Vấn đề 2b: nạp thêm danh sách khi checkpoint chạm đáy (scroll → see-more profiles → see-more pages).
    const loadMore = async (): Promise<boolean> => {
      const scroll = await scrollSwitcher(page);
      if (scroll.progressed) return true;
      if (await clickSeeMoreProfiles(page)) return true;
      if (await clickSeeMorePages(page)) return true;
      return false;
    };

    while (iterations < maxIterations) {
      if (options.cancelSignal?.cancelled) break;

      // Đảm bảo switcher đang mở.
      if (!(await isExpandedSwitcherOpen(page))) {
        const reopened = await openSwitcherDialog(page);
        if (!reopened) break;
      }

      const rows = await readAndTagSwitcherRows(page);
      const eligible: Array<{
        itemKey: string; cleanName: string; pageId?: string; href?: string; isSelected?: boolean; rowIndex: number;
      }> = [];
      rows.forEach((r, i) => {
        const cleanName = cleanPageName(r.raw);
        if (!cleanName || isControlName(cleanName)) return;
        eligible.push({
          itemKey: generateItemKey({ cleanName, pageId: r.pageId, href: r.href }, i),
          cleanName, pageId: r.pageId, href: r.href, isSelected: r.isSelected, rowIndex: r.index,
        });
      });

      if (originalIdentityName === null && eligible.length > 0) {
        const derived = deriveOriginalPersonalIdentity(eligible.map(e => ({
          cleanName: e.cleanName, isSelected: e.isSelected,
        })));
        if (derived.valid) originalIdentityName = derived.name;
      }

      // Xác định candidate = row NGAY DƯỚI checkpoint (chưa xử lý).
      let startIndex = 1; // bỏ qua tài khoản cá nhân ghim đầu
      if (checkpoint) {
        const match = evaluateCheckpointMatch(eligible, checkpoint);
        if (match.ambiguous) {
          throw new Error('Checkpoint trùng tên nhiều dòng (ambiguous) — dừng để tránh xử lý sai.');
        }
        if (match.index >= 0) {
          startIndex = match.index + 1;
        } else {
          // Checkpoint không còn thấy → nạp thêm; hết thì kết thúc.
          if (await loadMore()) continue;
          break;
        }
      }

      const next = findNextUnprocessedItem(eligible, processedKeys, startIndex);
      if (!next) {
        // Không còn dòng chưa xử lý dưới checkpoint → nạp thêm; hết thì kết thúc.
        if (await loadMore()) continue;
        break;
      }

      const candidate = next.item;
      processedKeys.add(candidate.itemKey);
      const urlBefore = page.url();

      const clickedRow = await clickTaggedRow(page, candidate.rowIndex);
      if (!clickedRow) {
        checkpoint = { key: candidate.itemKey, name: candidate.cleanName, url: null };
        iterations++;
        continue;
      }

      // Thực sự điều hướng vào trang identity vừa chọn.
      await openSelectedIdentityProfile(page);
      // Vấn đề 1: tắt thông báo "Chào mừng bạn đến với Trang mới!" nếu có.
      await dismissWelcomeToNewPage(page);

      const switched = await proveIdentitySwitch(page, { name: candidate.cleanName, urlBefore });
      if (!switched) {
        options.onProgress?.(`Bỏ qua "${candidate.cleanName}": không xác nhận được chuyển identity.`, pages.length, eligible.length);
        checkpoint = { key: candidate.itemKey, name: candidate.cleanName, url: page.url() };
        iterations++;
        continue;
      }

      // Phân loại: có nút Show/Hide menu (header) → PAGE; không có → tài khoản cá nhân.
      const isPage = await isPageHeaderMenuPresent(page);
      if (isPage) {
        const details = await captureCanonicalPageDetails(page);
        const normalizedUrl = details.url ? normalizeFacebookUrl(details.url) : normalizeFacebookUrl(page.url());
        const pageName = cleanPageName(details.name || candidate.cleanName);
        pages.push({
          pageName,
          pageUrl: normalizedUrl,
          pageId: details.id || candidate.pageId,
          evidenceSource: 'dom',
          verified: true,
          profileType: 'page',
        });
        options.onProgress?.(`Đã lấy Page: ${pageName}`, pages.length, eligible.length);
      } else {
        options.onProgress?.(`Bỏ qua tài khoản cá nhân: ${candidate.cleanName}`, pages.length, eligible.length);
      }

      // Luôn cập nhật checkpoint = row vừa xử lý (cơ chế "row dưới checkpoint").
      checkpoint = { key: candidate.itemKey, name: candidate.cleanName, url: page.url() };
      iterations++;
    }

    if (originalIdentityName) {
      await restoreOriginalIdentity(page, originalIdentityName);
    }

    return { success: true, pages, totalProcessed: processedKeys.size };
  } catch (err: any) {
    if (originalIdentityName) {
      try { await restoreOriginalIdentity(page, originalIdentityName); } catch {}
    }
    return { success: false, pages, totalProcessed: processedKeys.size, error: err.message || String(err) };
  }
}

async function restoreOriginalIdentity(page: Page, originalName: string): Promise<void> {
  try {
    const dialogOpen = await openSwitcherDialog(page);
    if (!dialogOpen) return;

    const ptgLoc = page
      .locator('div[role="dialog"], div[role="aria-modal"], [role="menu"]')
      .locator('[role="button"], [role="radio"]')
      .filter({ hasText: originalName })
      .first();

    if (await ptgLoc.isVisible({ timeout: 2000 }).catch(() => false)) {
      await ptgLoc.click({ force: true });
      await page.waitForTimeout(2500);
    }
  } catch {}
}

// ==========================================
// Service Class for Job Management
// ==========================================

const jobs = new Map<string, PageInventoryJob>();

export class FacebookPageInventoryService {
  public startScanJob(profileId: string, options: PageInventoryOptions = {}): PageInventoryJob {
    const validated = validatePageInventoryScanInput({
      profileId,
      ...options,
    });

    if (!validated.valid || !validated.data) {
      const err: any = new Error(validated.error || 'Dữ liệu đầu vào không hợp lệ.');
      err.statusCode = 400;
      throw err;
    }

    const { profileId: cleanId, maxExpansions, timeoutMs, keepBrowserOpen, showUnresolved } = validated.data;

    for (const j of jobs.values()) {
      if (j.profileId === cleanId && j.status === 'running') {
        const err: any = new Error(`Profile ${cleanId} đang có một tiến trình quét Page chạy dở.`);
        err.statusCode = 409;
        throw err;
      }
    }

    const runningJobsCount = Array.from(jobs.values()).filter(j => j.status === 'running').length;
    if (runningJobsCount >= 3) {
      const err: any = new Error('Hệ thống đạt giới hạn số luồng quét Page song song (tối đa 3). Vui lòng đợi tiến trình trước hoàn thành.');
      err.statusCode = 409;
      throw err;
    }

    const jobId = `job_page_inv_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const job: PageInventoryJob = {
      jobId,
      profileId: cleanId,
      status: 'running',
      progress: {
        percent: 5,
        stage: 'OPEN_SWITCHER — Khởi tạo',
        phase: 'OPEN_SWITCHER',
        detail: 'Đang khởi tạo tiến trình quét...',
        expansionsCount: 0,
        seeMoreClicks: 0,
        checkpoint: null,
        processedCount: 0,
        discoveredCount: 0,
        verifiedCount: 0,
      },
      options: {
        maxExpansions,
        timeoutMs,
        keepBrowserOpen,
        showUnresolved,
      },
      startedAt: new Date().toISOString(),
    };

    jobs.set(jobId, job);
    cleanupTerminalJobs(jobs, 50);

    this.runScanTask(job).catch(err => {
      logger.error(`[Page Inventory Job ${jobId}] Failed with error: ${err.message}`);
    });

    return job;
  }

  public getJob(jobId: string): PageInventoryJob | null {
    return jobs.get(jobId) || null;
  }

  public cancelJob(jobId: string): boolean {
    const job = jobs.get(jobId);
    if (!job) return false;
    if (job.status === 'running') {
      job.cancelled = true;
      job.status = 'cancelled';
      job.progress.phase = 'FAILED';
      job.progress.stage = 'FAILED — Đã hủy';
      job.progress.detail = 'Tiến trình đã bị người dùng hủy.';
      job.finishedAt = new Date().toISOString();
      return true;
    }
    return true;
  }

  public getJobsMap(): Map<string, PageInventoryJob> {
    return jobs;
  }

  private async runScanTask(job: PageInventoryJob): Promise<void> {
    const { profileId, options } = job;
    let wasAlreadyActive = false;
    let page: Page | null = null;

    try {
      wasAlreadyActive = await adsPowerClient.isBrowserActive(profileId).catch(() => false);
      const connData = await adsPowerClient.startBrowser({ profileId });
      if (!connData?.ws?.puppeteer) {
        throw new Error('Không thể khởi động trình duyệt AdsPower hoặc thiếu WebSocket DevTools endpoint.');
      }

      page = await cdpManager.connect(profileId, connData.ws.puppeteer);
      if (!page || page.isClosed()) {
        throw new Error('Không thể mở tab trình duyệt Playwright.');
      }

      const existingPages = page.context().pages();
      const validWorkPages = existingPages.filter(p => !p.isClosed() && isWorkTabUrl(p.url()));

      if (validWorkPages.length === 0) {
        const allTabInfo = existingPages.map(p => `"${p.title() || 'Untitled'}" [${p.url()}]`).join(', ');
        throw new Error(`Không tìm thấy tab Facebook làm việc hợp lệ. Các tab hiện có: ${allTabInfo}`);
      }

      page = validWorkPages[0];

      const isLoggedIn = await facebookLoginAutomation.isRealLoggedIn(page, profileId);
      if (!isLoggedIn) {
        throw new Error('Profile chưa đăng nhập Facebook hoặc vướng checkpoint/màn hình đăng nhập.');
      }

      const res = await collectFacebookPages({
        pageInstance: page,
        maxExpansions: options.maxExpansions,
        timeoutMs: options.timeoutMs,
        keepBrowserOpen: options.keepBrowserOpen,
        showUnresolved: options.showUnresolved,
        onProgress: (msg, current, total) => {
          job.progress.detail = msg;
          job.progress.verifiedCount = current;
          job.progress.processedCount = total;
          job.progress.percent = Math.min(95, 35 + total * 5);
        },
      });

      if (res.success) {
        job.status = 'completed';
        job.progress.percent = 100;
        job.progress.phase = 'COMPLETE';
        job.result = {
          verifiedPages: res.pages,
          unresolvedItems: [],
          totalScanned: res.totalProcessed,
          discoveredPageCount: res.pages.length,
          verifiedPageCount: res.pages.length,
          unresolvedPageCount: 0,
          missingPageNames: [],
        };
      } else {
        job.status = 'failed';
        job.error = res.error;
      }
      job.finishedAt = new Date().toISOString();

    } catch (err: any) {
      job.status = 'failed';
      job.error = err.message || 'Lỗi không xác định trong quá trình quét Page inventory.';
      job.finishedAt = new Date().toISOString();
    } finally {
      if (page && !page.isClosed() && !options.keepBrowserOpen && !wasAlreadyActive) {
        try {
          await cdpManager.disconnect(profileId).catch(() => {});
          await adsPowerClient.stopBrowser({ profileId }).catch(() => {});
        } catch {}
      }
    }
  }
}

export const facebookPageInventoryService = new FacebookPageInventoryService();
