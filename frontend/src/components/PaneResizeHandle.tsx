import type { HTMLAttributes } from 'react';

type PaneResizeHandleProps = HTMLAttributes<HTMLDivElement> & {
  disabled?: boolean;
  isDarkMode?: boolean;
  isResizing?: boolean;
};

export default function PaneResizeHandle({
  disabled = false,
  isDarkMode = false,
  isResizing = false,
  className = '',
  ...props
}: PaneResizeHandleProps) {
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      tabIndex={disabled ? -1 : 0}
      className={`group relative z-10 shrink-0 touch-none select-none ${
        disabled ? 'w-px cursor-default pointer-events-none' : 'w-px cursor-col-resize'
      } ${className}`}
      {...props}
    >
      <div
        className={`absolute inset-y-0 -left-1.5 w-3 ${disabled ? '' : 'cursor-col-resize'}`}
        aria-hidden
      />
      <div
        className={`absolute inset-y-0 left-0 w-px transition-colors ${
          isResizing
            ? 'bg-sky-500'
            : disabled
              ? isDarkMode
                ? 'bg-[#223047]'
                : 'bg-gray-200'
              : isDarkMode
                ? 'bg-[#223047] group-hover:bg-sky-500/70 group-focus-visible:bg-sky-500/70'
                : 'bg-gray-200 group-hover:bg-sky-400 group-focus-visible:bg-sky-400'
        }`}
      />
    </div>
  );
}
