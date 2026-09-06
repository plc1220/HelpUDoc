import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page, baseURL }) => {
  test.skip(!baseURL || !/^http:\/\/(localhost|127\.0\.0\.1):/.test(baseURL), 'Local Vite server required');
  await page.route('**/__slide-styles-qc*', route => route.fulfill({ contentType: 'text/html', body: `<html><head><script type="module">
    import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window);
    window.$RefreshReg$ = () => {}; window.$RefreshSig$ = () => type => type; window.__vite_plugin_react_preamble_installed__ = true;
  </script></head><body style="margin:0"><div id="root"></div><script type="module">
    import React from '/node_modules/.vite/deps/react.js'; import ReactDOM from '/node_modules/.vite/deps/react-dom_client.js';
    import SlideStyleBrowser from '/src/components/slides/SlideStyleBrowser.tsx';
    import {InteractionSurfaceRenderer} from '/src/interactions/InteractionSurfaceRenderer.tsx';
    import {assertUnchangedDeck} from '/src/components/slides/slideStyleWorkflow.ts'; import '/src/index.css';
    window.operations=[];
    const html = title => '<!doctype html><html><head><script>localStorage.setItem("preview-qc", "isolated");sessionStorage.setItem("qc", "ok");</'+'script></head><body><section class="slide"><h1>'+title+'</h1></section></body></html>';
    function Harness(){
      const [revision,setRevision]=React.useState({content:html('Original'),version:1});
      const current=React.useRef(revision); current.current=revision;
      const [token,setToken]=React.useState(0);
      const [choice,setChoice]=React.useState(null);
      React.useEffect(()=>{const browse=e=>{setChoice(e.detail);setToken(t=>t+1)};window.addEventListener('lumo:browse-slide-styles',browse);return ()=>window.removeEventListener('lumo:browse-slide-styles',browse)},[]);
      const params=new URLSearchParams(location.search);
      return React.createElement('div',{style:{height:'100dvh',display:'flex',flexDirection:'column'}},
        React.createElement('div',{},React.createElement('button',{onClick:()=>setRevision({content:html('Concurrent change'),version:8})},'Simulate concurrent edit'),
        React.createElement('button',{onClick:()=>setToken(t=>t+1)},'Browse from chat')),
        params.has('interaction')?React.createElement(InteractionSurfaceRenderer,{workspaceId:'qc',request:{interactionId:'style-choice-1',presentation:'style_preview',props:{title:'Choose a style',choices:[{id:'a',label:'Original shortlist'}]}},onSubmit:async response=>{window.operations.push(response)}}):null,
        React.createElement('div',{style:{flex:1,minHeight:0}}, React.createElement(SlideStyleBrowser,{
          workspaceId:'qc',sourcePath:'launch.html',colorMode:params.has('light')?'light':'dark',openStylesToken:token,
          disabledReason:params.has('readonly')?'Read-only deck':undefined,
          onChooseStyle:choice?choice.onSelect:params.has('choose')?async style=>{window.operations.push('choose:'+style.id)}:undefined,
          onGenerate:async style=>{window.operations.push('generate:'+style.id);if(params.has('fail')) throw new Error('Preview generation failed. Retry in chat.');
            await new Promise(resolve=>setTimeout(resolve,120));return {content:html('Proposed '+style.name),path:'.style-preview-test.html',base:{...current.current}}},
          onCommit:async (content,base)=>{assertUnchangedDeck(base,current.current);window.operations.push('commit');
            const saved={content,version:current.current.version+1};setRevision(saved);return saved;},
        },React.createElement('div',{'data-testid':'original'},revision.content))));
    } ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(Harness));
  </script></body></html>` }));
});

test('browse, filter, generate, compare, apply and undo without touching deck during exploration', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto('/__slide-styles-qc');
  await page.getByRole('tab', { name: 'Styles' }).click();
  await expect(page.getByRole('button', { name: /^Explore / })).toHaveCount(34);
  await expect(page.locator('iframe')).toHaveCount(0);
  await page.getByRole('searchbox').fill('forest');
  await expect(page.getByRole('button', { name: 'Explore Editorial Forest', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Explore Editorial Forest', exact: true }).click();
  expect(await page.evaluate(() => (window as any).operations)).toEqual([]);
  await page.getByRole('button', { name: 'Preview on my deck' }).click();
  await expect(page.getByRole('button', { name: 'Apply Editorial Forest' })).toBeVisible();
  await expect(page.frameLocator('iframe[title="Proposed slide deck"]').getByRole('heading')).toHaveText('Proposed Editorial Forest');
  await expect(page.frameLocator('iframe[title="Current slide deck"]').getByRole('heading')).toHaveText('Original');
  await expect(page.locator('iframe[title="Proposed slide deck"]')).toHaveAttribute('sandbox', 'allow-scripts');
  expect(await page.evaluate(() => localStorage.getItem('preview-qc'))).toBeNull();
  await page.screenshot({ path: test.info().outputPath('comparison.png') });
  await page.getByRole('button', { name: 'Apply Editorial Forest' }).click();
  await expect(page.getByTestId('original')).toContainText('Proposed Editorial Forest');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.getByTestId('original')).toContainText('Original');
  expect(await page.evaluate(() => (window as any).operations)).toEqual(['generate:editorial-forest', 'commit', 'commit']);
  expect(errors).toEqual([]);
});

test('gallery uses 34 real static template covers with no per-card frames or external font requests', async ({ page }) => {
  const externalFonts: string[] = [];
  page.on('request', request => { if (/fonts\.(googleapis|gstatic)\.com/.test(request.url())) externalFonts.push(request.url()); });
  await page.goto('/__slide-styles-qc');
  await page.getByRole('tab', { name: 'Styles' }).click();
  const covers = page.locator('img.slide-style-thumbnail');
  await expect(covers).toHaveCount(34);
  await covers.evaluateAll(async images => {
    await Promise.all(images.map(async image => {
      const img = image as HTMLImageElement; img.loading = 'eager'; await img.decode();
    }));
  });
  expect(await covers.evaluateAll(images => images.every(image => (image as HTMLImageElement).naturalWidth === 960))).toBe(true);
  await expect(page.locator('iframe')).toHaveCount(0);
  expect(externalFonts).toEqual([]);
  await page.screenshot({ path: test.info().outputPath('template-gallery.png') });
  await page.getByRole('button', { name: 'Explore Editorial Forest', exact: true }).click();
  await expect(page.getByRole('img', { name: 'Editorial Forest sample cover' })).toHaveAttribute('src', /editorial-forest\.jpg\?v=/);
  await expect(page.getByText(/^Template sample · Source Serif 4/)).toBeVisible();
  await page.getByRole('img', { name: 'Editorial Forest sample cover' }).evaluate((img: HTMLImageElement) => img.decode());
  await expect(page.getByRole('heading', { name: 'Editorial Forest', exact: true })).toBeInViewport();
  expect(await page.evaluate(() => (window as any).operations)).toEqual([]);
  await page.screenshot({ path: test.info().outputPath('template-detail.png') });
});

test('stale apply leaves a concurrent edit untouched', async ({ page }) => {
  await page.goto('/__slide-styles-qc'); await page.getByRole('button', { name: 'Browse from chat' }).click();
  await page.getByRole('button', { name: 'Explore Editorial Forest', exact: true }).click();
  await page.getByRole('button', { name: 'Preview on my deck' }).click();
  await expect(page.getByRole('button', { name: 'Apply Editorial Forest' })).toBeVisible();
  await page.getByRole('button', { name: 'Simulate concurrent edit' }).click();
  await page.getByRole('button', { name: 'Apply Editorial Forest' }).click();
  await expect(page.getByRole('alert')).toContainText('deck changed');
  await page.getByRole('tab', { name: 'Preview', exact: true }).click();
  await expect(page.getByTestId('original')).toContainText('Concurrent change');
  expect(await page.evaluate(() => (window as any).operations)).toEqual(['generate:editorial-forest']);
});

test('narrow gallery supports keyboard tabs, empty search, and read-only browsing', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await page.goto('/__slide-styles-qc?readonly&light');
  await page.getByRole('tab', { name: 'Preview', exact: true }).focus(); await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', { name: 'Styles' })).toBeFocused();
  await page.getByRole('searchbox').fill('no matching template'); await expect(page.getByText('No matching styles.')).toBeVisible();
  await page.getByRole('searchbox').fill(''); await page.getByRole('button', { name: 'Explore Editorial Forest', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Preview on my deck' })).toBeDisabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  await page.screenshot({ path: test.info().outputPath('mobile.png') });
});

test('generation errors are actionable and retryable', async ({ page }) => {
  await page.goto('/__slide-styles-qc?fail'); await page.getByRole('tab', { name: 'Styles' }).click();
  await page.getByRole('button', { name: 'Explore Editorial Forest', exact: true }).click();
  await page.getByRole('button', { name: 'Preview on my deck' }).click();
  await expect(page.getByRole('alert')).toContainText('Preview generation failed');
  await expect(page.getByRole('button', { name: 'Preview on my deck' })).toBeEnabled();
});

test('a gallery opened by an agent choice resumes that choice without launching a new preview run', async ({ page }) => {
  await page.goto('/__slide-styles-qc?choose');
  await page.getByRole('button', { name: 'Explore Editorial Forest', exact: true }).click();
  await page.getByRole('button', { name: 'Use this style & continue' }).click();
  expect(await page.evaluate(() => (window as any).operations)).toEqual(['choose:editorial-forest']);
});

test('the real chat style chooser opens the gallery and receives the chosen catalog identity', async ({ page }) => {
  await page.goto('/__slide-styles-qc?interaction');
  await page.getByRole('button', { name: 'Browse all styles', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'Styles' })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('button', { name: 'Explore Editorial Forest', exact: true }).click();
  await page.getByRole('button', { name: 'Use this style & continue' }).click();
  const operations = await page.evaluate(() => (window as any).operations);
  expect(operations).toHaveLength(1);
  expect(operations[0].interactionId).toBe('style-choice-1');
  expect(operations[0].values.selectedChoiceId).toBe('editorial-forest');
  expect(operations[0].values.designPath).toContain('editorial-forest/design.md');
  expect(operations[0].message).toContain('do not restart');
});
