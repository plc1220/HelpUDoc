import type React from 'react';

declare namespace JSX {
  interface IntrinsicElements {
    'a2ui-surface': React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement> & {
      surfaceId?: string;
      messageProcessor?: unknown;
    };
  }
}
