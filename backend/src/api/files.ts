import { Router, Request, Response } from 'express';
import { z } from 'zod';
import multer from 'multer';
import { FileService } from '../services/fileService';
import { DatabaseService } from '../services/databaseService';

export default function(dbService: DatabaseService) {
  const router = Router({ mergeParams: true });
  const fileService = new FileService(dbService);
  const upload = multer({ storage: multer.memoryStorage() });

  const updateFileSchema = z.object({
    content: z.string(),
  });

  router.get('/', async (req: Request<{ workspaceId: string }>, res: Response) => {
    const { workspaceId } = req.params;
    const files = await fileService.getFiles(workspaceId);
    res.json(files);
  });

  router.get('/:fileId/content', async (req: Request<{ fileId: string }>, res: Response) => {
    try {
      const { fileId } = req.params;
      const file = await fileService.getFileContent(parseInt(fileId, 10));
      res.json(file);
    } catch (error) {
      if (error instanceof Error) {
        if (error.message === 'File not found') {
          return res.status(404).json({ error: 'File not found' });
        }
      }
      res.status(500).json({ error: 'Failed to retrieve file content' });
    }
  });

  router.post(
    '/',
    upload.single('file'),
    async (req: Request<{ workspaceId: string }>, res: Response) => {
      try {
        const { workspaceId } = req.params;
        if (!req.file) {
          return res.status(400).json({ error: 'No file uploaded' });
        }
        const newFile = await fileService.createFile(
          workspaceId,
          req.file.originalname,
          req.file.buffer,
          req.file.mimetype,
        );
        res.status(201).json(newFile);
      } catch (error) {
        res.status(400).json({ error: 'Invalid input' });
      }
    },
  );

  router.put('/:fileId/content', async (req: Request<{ fileId: string }>, res: Response) => {
    try {
      const { fileId } = req.params;
      const { content } = req.body;
      const updatedFile = await fileService.updateFile(parseInt(fileId), content);
      res.json(updatedFile);
    } catch (error) {
      console.error('Error updating file content:', error);
      res.status(400).json({ error: 'Failed to update file content' });
    }
  });

  router.delete('/:fileId', async (req, res) => {
    const { fileId } = req.params;
    await fileService.deleteFile(parseInt(fileId));
    res.status(204).send();
  });

  return router;
}