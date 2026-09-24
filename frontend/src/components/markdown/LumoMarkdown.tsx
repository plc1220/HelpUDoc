import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { safeMarkdownUrlTransform } from '../../utils/markdownUrls';
import { remarkEditorHtml } from '../../utils/remarkEditorHtml';

type LumoMarkdownProps = {
  children: string;
  components: Components;
  isStreaming?: boolean;
  className?: string;
};

/** Shared renderer boundary for Lumo prose and application-rich Markdown. */
export default function LumoMarkdown({
  children,
  components,
  className,
}: LumoMarkdownProps) {
  return (
    <div className={`lumo-markdown lumo-markdown-rich ${className || ''}`.trim()}>
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkEditorHtml]} components={components} urlTransform={safeMarkdownUrlTransform}>
        {children}
      </ReactMarkdown>
    </div>
  );
}
