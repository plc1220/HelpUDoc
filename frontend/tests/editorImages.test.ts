import assert from 'node:assert/strict';
import test from 'node:test';
import {
  EDITOR_IMAGE_ACCEPT, MAX_EDITOR_IMAGE_BYTES, WORKSPACE_IMAGE_DRAG_MIME,
  isEditorImageName, isWorkspaceImageDrag, readWorkspaceImageDrag,
  validateEditorImage, readEditorImageDataUrl,
} from '../src/utils/editorImages.ts';

test('only image file pane payloads qualify for insertion', () => {
  assert.equal(isWorkspaceImageDrag({ types: ['text/plain'] }), false);
  assert.equal(isWorkspaceImageDrag({ types: [WORKSPACE_IMAGE_DRAG_MIME] }), true);
  const read = (value: string) => readWorkspaceImageDrag({ getData: () => value });
  assert.deepEqual(read(JSON.stringify({ fileId: 'photo-1', name: 'Photos/site.JPG' })), { fileId: 'photo-1', name: 'Photos/site.JPG' });
  for (const value of ['photo-1', '{}', 'null', '{bad}', JSON.stringify({ fileId: {}, name: 'image.png' }), JSON.stringify({ fileId: '1', name: 'image.png.html' })]) {
    assert.equal(read(value), null);
  }
  assert.equal(isEditorImageName('Photos/cat.webp'), true);
  assert.equal(isEditorImageName('notes.md'), false);
});

test('image input rejects unsupported or oversized files before uploading', () => {
  for (const type of EDITOR_IMAGE_ACCEPT.split(',')) validateEditorImage({ type, size: 42 });
  assert.throws(() => validateEditorImage({ type: 'image/svg+xml', size: 42 }), /PNG, JPEG/);
  assert.throws(() => validateEditorImage({ type: 'text/html', size: 42 }), /PNG, JPEG/);
  assert.throws(() => validateEditorImage({ type: 'image/png', size: 0 }), /empty/);
  assert.throws(() => validateEditorImage({ type: 'image/png', size: MAX_EDITOR_IMAGE_BYTES + 1 }), /10 MB/);
});

test('embedded image data survives Markdown storage without temporary URLs', async () => {
  const bytes = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const file = new File([bytes], 'photo.png', { type: 'image/png' });
  const url = await readEditorImageDataUrl(file);
  assert.equal(url, `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`);
});
