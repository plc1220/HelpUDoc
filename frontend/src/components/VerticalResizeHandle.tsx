import type { HTMLAttributes } from 'react';

type VerticalResizeHandleProps = HTMLAttributes<HTMLDivElement> & {
  disabled?: boolean;
  isDarkMode?: boolean;
  isResizing?: boolean;
};

export default function VerticalResizeHandle({
  disabled = false,
  isDarkMode = false,
  isResizing = false,
  className = '',
  ...props
}: VerticalResizeHandleProps) {
  return (
    <div
      role="separator"
      aria-orientation="horizontal"
      aria-label="Resize chat input"
      aria-valuenow={undefined} // can be dynamic if we track percentage, but undefined is standard for flexible layouts
      tabIndex={disabled ? -1 : 0}
      className={`group flex touch-none select-none items-center justify-center focus:outline-none focus-visible:outline-none ${
        disabled ? 'cursor-default pointer-events-none' : 'cursor-row-resize'
      } ${className}`}
      {...props}
    >
      <div
        className={`h-1 w-10 rounded-full transition-all duration-200 ${
          isResizing
            ? 'h-1.5 w-16 bg-sky-500'
            : disabled
              ? isDarkMode
                ? 'bg-slate-600'
                : 'bg-slate-300'
              : isDarkMode
                ? 'bg-slate-500/70 group-hover:h-1.5 group-hover:w-16 group-hover:bg-sky-500/70 group-focus-visible:h-1.5 group-focus-visible:w-16 group-focus-visible:bg-sky-500/70'
                : 'bg-slate-300 group-hover:h-1.5 group-hover:w-16 group-hover:bg-sky-400 group-focus-visible:h-1.5 group-focus-visible:w-16 group-focus-visible:bg-sky-400'
        }`}
        aria-hidden
      />
    </div>
  );
}
