import { Router, Request, Response } from 'express';
import { z } from 'zod';
import multer from 'multer';
import { FileService } from '../services/fileService';
import { fetchRagStatuses } from '../services/agentService';
import { HttpError } from '../errors';

export default function(fileService: FileService) {
  const router = Router({ mergeParams: true });
  const upload = multer({ storage: multer.memoryStorage() });

  const updateFileSchema = z.object({
    content: z.string(),
    version: z.number().int().positive().optional(),
  });

  const renameFileSchema = z.object({
    name: z.string().min(1),
    version: z.number().int().positive().optional(),
  });

  const ragStatusSchema = z.object({
    files: z.array(z.string().min(1)),
  });

  const requireUserContext = (req: Request) => {
    if (!req.userContext) {
      throw new HttpError(401, 'Missing user context');
    }
    return req.userContext;
  };

  const handleError = (res: Response, error: unknown, fallbackMessage: string) => {
    if (error instanceof HttpError) {
      return res.status(error.statusCode).json({ error: error.message, details: error.details });
    }
    console.error(fallbackMessage, error);
    return res.status(500).json({ error: fallbackMessage });
  };

  router.get('/', async (req: Request<{ workspaceId: string }>, res: Response) => {
    try {
      const { workspaceId } = req.params;
      const user = requireUserContext(req);
      const files = await fileService.getFiles(workspaceId, user.userId);
      res.json(files);
    } catch (error) {
      handleError(res, error, 'Failed to list files');
    }
  });

  router.get('/preview', async (req: Request<{ workspaceId: string }>, res: Response) => {
    try {
      const { workspaceId } = req.params;
      const user = requireUserContext(req);
      const relativePath = req.query.path;
      if (typeof relativePath !== 'string') {
        return res.status(400).json({ error: 'Missing file path' });
      }
      const preview = await fileService.getWorkspaceFilePreview(workspaceId, relativePath, user.userId);
      res.json(preview);
    } catch (error) {
      handleError(res, error, 'Failed to preview file');
    }
  });

  router.get('/:fileId/content', async (req: Request<{ fileId: string }>, res: Response) => {
    try {
      const { fileId } = req.params;
      const user = requireUserContext(req);
      const file = await fileService.getFileContent(parseInt(fileId, 10), user.userId);
      res.json(file);
    } catch (error) {
      handleError(res, error, 'Failed to retrieve file content');
    }
  });

  router.post('/rag-status', async (req: Request<{ workspaceId: string }>, res: Response) => {
    try {
      const { workspaceId } = req.params;
      const user = requireUserContext(req);
      await fileService.getFiles(workspaceId, user.userId);
      const payload = ragStatusSchema.parse(req.body);
      const statuses = await fetchRagStatuses(workspaceId, payload.files);
      res.json({ statuses });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: 'Invalid input' });
      }
      handleError(res, error, 'Failed to fetch RAG status');
    }
  });

  router.post(
    '/',
    upload.single('file'),
    async (req: Request<{ workspaceId: string }>, res: Response) => {
      try {
        const { workspaceId } = req.params;
        const user = requireUserContext(req);
        if (!req.file) {
          return res.status(400).json({ error: 'No file uploaded' });
        }
        const newFile = await fileService.createFile(
          workspaceId,
          req.file.originalname,
          req.file.buffer,
          req.file.mimetype,
          user.userId,
        );
        res.status(201).json(newFile);
      } catch (error) {
        handleError(res, error, 'Failed to create file');
      }
    },
  );

  router.put('/:fileId/content', async (req: Request<{ fileId: string }>, res: Response) => {
    try {
      const { fileId } = req.params;
      const user = requireUserContext(req);
      const { content, version } = updateFileSchema.parse(req.body);
      const updatedFile = await fileService.updateFile(parseInt(fileId, 10), content, user.userId, version);
      res.json(updatedFile);
    } catch (error) {
      handleError(res, error, 'Failed to update file content');
    }
  });

  router.delete('/:fileId', async (req, res) => {
    try {
      const { fileId } = req.params;
      const user = requireUserContext(req);
      await fileService.deleteFile(parseInt(fileId, 10), user.userId);
      res.status(204).send();
    } catch (error) {
      handleError(res, error, 'Failed to delete file');
    }
  });

  router.patch('/:fileId', async (req: Request<{ fileId: string }>, res: Response) => {
    try {
      const { fileId } = req.params;
      const user = requireUserContext(req);
      const { name, version } = renameFileSchema.parse(req.body);
      const updatedFile = await fileService.renameFile(parseInt(fileId, 10), name, user.userId, version);
      res.json(updatedFile);
    } catch (error) {
      handleError(res, error, 'Failed to rename file');
    }
  });

  return router;
}
