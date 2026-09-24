import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowLeft, Check, Search, Sparkles } from 'lucide-react';
import WorkspaceHtmlPreviewFrame from '../WorkspaceHtmlPreviewFrame';
import catalog from './styleCatalog.json';
import type { SlideStyle } from './slideStyleWorkflow';
import './SlideStyleBrowser.css';

export type DeckRevision = { content: string; version: number };
export type StyleDraft = { content: string; path: string; base: DeckRevision };
type Props = {
  workspaceId: string; sourcePath: string; colorMode: 'light' | 'dark';
  children: ReactNode; disabledReason?: string; openStylesToken: number;
  onGenerate: (style: SlideStyle) => Promise<StyleDraft>;
  onCommit: (content: string, base: DeckRevision) => Promise<DeckRevision>;
  onChooseStyle?: (style: SlideStyle) => Promise<void>;
};

function Sample({ style, priority = false }: { style: SlideStyle; priority?: boolean }) {
  const [failed, setFailed] = useState(false);
  if (!style.thumbnail || failed) return <div className="slide-style-thumbnail-missing">Sample unavailable</div>;
  return <img className="slide-style-thumbnail" src={style.thumbnail.src} alt={`${style.name} sample cover`}
    width={style.thumbnail.width} height={style.thumbnail.height} loading={priority ? 'eager' : 'lazy'} decoding="async"
    onError={() => setFailed(true)} />;
}

export default function SlideStyleBrowser({ workspaceId, sourcePath, colorMode, children, disabledReason, openStylesToken, onGenerate, onCommit, onChooseStyle }: Props) {
  const [view, setView] = useState<'preview' | 'gallery' | 'detail' | 'compare'>(onChooseStyle ? 'gallery' : 'preview');
  const [seenToken, setSeenToken] = useState(openStylesToken);
  if (seenToken !== openStylesToken) { setSeenToken(openStylesToken); setView('gallery'); }
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('All styles');
  const [selected, setSelected] = useState<SlideStyle | null>(null);
  const scrollSurface = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => { scrollSurface.current?.scrollTo({ top: 0 }); }, [view, selected?.id]);
  const [draft, setDraft] = useState<StyleDraft | null>(null);
  const [busy, setBusy] = useState<'generate' | 'apply' | 'undo' | null>(null);
  const lock = useRef(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [undo, setUndo] = useState<{ content: string; base: DeckRevision } | null>(null);
  const styles = catalog.filter(s => (filter === 'All styles' || s.group === filter)
    && `${s.name} ${s.description} ${s.tags.join(' ')} ${s.scheme}`.toLowerCase().includes(query.toLowerCase()));
  const perform = async (kind: 'generate' | 'apply' | 'undo') => {
    if (lock.current || disabledReason) return;
    lock.current = true; setBusy(kind); setError(''); setNotice('');
    try {
      if (kind === 'generate' && selected && onChooseStyle) {
        await onChooseStyle(selected); setView('preview'); setNotice('Style selected. The agent is continuing in chat.');
      } else if (kind === 'generate' && selected) {
        const next = await onGenerate(selected); setDraft(next); setView('compare');
      } else if (kind === 'apply' && draft) {
        const saved = await onCommit(draft.content, draft.base);
        setUndo({ content: draft.base.content, base: saved }); setDraft(null); setView('preview');
        setNotice('Style applied to the existing deck. A previous version is saved.');
      } else if (kind === 'undo' && undo) {
        await onCommit(undo.content, undo.base); setUndo(null); setDraft(null); setView('preview');
        setNotice('Previous style restored.');
      }
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Something went wrong. Please try again.'); }
    finally { lock.current = false; setBusy(null); }
  };
  const blocked = Boolean(disabledReason || busy);
  return <div className="slide-style-browser" data-theme={colorMode}>
    <div className="slide-style-tabs" role="tablist" aria-label="Slide workspace views">
      {(['preview', 'gallery'] as const).map(tab => <button key={tab} role="tab" id={`slide-tab-${tab}`} aria-controls={`slide-panel-${tab}`}
        aria-selected={tab === 'preview' ? view === 'preview' : view !== 'preview'} tabIndex={(tab === 'preview') === (view === 'preview') ? 0 : -1}
        onKeyDown={event => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) { event.preventDefault(); const next = event.key === 'Home' ? 'preview' : event.key === 'End' ? 'gallery' : tab === 'preview' ? 'gallery' : 'preview'; setView(next); document.getElementById(`slide-tab-${next}`)?.focus(); } }}
        onClick={() => setView(tab)}>{tab === 'preview' ? 'Preview' : 'Styles'}{tab === 'gallery' && <Sparkles size={12} />}</button>)}
      {busy === 'generate' && <span role="status">Agent is preparing your preview…</span>}
    </div>
    {(notice || error) && <div className={`slide-style-notice ${error ? 'error' : ''}`} role={error ? 'alert' : 'status'}>
      <span>{error || notice}</span>{undo && !error && <button disabled={blocked} onClick={() => void perform('undo')}>Undo</button>}
      <button aria-label="Dismiss style notification" onClick={() => { setNotice(''); setError(''); }}>×</button>
    </div>}
    <div id="slide-panel-preview" role="tabpanel" aria-labelledby="slide-tab-preview" hidden={view !== 'preview'} className="slide-style-original">{children}</div>
    {view !== 'preview' && <div id="slide-panel-gallery" role="tabpanel" aria-labelledby="slide-tab-gallery" className="slide-style-surface">
      <div className="slide-style-scroll" ref={scrollSurface}>
        {view === 'gallery' ? <>
          <div className="slide-style-heading"><div><h2>Find your deck’s next look.</h2><p>Same story. A different feeling.</p></div><span>{catalog.length} styles</span></div>
          <label className="slide-style-search"><Search size={16} /><input type="search" aria-label="Search slide styles" placeholder="Search a style, mood, or color…" value={query} onChange={e => setQuery(e.target.value)} /></label>
          <div className="slide-style-filters" aria-label="Style categories">{['All styles', 'Editorial', 'Minimal', 'Professional', 'Bold'].map(f => <button key={f} aria-pressed={filter === f} onClick={() => setFilter(f)}>{f}</button>)}</div>
          <p className="slide-style-caption">{styles.length} styles · Sample covers from the template design specifications</p>
          <div className="slide-style-grid">{styles.map(s => <button className="slide-style-card" key={s.id} onClick={() => { setSelected(s); setDraft(null); setError(''); setView('detail'); }} aria-label={`Explore ${s.name}`}>
            <Sample style={s} /><span className="slide-style-card-title">{s.name}<span className="slide-style-swatches">{s.palette.slice(0, 3).map(c => <i key={c} style={{ background: c }} />)}</span></span><span className="slide-style-card-tags">{s.tags.slice(0, 3).join(' · ')}</span>
          </button>)}</div>
          {!styles.length && <p className="slide-style-empty">No matching styles. Try another search or category.</p>}
          <p className="slide-style-caption safe"><Check size={14} /> Browsing never changes your deck.</p>
        </> : selected && <>
          <button className="slide-style-back" disabled={Boolean(busy)} onClick={() => setView(view === 'compare' ? 'detail' : 'gallery')}><ArrowLeft size={14} />{view === 'compare' ? selected.name : 'All styles'}</button>
          <h2>{view === 'compare' ? 'A new look. Still your story.' : selected.name}</h2>
          <p className="slide-style-description">{view === 'compare' ? 'Review the agent-generated draft. Your existing deck is unchanged.' : selected.description}</p>
          {view === 'compare' && draft ? <div className="slide-style-comparison">
            <div><h3>Current deck</h3><WorkspaceHtmlPreviewFrame workspaceId={workspaceId} path={sourcePath} html={draft.base.content} title="Current slide deck" className="slide-style-frame" /></div>
            <div><h3>Proposed · {selected.name}</h3><WorkspaceHtmlPreviewFrame workspaceId={workspaceId} path={draft.path} html={draft.content} title="Proposed slide deck" className="slide-style-frame proposed" /></div>
          </div> : <><div className="slide-style-large-sample"><Sample key={selected.id} style={selected} priority /></div><p className="slide-style-caption">Template sample · {selected.thumbnail?.fonts.join(' + ')} · Preview on your deck to see your own content</p></>}
          <div className="slide-style-context"><strong>{onChooseStyle ? 'Continue the current style-selection step' : 'Editing the existing deck'}</strong><span>{sourcePath}</span><p>{onChooseStyle ? 'Your brief and completed choices stay in context. Choosing a style resumes the agent in chat.' : 'Keep content and slide order. Change typography, colors, and visual treatments — without restarting setup.'}</p></div>
        </>}
      </div>
      {view !== 'gallery' && <footer className="slide-style-actions"><div>{disabledReason || (busy === 'generate' ? 'Working with the agent. Follow progress in chat.' : onChooseStyle ? 'Use this style and continue the current agent task.' : view === 'compare' ? 'Apply to the existing file. You can undo this revision.' : 'Creates a separate draft; does not modify the original.')}</div>
        {view === 'compare' ? <button className="slide-style-primary" disabled={blocked} onClick={() => void perform('apply')}>{busy === 'apply' ? 'Applying…' : `Apply ${selected?.name}`}</button>
          : <button className="slide-style-primary" disabled={blocked} onClick={() => void perform('generate')}>{busy === 'generate' ? 'Working…' : onChooseStyle ? 'Use this style & continue →' : 'Preview on my deck →'}</button>}
      </footer>}
    </div>}
  </div>;
}
