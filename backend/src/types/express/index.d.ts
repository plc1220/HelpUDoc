import 'express';
import { UserContext } from '../user';

declare module 'express-serve-static-core' {
  interface Request {
    userContext?: UserContext;
  }
}
