import { Request, Response, NextFunction } from 'express';
import { authRepository } from './repository.js';

export interface AuthenticatedRequest extends Request {
  userSession?: {
    userId: string;
    username: string;
  };
}

export function authMiddleware(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  // Exclude login, status & SSE events endpoints from strict auth check
  const path = req.path;
  if (path === '/api/auth/login' || path === '/api/auth/status' || path === '/api/events' || path === '/events') {
    return next();
  }

  const authHeader = req.headers.authorization || '';
  let token = '';

  if (authHeader.startsWith('Bearer ')) {
    token = authHeader.substring(7).trim();
  } else if (req.headers['x-auth-token']) {
    token = String(req.headers['x-auth-token']).trim();
  } else if (req.query.token) {
    token = String(req.query.token).trim();
  }

  const session = authRepository.validateSession(token);
  if (!session) {
    return res.status(401).json({
      success: false,
      code: 'UNAUTHORIZED',
      error: 'Phiên làm việc hết hạn hoặc chưa đăng nhập. Vui lòng đăng nhập lại.',
    });
  }

  req.userSession = {
    userId: session.userId,
    username: session.username,
  };

  next();
}
