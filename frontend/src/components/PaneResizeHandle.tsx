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
      aria-valuenow={undefined}
      tabIndex={disabled ? -1 : 0}
      className={`group relative z-10 shrink-0 touch-none select-none focus:outline-none focus-visible:outline-none ${
        disabled ? 'w-px cursor-default pointer-events-none' : 'w-px cursor-col-resize'
      } ${className}`}
      {...props}
    >
      <div
        className={`absolute inset-y-0 -left-1.5 w-3 ${disabled ? '' : 'cursor-col-resize'}`}
        aria-hidden
      />
      <div
        className={`absolute inset-y-0 transition-all duration-200 ${
          isResizing
            ? '-left-px w-[3px] bg-sky-500'
            : disabled
              ? isDarkMode
                ? 'left-0 w-px bg-[#223047]'
                : 'left-0 w-px bg-gray-200'
              : isDarkMode
                ? 'left-0 w-px bg-[#223047] group-hover:-left-px group-hover:w-[3px] group-hover:bg-sky-500/70 group-focus-visible:-left-px group-focus-visible:w-[3px] group-focus-visible:bg-sky-500/70'
                : 'left-0 w-px bg-gray-200 group-hover:-left-px group-hover:w-[3px] group-hover:bg-sky-400 group-focus-visible:-left-px group-focus-visible:w-[3px] group-focus-visible:bg-sky-400'
        }`}
      />
    </div>
  );
}
