# File and folder drag-and-drop uploads

Drop files or folders from a desktop file manager onto the Files panel to upload
to the workspace root, or onto a folder to upload inside it. Nested and empty
folders are preserved. Existing folders require a choice between merging and
creating a numbered copy. Duplicate files use the existing numbered-name policy.
If a nested folder conflicts with a file while merging, the upload stops before
writing and asks you to choose a separate copy.

## Manual checks

Start the application using the [local development setup](environment.md#local-development-run-services-directly).

1. Drag two documents from Finder or Windows File Explorer into an empty Files panel.
2. Drag a folder containing a nested folder, an empty folder, and several files.
3. Open files and verify their contents; refresh and check the structure remains.
4. Drop a file directly onto a folder and confirm its destination.
5. Drop the same folder again. Cancel first, then repeat and test **Create separate
   copy**, then **Merge**. Originals must remain intact; duplicate files are numbered.
6. Use **+ → Upload files** and **+ → Upload folder**, and move an existing workspace
   file between folders. These paths should continue to work.

Upload results and individual failures appear directly above the file tree.
Uploads already started finish in their original workspace if you navigate away.
Pending folder confirmations are cancelled when switching workspaces. Unsupported
folder-reading environments receive guidance to use **+ → Upload folder**.

## Automated checks

Use Node 24 for the unit-test command below: the existing test script uses native
TypeScript stripping.

```sh
cd frontend
npm test
npm run lint
npm run build
```

For browser fixtures, start Vite in a separate terminal from `frontend/`:

```sh
VITE_AUTH_MODE=headers VITE_API_URL=/api npm run dev -- --host 127.0.0.1 --port 5179
```

Then run the upload and existing editor/navigation regression suites:

```sh
E2E_BASE_URL=http://127.0.0.1:5179 npx playwright test e2e/workspace-upload-local.spec.ts e2e/markdown-editor-local.spec.ts e2e/workspace-navigator-local.spec.ts --project=chromium
```

Browser fixtures use mocked APIs. Tests cover directory batches beyond 100 entries,
conflicts, failures, permissions, internal moves, and workspace switching. Native
Windows Explorer and other desktop/browser combinations require manual checks.
