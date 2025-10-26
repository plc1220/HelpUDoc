# Quickstart: Custom Agent UI and Backend

## Prerequisites
- Node.js 20.x
- npm or yarn

## Backend Setup
1. Navigate to the `backend` directory.
2. Install dependencies: `npm install`
3. Start the development server: `npm run dev`
4. The API will be available at `http://localhost:3000`.

### Backend `package.json`

The `backend/package.json` file is missing the `dev` script and some dependencies. It should be updated to include the following:

```json
{
  "scripts": {
    "dev": "nodemon --watch 'src/**/*.ts' --exec 'ts-node' src/index.ts",
    "test": "echo \"Error: no test specified\" && exit 1"
  },
  "devDependencies": {
    "@types/express": "^5.0.3",
    "@types/node": "^24.7.2",
    "nodemon": "^3.0.0",
    "ts-node": "^10.9.1"
  }
}
```

## Frontend Setup
1. Navigate to the `frontend` directory.
2. Install dependencies: `npm install`
3. Start the development server: `npm run dev`
4. The UI will be available at `http://localhost:5173`.

## Running the Application
Once both the backend and frontend servers are running, you can access the application in your web browser at `http://localhost:5173`.