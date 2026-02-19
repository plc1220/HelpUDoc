import { Request, Response, NextFunction } from 'express';

export function requireSystemAdmin(req: Request, res: Response, next: NextFunction) {
  if (!req.userContext) {
    return res.status(401).json({ error: 'Missing user context' });
  }

  if (!req.userContext.isAdmin) {
    return res.status(403).json({ error: 'Admin access required' });
  }

  return next();
}
