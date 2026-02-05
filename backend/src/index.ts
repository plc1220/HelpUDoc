import * as dotenv from 'dotenv';

const envFile = process.env.ENV_FILE;
if (envFile) {
  dotenv.config({ path: envFile });
} else {
  dotenv.config();
}
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import multer from 'multer';
import session from 'express-session';
import { RedisStore } from 'connect-redis';
import apiRoutes from './api/routes';
import { loggingMiddleware } from './api/logging';
import { DatabaseService } from './services/databaseService';
import { UserService } from './services/userService';
import { userContextMiddleware } from './middleware/userContext';
import { blockingRedisClient, redisClient } from './services/redisService';
import { startCollabServer } from './collab/collabServer';

const app = express();
const port = process.env.PORT || 3000;

async function startServer() {
  const databaseService = new DatabaseService();
  await databaseService.initialize();
  const userService = new UserService(databaseService);
  await Promise.all([redisClient.connect(), blockingRedisClient.connect()]);

  const sessionTtlSeconds = Number(process.env.SESSION_TTL_SECONDS);
  const sessionMaxAgeSeconds = Number.isFinite(sessionTtlSeconds) && sessionTtlSeconds > 0
    ? sessionTtlSeconds
    : 60 * 60 * 24 * 7; // default to 7 days

  app.use(helmet());
  app.use(cors({
    origin: true,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-User-Id', 'X-User-Name', 'X-User-Email'],
  }));
  app.set('trust proxy', 1);
  app.use(session({
    name: process.env.SESSION_NAME || 'helpudoc.sid',
    store: new RedisStore({
      client: redisClient,
      prefix: 'sess:',
    }),
    secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      maxAge: sessionMaxAgeSeconds * 1000,
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
    },
  }));
  app.use(loggingMiddleware);
  app.use(express.json({ limit: '50mb' }));
  app.use(express.urlencoded({ limit: '50mb', extended: true }));
  app.use(userContextMiddleware(userService));

  app.use('/api', apiRoutes(databaseService, userService));
  startCollabServer(databaseService, userService);

  app.listen(port, () => {
    console.log(`Server is running on http://localhost:${port}`);
  });
}

startServer();
