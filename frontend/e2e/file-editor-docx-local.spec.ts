import { expect, test } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import JSZip from 'jszip';

test('Edit file routes through FileEditor to native DOCX editing and its Save handle', async ({ page, baseURL }) => {
  test.skip(!process.env.NATIVE_DOCX_FIXTURE || !baseURL?.startsWith('http://127.0.0.1:'), 'Requires local Vite and NATIVE_DOCX_FIXTURE');
  const original = readFileSync(process.env.NATIVE_DOCX_FIXTURE!);
  let content = original.toString('base64');
  let version = 1;
  let revision = createHash('sha256').update(original).digest('hex');
  const saves: { version: number; revision: string; content: string }[] = [];
  const headers = { 'access-control-allow-origin': baseURL!, 'access-control-allow-credentials': 'true' };
  await page.route('**/api/workspaces/editor-routing/files/61/docx-content', async route => {
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { ...headers, 'access-control-allow-methods': '*', 'access-control-allow-headers': '*' } });
    if (route.request().method() === 'PUT') {
      const body = route.request().postDataJSON();
      expect(body.version).toBe(version); expect(body.revision).toBe(revision);
      saves.push(body); content = body.content; version++;
      revision = createHash('sha256').update(Buffer.from(content, 'base64')).digest('hex');
      return route.fulfill({ json: { file: { id: '61', name: 'Quarterly plan.docx', version, content }, revision }, headers });
    }
    return route.fulfill({ json: { content, version, revision, canEdit: true, readOnlyReason: null }, headers });
  });
  await page.route('**/api/workspaces/editor-routing/collaboration/objects', route => route.fulfill({ json: { objects: [] }, headers }));
  await page.route('**/__file-editor-docx', route => route.fulfill({ contentType: 'text/html', body: `<html data-astryx-theme="neutral" data-theme="light"><head><script type="module">
    import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true;
    </script></head><body><div id="root"></div><script type="module">
    import React from '/node_modules/.vite/deps/react.js'; import ReactDOM from '/node_modules/.vite/deps/react-dom_client.js';
    import {AppThemeRoot} from '/src/AppThemeRoot.tsx'; import FileEditor from '/src/components/FileEditor.tsx';
    import {OfficeDocumentContext} from '/src/components/OfficeDocumentContext.ts'; import CanvasAnnotations from '/src/components/CanvasAnnotations.tsx';
    import {Button} from '/node_modules/.vite/deps/@astryxdesign_core_Button.js'; import {ToggleButton} from '/node_modules/.vite/deps/@astryxdesign_core_ToggleButton.js'; import '/src/index.css';
    function Harness(){const ref=React.useRef(null);const [editing,setEditing]=React.useState(false);const [file,setFile]=React.useState({id:'61',name:'Quarterly plan.docx',version:1});const [state,setState]=React.useState({dirty:false,saving:false,error:null});const [textChanges,setTextChanges]=React.useState(0);
      const toggle=async(value)=>{if(!value&&ref.current){try{await ref.current.save()}catch{return}}setEditing(value)};
      return React.createElement(AppThemeRoot,{},React.createElement('div',{style:{height:'100vh',display:'flex',flexDirection:'column'}},
        React.createElement('header',{style:{display:'flex',gap:8,padding:12}},React.createElement(ToggleButton,{label:'Edit file',isPressed:editing,isDisabled:state.saving,onPressedChange:toggle}),editing&&React.createElement(Button,{label:state.saving?'Saving…':'Save',isDisabled:!state.dirty||state.saving,onClick:()=>ref.current?.save().catch(()=>{})}),React.createElement('span',{'data-testid':'state'},state.dirty?'Unsaved changes':'All changes saved'),React.createElement('span',{'data-testid':'text-changes'},textChanges)),
        React.createElement('div',{style:{flex:1,minHeight:0}},React.createElement(OfficeDocumentContext.Provider,{value:{canEdit:true,onSaved:setFile,onAgentChat:()=>{}}},React.createElement(CanvasAnnotations,{workspace:{id:'editor-routing',role:'owner',visibility:'private'},filePath:editing?undefined:file.name,onAgentChat:()=>{}},editing?React.createElement(FileEditor,{file,fileContent:'binary-preview-content',onContentChange:()=>setTextChanges(x=>x+1),workspaceId:'editor-routing',colorMode:'light',nativeDocxRef:ref,onNativeDocxStateChange:setState}):React.createElement('div',{'data-testid':'preview'},'Document preview'))))));}
    ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(Harness));
    </script></body></html>` }));
  await page.goto('/__file-editor-docx');
  await page.getByRole('button', { name: 'Edit file', exact: true }).click();
  await expect(page.getByLabel('Word document editor')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Annotate', exact: true })).toHaveCount(0);
  const title = page.getByText('Quarterly plan', { exact: true }).first();
  await expect(title).toBeVisible({ timeout: 60000 });
  await title.dblclick();
  await page.keyboard.press('Home');
  await page.keyboard.type('Routing ');
  await expect(page.getByTestId('state')).toHaveText('Unsaved changes');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByTestId('state')).toHaveText('All changes saved');
  expect(saves).toHaveLength(1);
  await expect(page.getByTestId('text-changes')).toHaveText('0');
  const saved = await JSZip.loadAsync(Buffer.from(saves[0].content, 'base64'));
  expect(await saved.file('word/document.xml')!.async('string')).toContain('Routing ');
  await page.getByRole('button', { name: 'Edit file', exact: true }).click();
  await expect(page.getByTestId('preview')).toBeVisible();
  await expect(page.getByLabel('Word document editor')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Annotate', exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Edit file', exact: true }).click();
  await expect(page.getByLabel('Word document editor')).toBeVisible();
  await expect(page.getByText('Routing Quarterly plan', { exact: true }).first()).toBeVisible({ timeout: 60000 });
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  await expect(page.getByTestId('text-changes')).toHaveText('0');
});
