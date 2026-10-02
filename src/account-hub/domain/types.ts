/**
 * Account Hub — Domain types
 *
 * Pure value types / enums. No DB imports here.
 */

// ---------------------------------------------------------------------------
// Status enums (from spec §6)
// ---------------------------------------------------------------------------

export type AccountStatus =
  | 'LIVE'
  | 'DIE'
  | 'CHECKING'
  | 'LOCKED'
  | 'NEED_LOGIN'
  | 'ERROR'
  | 'CUSTOM';

export type AdspowerStatus =
  | 'NOT_IMPORTED'
  | 'IMPORT_PENDING'
  | 'IMPORTING'
  | 'LOGIN_PENDING'
  | 'LOGIN_RUNNING'
  | 'ACTIVE'
  | 'DELETE_PENDING'
  | 'DELETED'
  | 'MISSING'
  | 'SYNC_ERROR';

/** Result of matching a BC channel against the Reup source (spec §4). */
export type ChannelMatchStatus = 'PENDING' | 'AMBIGUOUS' | 'MATCHED';

export type NotificationType =
  | 'DIE_ADSPOWER_STILL_EXISTS'
  | 'DUPLICATE_PROFILE'
  | 'DUPLICATE_ID'
  | 'DUPLICATE_HOTMAIL'
  | 'DUPLICATE_CHANNEL'
  /** Missing/faulty proxy — the only hard block in the warehouse (spec §5). */
  | 'PROXY_BLOCKED'
  /** Inbound Sheets poll could not read a tab (creds/quota/permission) — spec §7.2. */
  | 'SHEET_POLL_FAILED';
export type NotificationStatus = 'OPEN' | 'RESOLVED' | 'DISMISSED';

/** How a sheet source encodes the DIE state via cell background colour (spec §0.3, §4). */
export type DieReadMode = 'none' | 'full_row' | 'cell_range';

// ---------------------------------------------------------------------------
// Core domain models
// ---------------------------------------------------------------------------

export interface Account {
  id: string;
  profileName: string;
  normalizedProfileName: string;
  adspowerUserId?: string | null;
  adspowerSerialNumber?: string | null;
  adspowerGroupId?: string | null;
  linkedContent?: string | null;
  loginId?: string | null;
  /** Never returned in API responses — redacted */
  passwordEnc?: string | null;
  twoFactorSecretEnc?: string | null;
  hotmail?: string | null;
  hotmailPasswordEnc?: string | null;
  recoveryMail?: string | null;
  cookieEnc?: string | null;
  tokenEnc?: string | null;
  youtubeChannelUrl?: string | null;
  accountStatus: AccountStatus;
  adspowerStatus: AdspowerStatus;
  assignedTo?: string | null;
  lastSeenAdspowerAt?: string | null;
  dieMarkedAt?: string | null;
  deletedFromAdspowerAt?: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  createdBy?: string | null;
  updatedBy?: string | null;
  archivedAt?: string | null;
  lockedBy?: string | null;
  lockedAt?: string | null;
  channelMatchStatus?: ChannelMatchStatus | null;
  duplicateProfile: boolean;
  duplicateId: boolean;
  duplicateHotmail: boolean;
  /** JSON snapshot of original Sheet cell colors before DIE write-back (spec §4). */
  colorBackupJson?: string | null;
  /** Reup channel URL matched for a BC row (spec §4). */
  channelLink?: string | null;
}

/** Safe public projection — secrets redacted */
export interface AccountPublic
  extends Omit<
    Account,
    | 'passwordEnc'
    | 'twoFactorSecretEnc'
    | 'hotmailPasswordEnc'
    | 'cookieEnc'
    | 'tokenEnc'
  > {
  hasPassword: boolean;
  hasTwoFactor: boolean;
  hasCookie: boolean;
  hasToken: boolean;
}

export interface CreateAccountDto {
  profileName: string;
  adspowerUserId?: string;
  adspowerSerialNumber?: string;
  adspowerGroupId?: string;
  linkedContent?: string;
  loginId?: string;
  password?: string;
  twoFactorSecret?: string;
  hotmail?: string;
  hotmailPassword?: string;
  recoveryMail?: string;
  cookie?: string;
  token?: string;
  youtubeChannelUrl?: string;
  channelLink?: string;
  accountStatus?: AccountStatus;
  assignedTo?: string;
  createdBy?: string;
}

export interface UpdateAccountDto extends Partial<CreateAccountDto> {
  accountStatus?: AccountStatus;
  adspowerStatus?: AdspowerStatus;
  updatedBy?: string;
  lockedBy?: string | null;
  lockedAt?: string | null;
  channelMatchStatus?: ChannelMatchStatus | null;
  duplicateProfile?: boolean;
  duplicateId?: boolean;
  duplicateHotmail?: boolean;
  colorBackupJson?: string | null;
  /** Must match current version for optimistic locking */
  version: number;
}

// ---------------------------------------------------------------------------
// Custom fields
// ---------------------------------------------------------------------------

export interface CustomFieldDefinition {
  id: string;
  technicalName: string;
  displayName: string;
  dataType: 'text' | 'number' | 'boolean' | 'date' | 'url';
  isSensitive: boolean;
  isCopyable: boolean;
  isSearchable: boolean;
  isFilterable: boolean;
  isListVisible: boolean;
  validationJson?: string | null;
  displayOrder: number;
  createdAt: string;
}

export interface CustomFieldValue {
  id: string;
  accountId: string;
  fieldDefinitionId: string;
  valueText?: string | null;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Sync jobs
// ---------------------------------------------------------------------------

export type SyncJobStatus = 'pending' | 'running' | 'partial' | 'done' | 'failed' | 'cancelled';
export type SyncJobType = 'sheet_outbound' | 'sheet_inbound' | 'adspower_reconcile' | 'bulk_import' | 'bulk_login' | 'die_writeback';

export interface SyncJob {
  id: string;
  jobType: SyncJobType;
  status: SyncJobStatus;
  totalItems: number;
  doneItems: number;
  failedItems: number;
  errorMessage?: string | null;
  dryRun: boolean;
  idempotencyKey?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  createdAt: string;
  createdBy?: string | null;
}

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

export interface AuditLog {
  id: string;
  actor?: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  /** Sensitive fields are always redacted before storage */
  beforeJson?: string | null;
  afterJson?: string | null;
  source?: string | null;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Conflict
// ---------------------------------------------------------------------------

export type ConflictStatus = 'pending' | 'resolved' | 'ignored';

export interface Conflict {
  id: string;
  accountId?: string | null;
  sourceId?: string | null;
  fieldName: string;
  dbValue?: string | null;
  sheetValue?: string | null;
  rowIndex?: number | null;
  status: ConflictStatus;
  resolvedBy?: string | null;
  resolvedAt?: string | null;
  resolution?: string | null;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Notification
// ---------------------------------------------------------------------------

export interface Notification {
  id: string;
  type: NotificationType;
  status: NotificationStatus;
  accountId?: string | null;
  adspowerUserId?: string | null;
  title: string;
  detail?: string | null;
  dedupeKey?: string | null;
  createdAt: string;
  resolvedAt?: string | null;
  resolvedBy?: string | null;
}

// ---------------------------------------------------------------------------
// Pagination helpers
// ---------------------------------------------------------------------------

export interface PaginationParams {
  page?: number;
  limit?: number;
  search?: string;
  accountStatus?: AccountStatus;
  adspowerStatus?: AdspowerStatus;
  sortBy?: string;
  sortDir?: 'asc' | 'desc';
}

export interface PaginatedResult<T> {
  items: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}
