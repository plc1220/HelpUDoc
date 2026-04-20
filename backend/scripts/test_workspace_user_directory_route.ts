import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import express from 'express';
import workspaceRoutes from '../src/api/workspaces';

const requestedWorkspaceIds: string[] = [];

const workspaceService = {
  getWorkspaceForUser: async (workspaceId: string) => {
    requestedWorkspaceIds.push(workspaceId);
    return { id: workspaceId };
  },
} as any;

const userService = {
  searchUsersForDirectory: async (
    query: string,
    options: { limit: number; excludeUserId?: string },
  ) => ({
    query,
    options,
  }),
} as any;

const app = express();
app.use((req, _res, next) => {
  (req as any).userContext = {
    userId: '00000000-0000-4000-8000-000000000001',
    displayName: 'Owner',
    email: 'owner@example.com',
  };
  next();
});
app.use('/workspaces', workspaceRoutes(workspaceService, userService));

const server = app.listen(0);
const address = server.address();
assert(address && typeof address === 'object', 'test server should bind to a random port');
const port = (address as AddressInfo).port;

async function main() {
  try {
    const response = await fetch(
      `http://127.0.0.1:${port}/workspaces/user-directory?q=to&limit=7&excludeSelf=true`,
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      users: {
        query: 'to',
        options: {
          limit: 7,
          excludeUserId: '00000000-0000-4000-8000-000000000001',
        },
      },
    });
    assert.deepEqual(requestedWorkspaceIds, []);
    console.log('workspace user directory route ok');
  } finally {
    server.close();
  }
}

void main();
