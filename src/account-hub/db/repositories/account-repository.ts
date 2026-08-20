/**
 * Account Hub — Account Repository
 *
 * All DB access for the `accounts` table.
 * Optimistic locking via `version` column.
 * Secrets are stored encrypted (enc suffix); this layer just passes through
 * the encrypted bytes — encryption is handled in the service layer.
 */

import type Database from 'better-sqlite3';
import type {
  Account,
  AccountPublic,
  CreateAccountDto,
  UpdateAccountDto,
  PaginationParams,
  PaginatedResult,
  AccountStatus,
  AdspowerStatus,
} from '../../domain/types.js';
import { normalizeName, generateId } from '../../domain/utils.js';

// ---------------------------------------------------------------------------
// Row → domain mappers
// ---------------------------------------------------------------------------

function rowToAccount(row: Record<string, unknown>): Account {
  return {
    id:                       row.id as string,
    profileName:              row.profile_name as string,
    normalizedProfileName:    row.normalized_profile_name as string,
    adspowerUserId:           row.adspower_user_id as string | null,
    adspowerSerialNumber:     row.adspower_serial_number as string | null,
    adspowerGroupId:          row.adspower_group_id as string | null,
    linkedContent:            row.linked_content as string | null,
    loginId:                  row.login_id as string | null,
    passwordEnc:              row.password_enc as string | null,
    twoFactorSecretEnc:       row.two_factor_secret_enc as string | null,
    hotmail:                  row.hotmail as string | null,
    hotmailPasswordEnc:       row.hotmail_password_enc as string | null,
    recoveryMail:             row.recovery_mail as string | null,
    cookieEnc:                row.cookie_enc as string | null,
    tokenEnc:                 row.token_enc as string | null,
    youtubeChannelUrl:        row.youtube_channel_url as string | null,
    accountStatus:            row.account_status as AccountStatus,
    adspowerStatus:           row.adspower_status as AdspowerStatus,
    assignedTo:               row.assigned_to as string | null,
    lastSeenAdspowerAt:       row.last_seen_adspower_at as string | null,
    dieMarkedAt:              row.die_marked_at as string | null,
    deletedFromAdspowerAt:    row.deleted_from_adspower_at as string | null,
    version:                  row.version as number,
    createdAt:                row.created_at as string,
    updatedAt:                row.updated_at as string,
    createdBy:                row.created_by as string | null,
    updatedBy:                row.updated_by as string | null,
    archivedAt:               row.archived_at as string | null,
  };
}

export function toPublic(account: Account): AccountPublic {
  const {
    passwordEnc, twoFactorSecretEnc, hotmailPasswordEnc, cookieEnc, tokenEnc,
    ...rest
  } = account;
  return {
    ...rest,
    hasPassword:   Boolean(passwordEnc),
    hasTwoFactor:  Boolean(twoFactorSecretEnc),
    hasCookie:     Boolean(cookieEnc),
    hasToken:      Boolean(tokenEnc),
  };
}

// ---------------------------------------------------------------------------
// Repository class
// ---------------------------------------------------------------------------

export class AccountRepository {
  constructor(private db: Database.Database) {}

  // ---- CREATE ----

  create(dto: CreateAccountDto): Account {
    const id = generateId();
    const now = new Date().toISOString();
    const normalized = normalizeName(dto.profileName);

    this.db.prepare(`
      INSERT INTO accounts (
        id, profile_name, normalized_profile_name,
        adspower_user_id, adspower_group_id, linked_content,
        login_id, password_enc, two_factor_secret_enc,
        hotmail, hotmail_password_enc, recovery_mail,
        cookie_enc, token_enc, youtube_channel_url,
        account_status, adspower_status, assigned_to,
        created_at, updated_at, created_by, updated_by, version
      ) VALUES (
        @id, @profileName, @normalizedProfileName,
        @adspowerUserId, @adspowerGroupId, @linkedContent,
        @loginId, @passwordEnc, @twoFactorSecretEnc,
        @hotmail, @hotmailPasswordEnc, @recoveryMail,
        @cookieEnc, @tokenEnc, @youtubeChannelUrl,
        @accountStatus, 'NOT_IMPORTED', @assignedTo,
        @now, @now, @createdBy, @createdBy, 1
      )
    `).run({
      id,
      profileName:            dto.profileName,
      normalizedProfileName:  normalized,
      adspowerUserId:         dto.adspowerUserId ?? null,
      adspowerGroupId:        dto.adspowerGroupId ?? null,
      linkedContent:          dto.linkedContent ?? null,
      loginId:                dto.loginId ?? null,
      passwordEnc:            dto.password ?? null,       // encryption done in service
      twoFactorSecretEnc:     dto.twoFactorSecret ?? null,
      hotmail:                dto.hotmail ?? null,
      hotmailPasswordEnc:     dto.hotmailPassword ?? null,
      recoveryMail:           dto.recoveryMail ?? null,
      cookieEnc:              dto.cookie ?? null,
      tokenEnc:               dto.token ?? null,
      youtubeChannelUrl:      dto.youtubeChannelUrl ?? null,
      accountStatus:          dto.accountStatus ?? 'LIVE',
      assignedTo:             dto.assignedTo ?? null,
      createdBy:              dto.createdBy ?? null,
      now,
    });

    return this.findById(id)!;
  }

  // ---- READ ----

  findById(id: string): Account | null {
    const row = this.db.prepare('SELECT * FROM accounts WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? rowToAccount(row) : null;
  }

  findByAdspowerUserId(adspowerUserId: string): Account | null {
    const row = this.db
      .prepare('SELECT * FROM accounts WHERE adspower_user_id = ?')
      .get(adspowerUserId) as Record<string, unknown> | undefined;
    return row ? rowToAccount(row) : null;
  }

  findByNormalizedName(normalized: string): Account[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM accounts WHERE normalized_profile_name = ? AND archived_at IS NULL',
      )
      .all(normalized) as Record<string, unknown>[];
    return rows.map(rowToAccount);
  }

  list(params: PaginationParams = {}): PaginatedResult<AccountPublic> {
    const page  = Math.max(1, params.page  ?? 1);
    const limit = Math.min(200, Math.max(1, params.limit ?? 50));
    const offset = (page - 1) * limit;

    const conditions: string[] = ['archived_at IS NULL'];
    const bindings: Record<string, unknown> = { limit, offset };

    if (params.search) {
      conditions.push(
        `(profile_name LIKE @search OR login_id LIKE @search OR hotmail LIKE @search
         OR youtube_channel_url LIKE @search OR adspower_user_id LIKE @search)`,
      );
      bindings.search = `%${params.search}%`;
    }
    if (params.accountStatus) {
      conditions.push('account_status = @accountStatus');
      bindings.accountStatus = params.accountStatus;
    }
    if (params.adspowerStatus) {
      conditions.push('adspower_status = @adspowerStatus');
      bindings.adspowerStatus = params.adspowerStatus;
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const allowedSort = new Set([
      'profile_name', 'account_status', 'adspower_status',
      'created_at', 'updated_at', 'die_marked_at',
    ]);
    const sortBy  = allowedSort.has(params.sortBy ?? '') ? params.sortBy! : 'created_at';
    const sortDir = params.sortDir === 'asc' ? 'ASC' : 'DESC';

    const total = (
      this.db.prepare(`SELECT COUNT(*) as cnt FROM accounts ${where}`).get(bindings) as
        { cnt: number }
    ).cnt;

    const rows = this.db
      .prepare(
        `SELECT * FROM accounts ${where} ORDER BY ${sortBy} ${sortDir} LIMIT @limit OFFSET @offset`,
      )
      .all(bindings) as Record<string, unknown>[];

    return {
      items:      rows.map((r) => toPublic(rowToAccount(r))),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  // ---- UPDATE (optimistic locking) ----

  update(id: string, dto: UpdateAccountDto): Account {
    const existing = this.findById(id);
    if (!existing) throw new Error(`Account ${id} not found`);
    if (existing.version !== dto.version) {
      throw new Error(
        `Optimistic lock conflict on account ${id}. ` +
        `Expected version ${dto.version}, found ${existing.version}.`,
      );
    }

    const now = new Date().toISOString();
    const newVersion = existing.version + 1;

    const updates: string[] = [
      'updated_at = @now',
      'version = @newVersion',
      'updated_by = @updatedBy',
    ];
    const params: Record<string, unknown> = {
      id, now, newVersion,
      updatedBy: dto.updatedBy ?? null,
    };

    const fieldMap: Record<string, string> = {
      profileName:       'profile_name',
      adspowerUserId:    'adspower_user_id',
      adspowerGroupId:   'adspower_group_id',
      linkedContent:     'linked_content',
      loginId:           'login_id',
      password:          'password_enc',
      twoFactorSecret:   'two_factor_secret_enc',
      hotmail:           'hotmail',
      hotmailPassword:   'hotmail_password_enc',
      recoveryMail:      'recovery_mail',
      cookie:            'cookie_enc',
      token:             'token_enc',
      youtubeChannelUrl: 'youtube_channel_url',
      accountStatus:     'account_status',
      adspowerStatus:    'adspower_status',
      assignedTo:        'assigned_to',
    };

    const dtoAny = dto as unknown as Record<string, unknown>;
    for (const [dtoKey, col] of Object.entries(fieldMap)) {
      const dtoValue = dtoAny[dtoKey];
      if (dtoValue !== undefined) {
        updates.push(`${col} = @${dtoKey}`);
        params[dtoKey] = dtoValue;
        // Keep normalized name in sync
        if (dtoKey === 'profileName') {
          updates.push('normalized_profile_name = @normalized');
          params.normalized = normalizeName(dtoValue as string);
        }
        // Mark die timestamp
        if (dtoKey === 'accountStatus' && dtoValue === 'DIE' && !existing.dieMarkedAt) {
          updates.push('die_marked_at = @now');
        }
      }
    }

    this.db
      .prepare(`UPDATE accounts SET ${updates.join(', ')} WHERE id = @id`)
      .run(params);

    return this.findById(id)!;
  }

  /** Soft delete */
  archive(id: string, by?: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE accounts
         SET archived_at = @now, updated_at = @now, updated_by = @by
         WHERE id = @id`,
      )
      .run({ id, now, by: by ?? null });
  }
}
