import { NextFunction, Request, Response } from 'express';
import { licenseService } from '../services/licenseService';

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function requireActiveLicense(req: Request, res: Response, next: NextFunction) {
  if (READ_METHODS.has(req.method)) {
    return next();
  }

  const state = licenseService.getState();
  if (state.active) {
    return next();
  }

  return res.status(state.status === 'expired' ? 402 : 403).json({
    error: state.status === 'expired' ? 'trial_expired' : 'license_inactive',
    message: 'message' in state ? state.message : 'HelpUDoc license is inactive',
    license: licenseService.getPublicState(),
  });
}
