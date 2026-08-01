import { Markdown } from '@astryxdesign/core/Markdown';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

type LumoMarkdownProps = {
  children: string;
  components: Components;
  isStreaming?: boolean;
  className?: string;
};

const APPLICATION_RICH_BLOCK = /```\s*(mermaid|plotly)\b|!\[[^\]]*\]\((?!https?:|data:|blob:|\/)/i;

/** Shared renderer boundary for Lumo prose and application-rich Markdown. */
export default function LumoMarkdown({
  children,
  components,
  isStreaming = false,
  className,
}: LumoMarkdownProps) {
  if (APPLICATION_RICH_BLOCK.test(children)) {
    return (
      <div className={`lumo-markdown lumo-markdown-rich ${className || ''}`.trim()}>
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
          {children}
        </ReactMarkdown>
      </div>
    );
  }

  return (
    <Markdown
      className={`lumo-markdown ${className || ''}`.trim()}
      density="compact"
      headingLevelStart={3}
      contentWidth="42rem"
      isStreaming={isStreaming}
      autolink="gfm"
    >
      {children}
    </Markdown>
  );
}
