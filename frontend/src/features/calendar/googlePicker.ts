import { calendarApi } from './calendarApi';
type PickerResponse = { action: string; docs?: Array<{ id: string }> };
type Builder = { setDeveloperKey: (key: string) => Builder; setAppId: (id: string) => Builder; setOAuthToken: (token: string) => Builder; setOrigin: (origin: string) => Builder; addView: (view: unknown) => Builder; setCallback: (callback: (response: PickerResponse) => void) => Builder; build: () => { setVisible: (visible: boolean) => void } };
type PickerWindow = Window & { gapi?: { load: (module: string, config: { callback: () => void; onerror: () => void }) => void }; google?: { picker: { PickerBuilder: new () => Builder; ViewId: { DOCS: string } } } };
let loader: Promise<void> | undefined;
function loadPicker() {
  return loader ||= new Promise<void>((resolve, reject) => {
    const browser = window as PickerWindow;
    const timer = window.setTimeout(() => { loader = undefined; reject(new Error('Google Drive Picker timed out')); }, 15000);
    const fail = () => { clearTimeout(timer); loader = undefined; reject(new Error('Google Drive Picker could not load')); };
    const loaded = () => { if (!browser.gapi) { fail(); return; } browser.gapi.load('picker', { callback: () => { clearTimeout(timer); resolve(); }, onerror: fail }); };
    if (browser.gapi) { loaded(); return; }
    const script = document.createElement('script'); script.src = 'https://apis.google.com/js/api.js'; script.async = true;
    script.onload = loaded; script.onerror = fail;
    document.head.appendChild(script);
  });
}
export async function chooseDriveFile(connectionId: string, beforeShow?: () => void): Promise<string | undefined> {
  const [config] = await Promise.all([calendarApi<{ access_token: string; developer_key: string; app_id: string }>(`/drive/picker?connection_id=${encodeURIComponent(connectionId)}`), loadPicker()]);
  beforeShow?.();
  // Native modal dialogs make outside iframes inert. Let the host close them
  // before Google mounts its own accessible picker, then restore them afterward.
  await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  const api = (window as PickerWindow).google!.picker;
  return new Promise(resolve => {
    new api.PickerBuilder().setDeveloperKey(config.developer_key).setAppId(config.app_id).setOAuthToken(config.access_token).setOrigin(window.location.origin).addView(api.ViewId.DOCS).setCallback(response => {
      if (response.action === 'picked') {
        const fileId = response.docs?.[0]?.id;
        const source = fileId ? btoa(JSON.stringify([connectionId, fileId])).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '') : undefined;
        resolve(source ? `source:${source}` : undefined);
      } else if (response.action === 'cancel') resolve(undefined);
    }).build().setVisible(true);
  });
}
