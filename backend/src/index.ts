import * as dotenv from 'dotenv';
dotenv.config();
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import multer from 'multer';
import apiRoutes from './api/routes';
import { loggingMiddleware } from './api/logging';
import { DatabaseService } from './services/databaseService';

const app = express();
const port = process.env.PORT || 3000;

async function startServer() {
  const databaseService = new DatabaseService();
  await databaseService.initialize();

  app.use(helmet());
  app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  }));
  app.use(loggingMiddleware);
  app.use(express.json({ limit: '50mb' }));
  app.use(express.urlencoded({ limit: '50mb', extended: true }));

  app.use('/api', apiRoutes(databaseService));

  app.listen(port, () => {
    console.log(`Server is running on http://localhost:${port}`);
  });
}

startServer();