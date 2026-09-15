import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../../src/index.css';
import { AppThemeRoot } from '../../src/AppThemeRoot';
import { applyColorModeToDocument } from '../../src/colorMode';
applyColorModeToDocument('dark');
import TeamChatComposer from '../../src/components/chat/TeamChatComposer';
import PublishedWorkspaceChatHeader from '../../src/components/chat/PublishedWorkspaceChatHeader';
export function Fixture() {
 const [sent, setSent] = useState<unknown[]>([]);
 const [width, setWidth] = useState(280);
 return <main style={{ padding: 24, color: '#e2e8f0', background: '#0d1524', minHeight: '100vh' }}>
 <button onClick={() => setWidth(width === 280 ? 352 : 280)}>Toggle pane width</button>
 <div style={{ width, marginTop: 20, '--surface': '#172033' } as React.CSSProperties}>
 <PublishedWorkspaceChatHeader colorMode="dark" isAgentPaneVisible isAgentPaneFullScreen={false} mode="team" onToggleVisibility={() => {}} onModeChange={() => {}} onToggleHistory={() => {}} onNewChat={() => {}} onOpenCollaboration={() => {}} onToggleFullScreen={() => {}} />
 <div style={{ height: 320 }}>Lumo is working. Team messages remain available.</div>
 <TeamChatComposer disabled={false} sending={false} reply={false} options={[
 { kind: 'agent', id: 'lumo', label: 'Lumo' }, { kind: 'person', id: 'karl-1', label: 'Karl Chan' },
 { kind: 'file', id: '1', label: 'docs/proposal.md', version: 3 },
 { kind: 'skill', id: 'summarize', label: 'Summarize', description: 'Summarize the selected documents' },
 ]} onSend={async (body, references) => { setSent((items) => [...items, { body, references }]); }} />
 </div><pre aria-label="Submitted messages">{JSON.stringify(sent, null, 2)}</pre></main>;
}
createRoot(document.getElementById('root')!).render(<AppThemeRoot><Fixture /></AppThemeRoot>);
