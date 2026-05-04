declare module 'react-syntax-highlighter/dist/esm/light' {
  import * as React from 'react';
  import type { SyntaxHighlighterProps } from 'react-syntax-highlighter';

  export default class SyntaxHighlighter extends React.Component<SyntaxHighlighterProps> {
    static registerLanguage(name: string, language: unknown): void;
  }
}

declare module 'react-syntax-highlighter/dist/esm/languages/hljs/*' {
  const language: unknown;
  export default language;
}

declare module 'react-syntax-highlighter/dist/esm/styles/hljs/*' {
  import type * as React from 'react';

  const style: { [key: string]: React.CSSProperties };
  export default style;
}
