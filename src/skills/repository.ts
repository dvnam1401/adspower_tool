import fs from 'fs';
import path from 'path';
import { Skill, SkillStatus, SelectorItem } from '../types/index.js';
import { logger } from '../utils/logger.js';
import { config } from '../config/index.js';

export class SkillRepository {
  private filePath: string;
  private skills: Map<string, Skill> = new Map();

  constructor(filePath?: string) {
    this.filePath = filePath || path.resolve(path.dirname(config.storage.databasePath), 'skills.json');
    this.init();
  }

  private init() {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    if (fs.existsSync(this.filePath)) {
      try {
        const raw = fs.readFileSync(this.filePath, 'utf8');
        const list: Skill[] = JSON.parse(raw);
        list.forEach(skill => this.skills.set(skill.skillId, skill));
        logger.info(`Đã tải ${this.skills.size} skills từ kho lưu trữ.`);
      } catch (err: any) {
        logger.error(`Không thể đọc file skills.json: ${err.message}`);
      }
    } else {
      // Seed initial default skills
      this.seedDefaultSkills();
    }
  }

  private seedDefaultSkills() {
    const defaultSkills: Skill[] = [
      {
        skillId: 'facebook_login_button',
        site: 'facebook.com',
        actionType: 'click_login_button',
        status: 'verified',
        selectorChain: [
          { type: 'css', value: 'button[name="login"]', priority: 1 },
          { type: 'css', value: 'button[type="submit"]', priority: 2 },
          { type: 'text', value: 'Đăng nhập', priority: 3 },
          { type: 'text', value: 'Log In', priority: 4 },
          { type: 'aria-label', value: 'Accessible login button', priority: 5 }
        ],
        createdBy: 'seed',
        createdAt: new Date().toISOString(),
        lastVerifiedAt: new Date().toISOString(),
        successCount: 42,
        failCount: 0,
        version: 1,
        notes: 'Selector đăng nhập chuẩn cho Facebook Web'
      },
      {
        skillId: 'google_search_input',
        site: 'google.com',
        actionType: 'fill_search_box',
        status: 'verified',
        selectorChain: [
          { type: 'css', value: 'textarea[name="q"]', priority: 1 },
          { type: 'css', value: 'input[name="q"]', priority: 2 },
          { type: 'aria-label', value: 'Tìm kiếm', priority: 3 }
        ],
        createdBy: 'seed',
        createdAt: new Date().toISOString(),
        lastVerifiedAt: new Date().toISOString(),
        successCount: 128,
        failCount: 0,
        version: 1,
        notes: 'Ô tìm kiếm Google Search'
      },
      {
        skillId: 'twitter_post_tweet_button',
        site: 'x.com',
        actionType: 'click_tweet_button',
        status: 'testing',
        selectorChain: [
          { type: 'css', value: '[data-testid="tweetButtonInline"]', priority: 1 },
          { type: 'css', value: '[data-testid="tweetButton"]', priority: 2 },
          { type: 'text', value: 'Post', priority: 3 }
        ],
        createdBy: 'agent',
        createdAt: new Date().toISOString(),
        lastVerifiedAt: new Date().toISOString(),
        successCount: 4,
        failCount: 0,
        version: 2,
        notes: 'Nút đăng bài Twitter / X'
      }
    ];

    defaultSkills.forEach(s => this.skills.set(s.skillId, s));
    this.save();
  }

  private save() {
    try {
      const list = Array.from(this.skills.values());
      fs.writeFileSync(this.filePath, JSON.stringify(list, null, 2), 'utf8');
    } catch (err: any) {
      logger.error(`Lưu skills thất bại: ${err.message}`);
    }
  }

  public getAll(): Skill[] {
    return Array.from(this.skills.values());
  }

  public getById(skillId: string): Skill | undefined {
    return this.skills.get(skillId);
  }

  public find(site: string, actionType: string): Skill | undefined {
    return Array.from(this.skills.values()).find(
      s => s.site.toLowerCase().includes(site.toLowerCase()) && s.actionType === actionType
    );
  }

  public saveSkill(skill: Skill): Skill {
    this.skills.set(skill.skillId, skill);
    this.save();
    return skill;
  }

  public updateStatus(skillId: string, status: SkillStatus): boolean {
    const skill = this.skills.get(skillId);
    if (!skill) return false;
    skill.status = status;
    skill.lastVerifiedAt = new Date().toISOString();
    this.save();
    return true;
  }

  public recordSuccess(skillId: string): boolean {
    const skill = this.skills.get(skillId);
    if (!skill) return false;
    skill.successCount += 1;
    skill.lastVerifiedAt = new Date().toISOString();

    // Vòng đời: Sau 5 lần thành công liên tiếp ở phase testing -> promote lên verified
    if (skill.status === 'testing' && skill.successCount >= 5) {
      skill.status = 'verified';
      logger.info(`🎉 Skill [${skill.skillId}] đã được tự động thăng hạng lên VERIFIED sau 5 lần thành công!`);
    }

    this.save();
    return true;
  }

  public recordFailure(skillId: string): boolean {
    const skill = this.skills.get(skillId);
    if (!skill) return false;
    skill.failCount += 1;

    // Vòng đời: Nếu fail liên tiếp khi đang verified -> rollback về candidate để Agent sửa lại
    if (skill.status === 'verified' && skill.failCount >= 2) {
      skill.status = 'rollback';
      logger.warn(`⚠️ Skill [${skill.skillId}] bị lỗi 2 lần liên tiếp -> Đã ROLLBACK về candidate!`);
    }

    this.save();
    return true;
  }

  public delete(skillId: string): boolean {
    const deleted = this.skills.delete(skillId);
    if (deleted) this.save();
    return deleted;
  }
}

export const skillRepository = new SkillRepository();
