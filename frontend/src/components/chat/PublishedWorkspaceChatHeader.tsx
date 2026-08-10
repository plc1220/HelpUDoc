import { ButtonGroup } from '@astryxdesign/core/ButtonGroup';
import { IconButton } from '@astryxdesign/core/IconButton';
import {
  ToggleButton,
  ToggleButtonGroup,
} from '@astryxdesign/core/ToggleButton';
import {
  Bot,
  ChevronRight,
  Eye,
  History,
  Maximize2,
  MessageSquareText,
  Minimize2,
  Plus,
  StickyNote,
} from 'lucide-react';
export type SharedChatMode = 'team' | 'private';

export default function PublishedWorkspaceChatHeader({
  colorMode,
  isAgentPaneVisible,
  isAgentPaneFullScreen,
  mode,
  onToggleVisibility,
  onModeChange,
  onToggleHistory,
  onNewChat,
  onOpenCollaboration,
  onToggleFullScreen,
}: {
  colorMode: 'light' | 'dark';
  isAgentPaneVisible: boolean;
  isAgentPaneFullScreen: boolean;
  mode: SharedChatMode;
  onToggleVisibility: () => void;
  onModeChange: (mode: SharedChatMode) => void;
  onToggleHistory: () => void;
  onNewChat: () => void;
  onOpenCollaboration: () => void;
  onToggleFullScreen: () => void;
}) {
  const isDarkMode = colorMode === 'dark';
  return (
    <div className={`sticky top-0 z-30 border-b px-3 py-2 backdrop-blur-md ${
      isDarkMode ? 'border-[#223047]/70 bg-[#0d1524]/95' : 'border-slate-200/80 bg-white/92'
    }`}>
      <div className="flex min-w-0 items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <IconButton
            label={isAgentPaneVisible ? 'Collapse collaboration pane' : 'Expand collaboration pane'}
            icon={(
              <ChevronRight
                size={17}
                className={`transition-transform ${isAgentPaneVisible ? '' : 'rotate-180'}`}
              />
            )}
            variant="ghost"
            size="sm"
            onClick={onToggleVisibility}
          />
          {isAgentPaneVisible ? (
            <ToggleButtonGroup
              type="single"
              value={mode}
              onChange={(value) => {
                if (value === 'team' || value === 'private') onModeChange(value);
              }}
              label="Shared workspace conversation mode"
              size="sm"
            >
              <ToggleButton
                value="team"
                label="Workspace Chat"
                icon={<MessageSquareText size={14} />}
              />
              <ToggleButton
                value="private"
                label="Private"
                icon={<Bot size={14} />}
              />
            </ToggleButtonGroup>
          ) : null}
        </div>
        {isAgentPaneVisible ? (
          <ButtonGroup label="Shared workspace chat actions" size="sm">
            <IconButton
              label="Collaboration board"
              icon={<StickyNote size={15} />}
              variant="secondary"
              onClick={onOpenCollaboration}
            />
            {mode === 'private' ? (
              <>
                <IconButton
                  label="Recent private conversations"
                  icon={<History size={15} />}
                  variant="secondary"
                  onClick={onToggleHistory}
                />
                <IconButton
                  label="Start new private chat"
                  icon={<Plus size={15} />}
                  variant="secondary"
                  onClick={onNewChat}
                />
              </>
            ) : null}
            <IconButton
              label={isAgentPaneFullScreen ? 'Exit full screen' : 'Enter full screen'}
              icon={isAgentPaneFullScreen ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
              variant="secondary"
              onClick={onToggleFullScreen}
            />
          </ButtonGroup>
        ) : null}
      </div>

      {isAgentPaneVisible && mode === 'team' ? (
        <div className={`mt-2 flex items-center gap-2 rounded-xl px-2.5 py-1.5 ${
          isDarkMode ? 'bg-slate-900 text-slate-300' : 'bg-slate-50 text-slate-600'
        }`}>
          <Eye size={13} className="shrink-0 text-blue-500" />
          <span className="text-[11px] leading-snug">
            Visible to workspace members. Lumo reads the Shared Working version.
          </span>
        </div>
      ) : null}
    </div>
  );
}
