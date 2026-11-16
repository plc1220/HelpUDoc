import { Request, Response, NextFunction } from 'express';

/** Credentials and private source text must never enter request logs. */
export const loggingMiddleware = (req: Request, _res: Response, next: NextFunction) => {
  console.log({
    timestamp: new Date().toISOString(),
    method: req.method,
    path: req.originalUrl.split('?')[0],
  });
  next();
};
