import { createRoot } from 'react-dom/client';
import { AppThemeRoot } from '../../src/AppThemeRoot';
import { applyColorModeToDocument } from '../../src/colorMode';
import '../../src/index.css';
import FileRenderer from '../../src/components/FileRenderer';
import { buildXlsxFixture, XLSX_FIXTURES, type XlsxFixtureName } from './xlsxFixtures';

// Usage: /e2e/fixtures/xlsx-preview.html?fixture=multi|offset|emptyFirst&theme=light|dark
const params = new URLSearchParams(window.location.search);
const requested = params.get('fixture') ?? 'multi';
const fixture = (requested in XLSX_FIXTURES ? requested : 'multi') as XlsxFixtureName;
applyColorModeToDocument(params.get('theme') === 'dark' ? 'dark' : 'light');

const toBase64 = (bytes: Uint8Array) => {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return window.btoa(binary);
};

void buildXlsxFixture(fixture).then((bytes) => {
  createRoot(document.getElementById('root')!).render(
    <AppThemeRoot>
      <div style={{ height: '100vh' }}>
        <FileRenderer file={{ id: '1', name: `${fixture}.xlsx` }} fileContent={toBase64(bytes)} workspaceId="e2e" />
      </div>
    </AppThemeRoot>,
  );
});
