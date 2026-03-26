import React from 'react';
import { Loader2 } from 'lucide-react';

type EditorLoadingStateProps = {
  className?: string;
  label?: string;
};

const EditorLoadingState: React.FC<EditorLoadingStateProps> = ({
  className = 'h-full',
  label = 'Loading editor...',
}) => (
  <div className={`flex items-center justify-center bg-slate-950/5 text-slate-500 ${className}`}>
    <div className="flex items-center gap-2 text-sm">
      <Loader2 size={16} className="animate-spin" />
      <span>{label}</span>
    </div>
  </div>
);

export default EditorLoadingState;
