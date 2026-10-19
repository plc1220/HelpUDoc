import { memo } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreakTags from './remarkBreakTags';

type LumoMarkdownProps = {
  children: string;
  components: Components;
  isStreaming?: boolean;
  className?: string;
};

/** Shared renderer boundary for Lumo prose and application-rich Markdown. */
function LumoMarkdown({
  children,
  components,
  className,
}: LumoMarkdownProps) {
  return (
    <div className={`lumo-markdown lumo-markdown-rich ${className || ''}`.trim()}>
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreakTags]} components={components}>
        {children}
      </ReactMarkdown>
    </div>
  );
}

// Parsing is the expensive part of rendering a message. Re-parse only when the text,
// the component map or the class changes, not whenever the message around it renders.
export default memo(LumoMarkdown);
