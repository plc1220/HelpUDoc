import { Suspense, lazy } from 'react';
import { Loader2 } from 'lucide-react';
import { getLanguage } from '../../utils/editorLanguage';

const MonacoEditor = lazy(() => import('@monaco-editor/react'));

/**
 * A plain Monaco surface for governed skill draft files.
 *
 * `FileEditor` is not reusable here: it binds every document to a workspace Yjs collab
 * session. A skill draft is private to its author until it is submitted for review.
 */
export default function SkillCodeEditor({
  path,
  value,
  onChange,
  readOnly = false,
}: {
  path: string;
  value: string;
  onChange: (next: string) => void;
  readOnly?: boolean;
}) {
  return (
    <Suspense
      fallback={(
        <div className="flex h-full items-center justify-center text-slate-400">
          <Loader2 size={20} className="animate-spin" />
        </div>
      )}
    >
      <MonacoEditor
        height="100%"
        theme="vs-dark"
        path={path}
        language={getLanguage(path)}
        value={value}
        onChange={(next) => onChange(next ?? '')}
        options={{
          readOnly,
          minimap: { enabled: false },
          fontSize: 13,
          tabSize: 2,
          wordWrap: 'on',
          scrollBeyondLastLine: false,
          automaticLayout: true,
        }}
      />
    </Suspense>
  );
}
