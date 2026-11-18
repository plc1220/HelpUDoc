import test from 'node:test';
import assert from 'node:assert/strict';
import {
  collectDroppedFiles,
  isExternalFileDrop,
  type UploadBatch,
} from '../src/utils/workspaceFileDrop.ts';
import {
  findFolderConflicts,
  planDroppedUpload,
  uploadWorkspaceBatch,
} from '../src/utils/workspaceUploads.ts';

const file = (name: string, body = name) => new File([body], name, { type: 'text/plain' });
const entry = (name: string) => ({
  name,
  isDirectory: false,
  file: (done: (file: File) => void) => done(file(name)),
});
const directory = (name: string, batches: unknown[][]) => ({
  name,
  isDirectory: true,
  createReader: () => {
    let index = 0;
    return { readEntries: (done: (entries: unknown[]) => void) => done(batches[index++] || []) };
  },
});
const transfer = (entries: unknown[]) =>
  ({
    files: [],
    items: entries.map((item) => ({
      kind: 'file',
      webkitGetAsEntry: () => item,
      getAsFile: () => null,
    })),
  }) as unknown as Pick<DataTransfer, 'items' | 'files'>;
const batch = (): UploadBatch => ({
  files: [{ file: file('one.txt'), path: 'Reports/one.txt' }],
  folders: ['Reports', 'Reports/empty'],
  failures: [],
});

test('only external file drags are uploads; internal drags, text, and links stay separate', () => {
  assert.equal(isExternalFileDrop({ types: ['Files'] }), true);
  for (const types of [
    ['text/plain'],
    ['text/uri-list'],
    ['Files', 'application/x-helpudoc-workspace-file-id'],
    ['application/x-helpudoc-workspace-folder-path'],
  ]) {
    assert.equal(isExternalFileDrop({ types }), false);
  }
});

test('directory collection preserves mixed selections, nesting, empty folders, and all directory batches', async () => {
  const hundred = Array.from({ length: 100 }, (_, i) => entry(`file-${i}.txt`));
  const result = await collectDroppedFiles(
    transfer([
      entry('loose.txt'),
      directory('Reports', [
        hundred,
        [entry('last.txt'), directory('empty', []), directory('nested', [[entry('日本語.txt')]])],
      ]),
    ]),
  );
  assert.equal(result.files.length, 103);
  assert.ok(result.files.some((item) => item.path === 'Reports/last.txt'));
  assert.ok(result.files.some((item) => item.path === 'Reports/nested/日本語.txt'));
  assert.deepEqual(result.folders, ['Reports', 'Reports/empty', 'Reports/nested']);
  assert.deepEqual(result.failures, []);
});

test('top-level entries are captured before asynchronous reading closes the drag data store', async () => {
  const source = transfer([directory('Reports', [[entry('one.txt')]]), entry('two.txt')]);
  const pending = collectDroppedFiles(source);
  Object.defineProperty(source, 'items', {
    get() {
      throw new Error('Protected drag store');
    },
  });
  const result = await pending;
  assert.deepEqual(
    result.files.map((item) => item.path),
    ['Reports/one.txt', 'two.txt'],
  );
});

test('unreadable items are reported alongside readable siblings', async () => {
  const broken = {
    name: 'locked.txt',
    isDirectory: false,
    file: (_: unknown, fail: (e: Error) => void) => fail(new Error('Permission denied')),
  };
  const result = await collectDroppedFiles(transfer([broken, entry('good.txt')]));
  assert.equal(result.files[0].path, 'good.txt');
  assert.deepEqual(result.failures, [{ path: 'locked.txt', message: 'Permission denied' }]);
});

test('fallback accepts a real empty file but reports unreadable directory placeholders', async () => {
  const empty = file('empty.txt', '');
  const placeholder = {
    name: 'Folder',
    slice: () => ({
      arrayBuffer: async () => {
        throw new Error('Directory');
      },
    }),
  };
  const result = await collectDroppedFiles({
    items: [],
    files: [empty, placeholder],
  } as unknown as Pick<DataTransfer, 'items' | 'files'>);
  assert.equal(result.files[0].file.size, 0);
  assert.match(result.failures[0].message, /Upload folder/);
});

test('folder conflicts use complete paths and distinguish a file occupying the folder name', () => {
  assert.deepEqual(findFolderConflicts(batch(), 'target', ['target/Reports/a.txt'], []), [
    { name: 'Reports', path: 'target/Reports', canMerge: true },
  ]);
  assert.deepEqual(findFolderConflicts(batch(), 'target', ['target/Reports'], []), [
    { name: 'Reports', path: 'target/Reports', canMerge: false },
  ]);
  assert.deepEqual(findFolderConflicts(batch(), 'target', [], ['Reports']), []);
});

test('copies reserve numbered destinations, including other incoming folders', () => {
  const original = batch();
  original.folders.push('Reports (3)');
  const result = planDroppedUpload(
    original,
    'target',
    [],
    ['target/Reports', 'target/Reports (2)'],
    { Reports: 'copy' },
  );
  assert.deepEqual(result.folders, [
    'target/Reports (4)',
    'target/Reports (4)/empty',
    'target/Reports (3)',
  ]);
  assert.equal(result.files[0].path, 'target/Reports (4)/one.txt');
  assert.equal(original.files[0].path, 'Reports/one.txt');
});

test('explicit merge keeps the destination and gives duplicate files numbered names', () => {
  const result = planDroppedUpload(batch(), '', ['Reports/one.txt'], [], { Reports: 'merge' });
  assert.equal(result.files[0].path, 'Reports/one (2).txt');
  assert.deepEqual(
    result.folders,
    ['Reports/empty'],
    'Existing folders must not be counted as newly created',
  );
});

test('new conflicts and impossible merges stop planning before any writes', () => {
  assert.throws(() => planDroppedUpload(batch(), '', [], ['Reports'], {}), /conflict changed/);
  assert.throws(
    () => planDroppedUpload(batch(), '', ['Reports'], [], { Reports: 'merge' }),
    /conflict changed/,
  );
});

test('folder names matching object properties still require an explicit conflict decision', () => {
  for (const name of ['constructor', 'toString', '__proto__']) {
    const original: UploadBatch = { files: [], folders: [name], failures: [] };
    assert.throws(() => planDroppedUpload(original, '', [], [name], {}), /conflict changed/);
  }
});

test('a file cannot occupy an existing or incoming folder path', () => {
  const original: UploadBatch = {
    files: [
      { file: file('Reports'), path: 'Reports' },
      { file: file('Charts.csv'), path: 'Charts.csv' },
    ],
    folders: ['Charts.csv'],
    failures: [],
  };
  const planned = planDroppedUpload(
    original,
    'target',
    ['target/Reports (2)'],
    ['target/Reports'],
    {},
  );
  assert.deepEqual(
    planned.files.map((item) => item.path),
    ['target/Reports (3)', 'target/Charts (2).csv'],
  );
  assert.deepEqual(planned.folders, ['target/Charts.csv']);
});

test('duplicate files skip numbered names already used by folders', () => {
  const planned = planDroppedUpload(batch(), '', ['Reports/one.txt'], ['Reports/one (2).txt'], {
    Reports: 'merge',
  });
  assert.equal(planned.files[0].path, 'Reports/one (3).txt');
});

test('a nested folder colliding with a file blocks a merge before writes', () => {
  assert.throws(
    () => planDroppedUpload(batch(), '', ['Reports/empty'], ['Reports'], { Reports: 'merge' }),
    /file already uses.*Reports\/empty.*separate copy/,
  );
});

test('uploads create parents first, retain successful siblings, and never upload into failed parents', async () => {
  const calls: string[] = [];
  const progress: number[] = [];
  const result = await uploadWorkspaceBatch(
    'original-workspace',
    {
      folders: ['blocked/child', 'blocked', 'good'],
      files: [
        { file: file('lost.txt'), path: 'blocked/lost.txt' },
        { file: file('good.txt'), path: 'good/good.txt' },
      ],
      failures: [{ path: 'unreadable.txt', message: 'Read failed' }],
    },
    {
      createFolder: async (id, path) => {
        assert.equal(id, 'original-workspace');
        calls.push(`folder:${path}`);
        if (path === 'blocked') throw new Error('Folder denied');
      },
      createFile: async (id, value, path) => {
        assert.equal(id, 'original-workspace');
        assert.equal(await value.text(), 'good.txt');
        calls.push(`file:${path}`);
      },
    },
    (value) => progress.push(value.completed),
  );
  assert.deepEqual(calls, ['folder:blocked', 'folder:good', 'file:good/good.txt']);
  assert.equal(result.uploadedFiles, 1);
  assert.equal(result.createdFolders, 1);
  assert.equal(result.failures.length, 4);
  assert.equal(progress.at(-1), 5);
});

test('empty-folder-only batches are created and reported', async () => {
  const result = await uploadWorkspaceBatch(
    'workspace',
    { files: [], folders: ['empty'], failures: [] },
    { createFile: async () => assert.fail('No files expected'), createFolder: async () => {} },
  );
  assert.deepEqual(result, { uploadedFiles: 0, createdFolders: 1, failures: [] });
});
