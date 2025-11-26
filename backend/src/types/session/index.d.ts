import 'express-session';
import { UserContext } from '../user';

declare module 'express-session' {
  interface SessionData {
    userContext?: UserContext;
    externalId?: string;
  }
}
