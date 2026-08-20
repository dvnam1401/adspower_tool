/**
 * Account Hub — Account Service
 *
 * Business logic layer — sits between API router and repository.
 * Handles audit logging, status transitions, and dependency injection.
 */

import type { AccountRepository } from '../db/repositories/account-repository.js';
import type { AuditLogRepository } from '../db/repositories/audit-log-repository.js';
import type {
  Account,
  AccountPublic,
  CreateAccountDto,
  UpdateAccountDto,
  PaginationParams,
  PaginatedResult,
} from '../domain/types.js';
import { toPublic } from '../db/repositories/account-repository.js';

export class AccountService {
  constructor(
    private accountRepo: AccountRepository,
    private auditRepo: AuditLogRepository,
  ) {}

  create(dto: CreateAccountDto): AccountPublic {
    const account = this.accountRepo.create(dto);

    this.auditRepo.append({
      actor:      dto.createdBy ?? null,
      action:     'create',
      entityType: 'account',
      entityId:   account.id,
      beforeJson: null,
      afterJson:  JSON.stringify(account),
      source:     'api',
    });

    return toPublic(account);
  }

  getById(id: string): AccountPublic | null {
    const account = this.accountRepo.findById(id);
    return account ? toPublic(account) : null;
  }

  /** Returns the raw account including encrypted fields — for internal use only. */
  getByIdInternal(id: string): Account | null {
    return this.accountRepo.findById(id);
  }

  list(params: PaginationParams): PaginatedResult<AccountPublic> {
    return this.accountRepo.list(params);
  }

  update(id: string, dto: UpdateAccountDto, actor?: string): AccountPublic {
    const before = this.accountRepo.findById(id);
    if (!before) throw new Error(`Account ${id} not found`);

    const after = this.accountRepo.update(id, { ...dto, updatedBy: actor });

    this.auditRepo.append({
      actor:      actor ?? null,
      action:     'update',
      entityType: 'account',
      entityId:   id,
      beforeJson: JSON.stringify(before),
      afterJson:  JSON.stringify(after),
      source:     'api',
    });

    return toPublic(after);
  }

  markDie(id: string, currentVersion: number, actor?: string): AccountPublic {
    return this.update(
      id,
      { accountStatus: 'DIE', version: currentVersion, updatedBy: actor },
      actor,
    );
  }

  archive(id: string, actor?: string): void {
    const before = this.accountRepo.findById(id);
    if (!before) throw new Error(`Account ${id} not found`);

    this.accountRepo.archive(id, actor);

    this.auditRepo.append({
      actor:      actor ?? null,
      action:     'archive',
      entityType: 'account',
      entityId:   id,
      beforeJson: JSON.stringify(before),
      afterJson:  null,
      source:     'api',
    });
  }
}
