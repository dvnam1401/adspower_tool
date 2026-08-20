import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { logger } from '../utils/logger.js';

export interface UserAccount {
  userId: string;
  username: string;
  passwordHash: string;
  salt: string;
  role: 'admin' | 'user';
  createdAt: string;
  lastLoginAt?: string;
}

export interface UserSession {
  token: string;
  userId: string;
  username: string;
  createdAt: number;
  expiresAt: number;
}

const dbDir = path.resolve(process.env.DATABASE_PATH ? path.dirname(process.env.DATABASE_PATH) : './data');
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const usersFile = path.resolve(dbDir, 'users.json');

class AuthRepository {
  private users: Map<string, UserAccount> = new Map();
  private sessions: Map<string, UserSession> = new Map();

  constructor() {
    this.loadUsers();
    this.initDefaultAdmin();
  }

  private loadUsers() {
    if (fs.existsSync(usersFile)) {
      try {
        const raw = fs.readFileSync(usersFile, 'utf8');
        const list: UserAccount[] = JSON.parse(raw);
        list.forEach(u => this.users.set(u.username.toLowerCase(), u));
      } catch (err: any) {
        logger.error(`[Auth] Lỗi đọc file users.json: ${err.message}`);
      }
    }
  }

  private saveUsers() {
    try {
      const list = Array.from(this.users.values());
      fs.writeFileSync(usersFile, JSON.stringify(list, null, 2), 'utf8');
    } catch (err: any) {
      logger.error(`[Auth] Lỗi ghi file users.json: ${err.message}`);
    }
  }

  private hashPassword(password: string, salt: string): string {
    return crypto.pbkdf2Sync(password, salt, 10000, 64, 'sha512').toString('hex');
  }

  private initDefaultAdmin() {
    if (this.users.size === 0) {
      const salt = crypto.randomBytes(16).toString('hex');
      const defaultAdmin: UserAccount = {
        userId: 'user_admin_001',
        username: 'admin',
        passwordHash: this.hashPassword('admin123', salt),
        salt,
        role: 'admin',
        createdAt: new Date().toISOString(),
      };
      this.users.set('admin', defaultAdmin);
      this.saveUsers();
      logger.info('🔐 [Auth] Khởi tạo tài khoản quản trị mặc định: Username: admin | Password: admin123');
    }
  }

  public authenticate(username: string, password: string): { user?: UserAccount; token?: string; error?: string } {
    const user = this.users.get(username.trim().toLowerCase());
    if (!user) {
      return { error: 'Tên đăng nhập hoặc mật khẩu không chính xác' };
    }

    const testHash = this.hashPassword(password, user.salt);
    if (testHash !== user.passwordHash) {
      return { error: 'Tên đăng nhập hoặc mật khẩu không chính xác' };
    }

    // Generate Session Token
    const token = crypto.randomBytes(32).toString('hex');
    const now = Date.now();
    const expiresAt = now + 7 * 24 * 60 * 60 * 1000; // 7 days

    const session: UserSession = {
      token,
      userId: user.userId,
      username: user.username,
      createdAt: now,
      expiresAt,
    };

    this.sessions.set(token, session);
    user.lastLoginAt = new Date().toISOString();
    this.saveUsers();

    logger.info(`🔑 [Auth Logged In] Người dùng [${user.username}] đăng nhập thành công.`);
    return { user, token };
  }

  public validateSession(token: string): UserSession | null {
    if (!token) return null;
    const session = this.sessions.get(token);
    if (!session) return null;

    if (Date.now() > session.expiresAt) {
      this.sessions.delete(token);
      return null;
    }

    return session;
  }

  public invalidateSession(token: string): boolean {
    return this.sessions.delete(token);
  }

  public changePassword(username: string, oldPass: string, newPass: string): { success: boolean; error?: string } {
    const user = this.users.get(username.trim().toLowerCase());
    if (!user) return { success: false, error: 'Người dùng không tồn tại' };

    const oldHash = this.hashPassword(oldPass, user.salt);
    if (oldHash !== user.passwordHash) {
      return { success: false, error: 'Mật khẩu hiện tại không đúng' };
    }

    const newSalt = crypto.randomBytes(16).toString('hex');
    user.salt = newSalt;
    user.passwordHash = this.hashPassword(newPass, newSalt);
    this.saveUsers();

    logger.info(`🔐 [Auth Password Changed] Đổi mật khẩu thành công cho tài khoản [${user.username}].`);
    return { success: true };
  }
}

export const authRepository = new AuthRepository();
