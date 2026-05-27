import { Router } from 'express';

const readonlyMessage = 'Skills are managed by CI/CD and are read-only at runtime.';

export function registerGithubImportRoutes(router: Router) {
  router.post('/skills/import/github/inspect', (_req, res) => {
    res.status(405).json({ error: readonlyMessage });
  });

  router.post('/skills/import/github/apply', (_req, res) => {
    res.status(405).json({ error: readonlyMessage });
  });
}
