export class HttpError extends Error {
  statusCode: number;
  details?: unknown;

  constructor(statusCode: number, message: string, details?: unknown) {
    super(message);
    this.statusCode = statusCode;
    this.details = details;
  }
}

export class AccessDeniedError extends HttpError {
  constructor(message = 'Access denied') {
    super(403, message);
  }
}

export class NotFoundError extends HttpError {
  constructor(message = 'Not found') {
    super(404, message);
  }
}

export class ConflictError extends HttpError {
  constructor(message = 'Conflict', details?: unknown) {
    super(409, message, details);
  }
}

/**
 * A write was refused because the Shared workspace holds a current locked
 * version, not because the caller lacks permission — an owner hits this too.
 *
 * 409 rather than 403 for that reason: the right is held, the resource state
 * forbids the act. It also lets the client tell "you are a viewer" apart from
 * "this is locked" and offer the private-copy route only for the latter.
 * `workspaceId` rather than the version number: `ensureMembership` holds only
 * the id, and joining for a number would add a query to the hottest
 * authorization path in the service for something the client already knows.
 */
export class WorkspaceContentLockedError extends ConflictError {
  constructor(workspaceId: string) {
    super(
      'This Shared workspace is locked. Take a private copy, edit there, and submit your changes for review.',
      { code: 'WORKSPACE_CONTENT_LOCKED', workspaceId },
    );
  }
}
