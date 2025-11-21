export interface UserContext {
  userId: string;
  externalId: string;
  displayName: string;
  email?: string | null;
}
