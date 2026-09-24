import assert from 'node:assert/strict';
import test from 'node:test';
import { isEmbeddedRasterImageUrl, safeMarkdownUrlTransform } from '../src/utils/markdownUrls.ts';

const image = { type: 'element', tagName: 'img', properties: {}, children: [] } as const;
const link = { type: 'element', tagName: 'a', properties: {}, children: [] } as const;
const dataUrl = (mime: string, bytes: string) => `data:${mime};base64,${Buffer.from(bytes, 'binary').toString('base64')}`;

test('portable PNG, JPEG, GIF and WebP photos remain usable in Markdown previews', () => {
  for (const [mime, bytes] of [['image/png', '\x89PNG\r\n\x1a\n'], ['image/jpeg', '\xff\xd8\xff\xe0'], ['image/gif', 'GIF89a'], ['image/webp', 'RIFF\0\0\0\0WEBP']]) {
    const url = dataUrl(mime, bytes);
    assert.equal(isEmbeddedRasterImageUrl(url), true, mime);
    assert.equal(safeMarkdownUrlTransform(url, 'src', { ...image, children: [] }), url);
  }
});

test('image data URLs are allowed only on img src, never hyperlinks or other elements', () => {
  const url = dataUrl('image/png', '\x89PNG\r\n\x1a\n');
  assert.equal(safeMarkdownUrlTransform(url, 'href', { ...link, children: [] }), '');
  assert.equal(safeMarkdownUrlTransform(url, 'src', { ...link, children: [] }), '');
});

test('blocks HTML, SVG, mismatched raster MIME, malformed or oversized data URLs', () => {
  const urls = [
    dataUrl('text/html', '<script>alert(1)</script>'),
    dataUrl('image/svg+xml', '<svg onload="alert(1)"/>'),
    dataUrl('image/png', '<svg onload="alert(1)"/>'),
    dataUrl('image/png', '\xff\xd8\xff\xe0'),
    'data:image/png;base64,',
    'data:image/png;base64,not*base64',
    'data:image/png;base64,iVBORw0KGgo',
    dataUrl('image/png', '\x89PNG\r\n\x1a\n' + 'x'.repeat(10 * 1024 * 1024)),
  ];
  for (const url of urls) {
    assert.equal(isEmbeddedRasterImageUrl(url), false);
    assert.equal(safeMarkdownUrlTransform(url, 'src', { ...image, children: [] }), '');
  }
});

test('retains standard URL policy for links and workspace-relative image paths', () => {
  for (const url of ['https://example.com/photo.jpg', '/images/photo.jpg', '../photo.jpg', 'mailto:hello@example.com', '#section']) {
    assert.equal(safeMarkdownUrlTransform(url, 'href', { ...link, children: [] }), url);
  }
  for (const url of ['javascript:alert(1)', 'vbscript:msgbox(1)', 'data:text/html;base64,SGk=']) {
    assert.equal(safeMarkdownUrlTransform(url, 'href', { ...link, children: [] }), '');
  }
});
