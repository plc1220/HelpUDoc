import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import type { CSSProperties } from 'react';
import {
  Box,
  CssBaseline,
  IconButton,
  ThemeProvider,
  createTheme,
} from '@mui/material';
import { Menu as MenuIcon } from '@mui/icons-material';
import { File as FileIcon, Edit, Trash, Star, Send, Plus, ChevronRight, ChevronLeft, RotateCcw, Maximize2, Minimize2 } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { getWorkspaces, createWorkspace, deleteWorkspace } from '../services/workspaceApi';
import { getFiles, createFile, updateFileContent, deleteFile, getFileContent } from '../services/fileApi';
import { fetchPersonas, runAgentStream } from '../services/agentApi';
import { fetchRecentConversations, createConversation as createConversationApi, fetchConversationDetail, appendMessage as appendConversationMessage, deleteConversation as deleteConversationApi } from '../services/conversationApi';
import type { Workspace, File, AgentPersona, ConversationSummary, ConversationMessage } from '../types';
import CollapsibleDrawer from '../components/CollapsibleDrawer';
import FileEditor from '../components/FileEditor';
import FileRenderer from '../components/FileRenderer';
import ExpandableSidebar from '../components/ExpandableSidebar';
import PersonaSelector from '../components/PersonaSelector';

const drawerWidth = 280;

const theme = createTheme({
  // Your theme customizations
});

const mapMessagesToAgentHistory = (messages: ConversationMessage[]) => {
  return messages
    .filter((message) => typeof message.text === 'string' && message.text.trim().length > 0)
    .map((message) => ({
      role: message.sender === 'agent' ? 'assistant' : 'user',
      content: message.text.trim(),
    }));
};

export default function WorkspacePage() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [selectedWorkspace, setSelectedWorkspace] = useState<Workspace | null>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set());
  const [fileContent, setFileContent] = useState('');
  const [newWorkspaceName, setNewWorkspaceName] = useState('');
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [chatMessage, setChatMessage] = useState('');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [personas, setPersonas] = useState<AgentPersona[]>([]);
  const [selectedPersona, setSelectedPersona] = useState('');
  const [isEditMode, setIsEditMode] = useState(false);
  const [isAgentPaneVisible, setIsAgentPaneVisible] = useState(true);
  const [isFilePaneVisible, setIsFilePaneVisible] = useState(true);
  const [isStreaming, setIsStreaming] = useState(false);
  const [isAgentPaneFullScreen, setIsAgentPaneFullScreen] = useState(false);
  const [conversationHistory, setConversationHistory] = useState<ConversationSummary[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [activeConversationPersona, setActiveConversationPersona] = useState<string | null>(null);
  const streamAbortRef = useRef<AbortController | null>(null);
  const messagesRef = useRef<ConversationMessage[]>([]);
  const lastUserMessageRef = useRef<string>('');
  const chatInputRef = useRef<HTMLTextAreaElement | null>(null);
  const [isMentionOpen, setIsMentionOpen] = useState(false);
  const [mentionQuery, setMentionQuery] = useState('');
  const [mentionTriggerIndex, setMentionTriggerIndex] = useState<number | null>(null);
  const [mentionCursorPosition, setMentionCursorPosition] = useState<number | null>(null);
  const [mentionSelectedIndex, setMentionSelectedIndex] = useState(0);
  const mentionSuggestions = useMemo(() => {
    if (!isMentionOpen) {
      return [] as File[];
    }
    const normalized = mentionQuery.trim().toLowerCase();
    const filtered = files.filter((file) =>
      !normalized || file.name.toLowerCase().includes(normalized)
    );
    return filtered.slice(0, 8);
  }, [files, isMentionOpen, mentionQuery]);

  const agentPaneWidth = isAgentPaneFullScreen
    ? '100%'
    : isAgentPaneVisible
      ? '24rem'
      : '3rem';

  const agentPaneStyles: CSSProperties = {
    flexBasis: agentPaneWidth,
    width: agentPaneWidth,
    flexGrow: isAgentPaneFullScreen ? 1 : 0,
    flexShrink: isAgentPaneFullScreen ? 1 : 0,
    transition: 'flex-basis 0.35s ease, flex-grow 0.35s ease, width 0.35s ease',
  };

  const workspacePaneStyles: CSSProperties = {
    flexGrow: isAgentPaneFullScreen ? 0 : 1,
    flexShrink: isAgentPaneFullScreen ? 0 : 1,
    flexBasis: 0,
    opacity: isAgentPaneFullScreen ? 0 : 1,
    pointerEvents: isAgentPaneFullScreen ? 'none' : 'auto',
    transition: 'flex-grow 0.35s ease, opacity 0.35s ease',
  };

  const cancelStream = () => {
    if (streamAbortRef.current) {
      streamAbortRef.current.abort();
      streamAbortRef.current = null;
    }
    setIsStreaming(false);
  };

  const loadFilesForWorkspace = useCallback(async (workspaceId: string | null) => {
    if (!workspaceId) return;
    try {
      const files = await getFiles(workspaceId);
      setFiles(files);
    } catch (error) {
      console.error('Failed to load files for workspace', error);
    }
  }, []);

  useEffect(() => {
    return () => cancelStream();
  }, []);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    if (!isAgentPaneVisible && isAgentPaneFullScreen) {
      setIsAgentPaneFullScreen(false);
    }
  }, [isAgentPaneVisible, isAgentPaneFullScreen]);

  useEffect(() => {
    if (!selectedWorkspace || !isStreaming) {
      return;
    }
    const interval = setInterval(() => {
      loadFilesForWorkspace(selectedWorkspace.id);
    }, 3000);
    return () => clearInterval(interval);
  }, [isStreaming, selectedWorkspace, loadFilesForWorkspace]);

  useEffect(() => {
    if (!mentionSuggestions.length) {
      setMentionSelectedIndex(0);
    } else {
      setMentionSelectedIndex((current) =>
        Math.min(current, mentionSuggestions.length - 1)
      );
    }
  }, [mentionSuggestions.length]);

  const isFileEditable = (fileName: string): boolean => {
    const editableExtensions = ['.md', '.mermaid', '.txt', '.json', '.html', '.css', '.js', '.ts', '.tsx', '.jsx'];
    const ext = fileName.slice(fileName.lastIndexOf('.'));
    return editableExtensions.includes(ext);
  };

  const handleDrawerToggle = () => {
    setDrawerOpen(!drawerOpen);
  };

  const toggleAgentPaneFullScreen = () => {
    if (!isAgentPaneVisible) {
      setIsAgentPaneVisible(true);
    }
    setIsAgentPaneFullScreen((prev) => !prev);
  };

  const closeMention = useCallback(() => {
    setIsMentionOpen(false);
    setMentionQuery('');
    setMentionTriggerIndex(null);
    setMentionCursorPosition(null);
    setMentionSelectedIndex(0);
  }, []);

  useEffect(() => {
    closeMention();
  }, [closeMention, selectedWorkspace]);

  const updateMentionState = useCallback(
    (value: string, cursor: number | null | undefined) => {
      if (!selectedWorkspace || cursor === null || cursor === undefined) {
        closeMention();
        return;
      }
      const textBeforeCursor = value.slice(0, cursor);
      const mentionMatch = textBeforeCursor.match(/(^|[\s([{])@([^\s@]*)$/);
      if (!mentionMatch) {
        closeMention();
        return;
      }
      const query = mentionMatch[2] || '';
      const triggerIndex = cursor - query.length - 1; // include '@'
      setIsMentionOpen(true);
      setMentionQuery(query);
      setMentionTriggerIndex(triggerIndex);
      setMentionCursorPosition(cursor);
      setMentionSelectedIndex(0);
    },
    [closeMention, selectedWorkspace]
  );

  const handleSelectMention = useCallback(
    (file: File) => {
      if (mentionTriggerIndex === null || mentionCursorPosition === null) {
        closeMention();
        return;
      }
      const mentionText = `@${file.name}`;
      const before = chatMessage.slice(0, mentionTriggerIndex);
      const after = chatMessage.slice(mentionCursorPosition);
      const needsSpace = after.length === 0 || after.startsWith(' ') ? '' : ' ';
      const nextValue = `${before}${mentionText}${needsSpace}${after}`;
      setChatMessage(nextValue);
      closeMention();
      requestAnimationFrame(() => {
        if (chatInputRef.current) {
          const cursorPosition = before.length + mentionText.length + (needsSpace ? 1 : 0);
          chatInputRef.current.focus();
          chatInputRef.current.setSelectionRange(cursorPosition, cursorPosition);
        }
      });
    },
    [chatMessage, closeMention, mentionCursorPosition, mentionTriggerIndex]
  );

  const refreshConversationHistory = useCallback(async (workspaceId: string) => {
    try {
      const conversations = await fetchRecentConversations(workspaceId, 5);
      setConversationHistory(conversations);
      return conversations;
    } catch (error) {
      console.error('Failed to load conversation history', error);
      setConversationHistory([]);
      return [] as ConversationSummary[];
    }
  }, []);

  const loadConversationMessages = useCallback(async (conversationId: string) => {
    try {
      const detail = await fetchConversationDetail(conversationId);
      setMessages(detail.messages);
      setActiveConversationPersona(detail.conversation.persona);
    } catch (error) {
      console.error('Failed to load conversation messages', error);
      setMessages([]);
      setActiveConversationPersona(null);
    }
  }, []);

  const addLocalSystemMessage = useCallback((text: string) => {
    setMessages((prev) => [
      ...prev,
      {
        id: `local-${Date.now()}`,
        conversationId: activeConversationId || 'local',
        sender: 'agent',
        text,
        createdAt: new Date().toISOString(),
      },
    ]);
  }, [activeConversationId]);

  const ensureConversation = useCallback(async () => {
    if (activeConversationId) {
      return activeConversationId;
    }
    if (!selectedWorkspace || !selectedPersona) {
      return null;
    }
    try {
      const conversation = await createConversationApi(selectedWorkspace.id, selectedPersona);
      setActiveConversationId(conversation.id);
      setActiveConversationPersona(conversation.persona);
      setMessages([]);
      await refreshConversationHistory(selectedWorkspace.id);
      return conversation.id;
    } catch (error) {
      console.error('Failed to create conversation', error);
      return null;
    }
  }, [activeConversationId, selectedWorkspace, selectedPersona, refreshConversationHistory]);

  useEffect(() => {
    const loadConversations = async () => {
      if (!selectedWorkspace) {
        setConversationHistory([]);
        setActiveConversationId(null);
        setMessages([]);
        setActiveConversationPersona(null);
        return;
      }
      const conversations = await refreshConversationHistory(selectedWorkspace.id);
      if (conversations.length) {
        const firstConversation = conversations[0];
        setActiveConversationId(firstConversation.id);
        await loadConversationMessages(firstConversation.id);
      } else {
        setActiveConversationId(null);
        setMessages([]);
        setActiveConversationPersona(null);
      }
    };

    loadConversations();
  }, [selectedWorkspace, refreshConversationHistory, loadConversationMessages]);

  useEffect(() => {
    const loadPersonas = async () => {
      try {
        const personaList = await fetchPersonas();
        setPersonas(personaList);
        if (personaList.length) {
          setSelectedPersona((current) => current || personaList[0].name);
        }
      } catch (error) {
        console.error('Failed to load personas', error);
      }
    };
    loadPersonas();
  }, []);

  useEffect(() => {
    const fetchWorkspaces = async () => {
      const workspaces = await getWorkspaces();
      const workspacesWithMockData = workspaces.map((ws: Omit<Workspace, 'lastUsed'>) => ({
        ...ws,
        lastUsed: 'Yesterday',
      }));
      setWorkspaces(workspacesWithMockData);
    };
    fetchWorkspaces();
  }, []);

  useEffect(() => {
    if (selectedWorkspace) {
      loadFilesForWorkspace(selectedWorkspace.id);
    }
  }, [selectedWorkspace, loadFilesForWorkspace]);

  const handleRefreshFiles = () => {
    if (selectedWorkspace) {
      loadFilesForWorkspace(selectedWorkspace.id);
    }
  };

  const fetchFileContent = async () => {
    if (selectedFile && selectedWorkspace) {
      try {
        const fileWithContent = await getFileContent(selectedWorkspace.id, selectedFile.id);
        setFileContent(fileWithContent.content || '');
      } catch (error) {
        console.error('Failed to fetch file content:', error);
        setFileContent('Failed to load file content.');
      }
    } else {
      setFileContent('');
    }
  };

  useEffect(() => {
    fetchFileContent();
  }, [selectedFile, selectedWorkspace]);

  const handleRefreshFile = () => {
    fetchFileContent();
  };

  const handleCreateWorkspace = async () => {
    if (newWorkspaceName.trim()) {
      const newWorkspaceData = await createWorkspace(newWorkspaceName);
      const newWorkspace: Workspace = {
        ...newWorkspaceData,
        lastUsed: 'Just now',
      };
      setWorkspaces([...workspaces, newWorkspace]);
      setNewWorkspaceName('');
    }
  };

  const handleSelectConversationFromHistory = async (conversationId: string) => {
    cancelStream();
    setActiveConversationId(conversationId);
    await loadConversationMessages(conversationId);
    setChatMessage('');
    closeMention();
  };

  const handleDeleteConversation = useCallback(
    async (conversationId: string) => {
      try {
        await deleteConversationApi(conversationId);
        setConversationHistory((prev) => prev.filter((conversation) => conversation.id !== conversationId));
        if (activeConversationId === conversationId) {
          setActiveConversationId(null);
          setMessages([]);
          setActiveConversationPersona(null);
        }
      } catch (error) {
        console.error('Failed to delete conversation', error);
      }
    },
    [activeConversationId],
  );

  const appendAgentChunk = (index: number, chunk: string) => {
    if (!chunk || index < 0) {
      return;
    }
    setMessages((prevMessages) => {
      const updated = [...prevMessages];
      const target = updated[index];
      if (!target) {
        return updated;
      }
      let nextChunk = chunk;
      const userPrompt = lastUserMessageRef.current.trim();
      if (!target.text && userPrompt) {
        const chunkNoLeading = nextChunk.replace(/^\s+/, '');
        if (chunkNoLeading.startsWith(userPrompt)) {
          const remainder = chunkNoLeading.slice(userPrompt.length).replace(/^\s+/, '');
          if (!remainder) {
            return updated;
          }
          nextChunk = remainder;
        }
      }
      updated[index] = {
        ...target,
        text: `${target.text || ''}${nextChunk}`,
      };
      return updated;
    });
  };

  const handleRerunMessage = async (messageId: ConversationMessage['id']) => {
    if (!selectedWorkspace || !activeConversationId) {
      addLocalSystemMessage('Please select a workspace and conversation before rerunning messages.');
      return;
    }

    if (!activeConversationPersona && !selectedPersona) {
      addLocalSystemMessage('No persona selected. Please pick an agent persona.');
      return;
    }

    const persona = activeConversationPersona || selectedPersona;
    if (!persona) {
      addLocalSystemMessage('Unable to determine which persona to use for this conversation.');
      return;
    }

    const currentMessages = [...messagesRef.current];
    const targetIndex = currentMessages.findIndex((message) => message.id === messageId);
    if (targetIndex === -1) {
      addLocalSystemMessage('Could not find that message to rerun.');
      return;
    }
    const targetMessage = currentMessages[targetIndex];
    if (targetMessage.sender !== 'user') {
      addLocalSystemMessage('Only your own messages can be rerun.');
      return;
    }
    const trimmed = targetMessage.text?.trim();
    if (!trimmed) {
      addLocalSystemMessage('Cannot rerun an empty message.');
      return;
    }

    lastUserMessageRef.current = trimmed;
    cancelStream();

    const historyMessages = currentMessages.slice(0, targetIndex + 1);
    const historyPayload = mapMessagesToAgentHistory(historyMessages);

    let agentMessageIndex = -1;
    setMessages((prevMessages) => {
      const placeholder: ConversationMessage = {
        id: `agent-${Date.now()}-rerun`,
        conversationId: activeConversationId,
        sender: 'agent',
        text: '',
        createdAt: new Date().toISOString(),
      };
      const updated = [...prevMessages, placeholder];
      agentMessageIndex = updated.length - 1;
      return updated;
    });

    const controller = new AbortController();
    streamAbortRef.current = controller;
    setIsStreaming(true);

    try {
      await runAgentStream(
        selectedWorkspace.id,
        persona,
        trimmed,
        historyPayload.length ? historyPayload : undefined,
        (chunk) => {
          if (chunk.type === 'token' || chunk.type === 'chunk') {
            appendAgentChunk(agentMessageIndex, chunk.content || '');
          } else if (chunk.type === 'error') {
            appendAgentChunk(agentMessageIndex, `\n${chunk.message || 'Agent stream failed.'}`);
          }
        },
        controller.signal,
        { forceReset: true }
      );
    } catch (error) {
      if ((error as DOMException)?.name === 'AbortError') {
        appendAgentChunk(agentMessageIndex, '\n[Stream cancelled]');
      } else {
        console.error('Failed to rerun agent response', error);
        appendAgentChunk(agentMessageIndex, '\nSorry, rerun failed.');
      }
    } finally {
      setIsStreaming(false);
      streamAbortRef.current = null;
      loadFilesForWorkspace(selectedWorkspace.id);
    }

    if (agentMessageIndex >= 0) {
      const agentMessage = messagesRef.current[agentMessageIndex];
      if (agentMessage?.text) {
        try {
          const persisted = await appendConversationMessage(activeConversationId, 'agent', agentMessage.text);
          setMessages((prev) => {
            const updated = [...prev];
            updated[agentMessageIndex] = persisted;
            return updated;
          });
          await refreshConversationHistory(selectedWorkspace.id);
        } catch (error) {
          console.error('Failed to store rerun agent message', error);
        }
      }
    }
  };

  const handleSendMessage = async () => {
    const trimmed = chatMessage.trim();
    if (!trimmed) return;

    if (!selectedWorkspace) {
      addLocalSystemMessage('Please select a workspace before chatting with an agent.');
      return;
    }

    if (!selectedPersona && !activeConversationPersona) {
      addLocalSystemMessage('No persona selected. Please pick an agent persona.');
      return;
    }

    const workspaceId = selectedWorkspace.id;
    const persona = activeConversationPersona || selectedPersona;
    if (!persona) {
      addLocalSystemMessage('Unable to determine which persona to use for this conversation.');
      return;
    }

    const conversationId = await ensureConversation();
    if (!conversationId) {
      addLocalSystemMessage('Unable to start a conversation right now.');
      return;
    }

    lastUserMessageRef.current = trimmed;
    cancelStream();
    setChatMessage('');
    closeMention();

    let userMessageRecord: ConversationMessage | null = null;
    let historyPayload: Array<{ role: string; content: string }> = [];
    try {
      userMessageRecord = await appendConversationMessage(conversationId, 'user', trimmed);
      setMessages((prev) => [...prev, userMessageRecord]);
      await refreshConversationHistory(workspaceId);
      const pendingMessages = [...messagesRef.current, userMessageRecord];
      historyPayload = mapMessagesToAgentHistory(pendingMessages);
    } catch (error) {
      console.error('Failed to send user message', error);
      addLocalSystemMessage('Failed to send your message. Please try again.');
      return;
    }

    let agentMessageIndex = -1;
    setMessages((prevMessages) => {
      const updated = [
        ...prevMessages,
        {
          id: `agent-${Date.now()}`,
          conversationId,
          sender: 'agent',
          text: '',
          createdAt: new Date().toISOString(),
        },
      ];
      agentMessageIndex = updated.length - 1;
      return updated;
    });

    const controller = new AbortController();
    streamAbortRef.current = controller;
    setIsStreaming(true);

    try {
      await runAgentStream(
        workspaceId,
        persona,
        trimmed,
        historyPayload.length ? historyPayload : undefined,
        (chunk) => {
          if (chunk.type === 'token' || chunk.type === 'chunk') {
            appendAgentChunk(agentMessageIndex, chunk.content || '');
          } else if (chunk.type === 'error') {
            appendAgentChunk(agentMessageIndex, `\n${chunk.message || 'Agent stream failed.'}`);
          }
        },
        controller.signal
      );
    } catch (error) {
      if ((error as DOMException)?.name === 'AbortError') {
        appendAgentChunk(agentMessageIndex, '\n[Stream cancelled]');
      } else {
        console.error('Failed to get agent response:', error);
        appendAgentChunk(agentMessageIndex, '\nSorry, something went wrong.');
      }
    } finally {
      setIsStreaming(false);
      streamAbortRef.current = null;
      loadFilesForWorkspace(workspaceId);
    }

    if (agentMessageIndex >= 0) {
      const agentMessage = messagesRef.current[agentMessageIndex];
      if (agentMessage?.text) {
        try {
          const persisted = await appendConversationMessage(conversationId, 'agent', agentMessage.text);
          setMessages((prev) => {
            const updated = [...prev];
            updated[agentMessageIndex] = persisted;
            return updated;
          });
          await refreshConversationHistory(workspaceId);
        } catch (error) {
          console.error('Failed to store agent message', error);
        }
      }
    }
  };

  const handleChatInputChange = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = event.target.value;
    setChatMessage(value);
    updateMentionState(value, event.target.selectionStart ?? value.length);
  };

  const handleChatInputSelectionChange = (
    event: React.SyntheticEvent<HTMLTextAreaElement>
  ) => {
    const target = event.currentTarget;
    updateMentionState(target.value, target.selectionStart ?? target.value.length);
  };

  const handleChatInputKeyUp = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const target = event.currentTarget;
    updateMentionState(target.value, target.selectionStart ?? target.value.length);
  };

  const handleChatInputKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (isMentionOpen) {
      if (event.key === 'ArrowDown' && mentionSuggestions.length) {
        event.preventDefault();
        setMentionSelectedIndex((prev) => (prev + 1) % mentionSuggestions.length);
        return;
      }
      if (event.key === 'ArrowUp' && mentionSuggestions.length) {
        event.preventDefault();
        setMentionSelectedIndex((prev) =>
          (prev - 1 + mentionSuggestions.length) % mentionSuggestions.length
        );
        return;
      }
      if ((event.key === 'Enter' && !event.shiftKey) || event.key === 'Tab') {
        if (mentionSuggestions.length) {
          event.preventDefault();
          handleSelectMention(mentionSuggestions[mentionSelectedIndex]);
          return;
        }
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        closeMention();
        return;
      }
    }

    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      handleSendMessage();
    }
  };

  const handleNewChat = async () => {
    cancelStream();
    if (!selectedWorkspace) {
      addLocalSystemMessage('Please select a workspace before starting a conversation.');
      return;
    }
    if (!selectedPersona) {
      addLocalSystemMessage('No persona selected. Please pick an agent persona.');
      return;
    }
    const workspaceId = selectedWorkspace.id;
    try {
      const conversation = await createConversationApi(workspaceId, selectedPersona);
      setActiveConversationId(conversation.id);
      setActiveConversationPersona(conversation.persona);
      setMessages([]);
      setChatMessage('');
      closeMention();
      await refreshConversationHistory(workspaceId);
    } catch (error) {
      console.error('Failed to start new conversation', error);
      addLocalSystemMessage('Unable to start a new conversation right now.');
    }
  };

  const handleDeleteWorkspace = async (id: string) => {
    try {
      await deleteWorkspace(id);
      setWorkspaces(workspaces.filter((workspace) => workspace.id !== id));
      setSelectedWorkspace(null);
      setFiles([]);
    } catch (error) {
      console.error('Failed to delete workspace:', error);
    }
  };

  const handleUpdateFile = async (id: number, content: string) => {
    if (!selectedWorkspace) return;

    try {
      await updateFileContent(selectedWorkspace.id, id, content);
      // Optionally, you can refetch the file or update it in the state
    } catch (error) {
      console.error('Failed to update file:', error);
    }
  };

  const handleDeleteFile = async (id: string) => {
    if (!selectedWorkspace) return;

    const confirmed = window.confirm('Are you sure you want to delete this file?');
    if (!confirmed) {
      return;
    }

    try {
      await deleteFile(selectedWorkspace.id, id);
      setFiles((prevFiles) => prevFiles.filter((file) => file.id !== id));
      setSelectedFile(null);
    } catch (error) {
      console.error('Failed to delete file:', error);
    }
  };

  const handleBulkDelete = async () => {
    if (!selectedWorkspace) return;

    const confirmed = window.confirm(
      `Are you sure you want to delete ${selectedFiles.size} files?`
    );
    if (!confirmed) {
      return;
    }

    try {
      for (const fileId of selectedFiles) {
        await deleteFile(selectedWorkspace.id, fileId);
      }
      setFiles((prevFiles) =>
        prevFiles.filter((file) => !selectedFiles.has(file.id))
      );
      setSelectedFiles(new Set());
      setSelectedFile(null);
    } catch (error) {
      console.error('Failed to delete files:', error);
    }
  };

  const handleFileSelect = (fileId: string) => {
    const newSelectedFiles = new Set(selectedFiles);
    if (newSelectedFiles.has(fileId)) {
      newSelectedFiles.delete(fileId);
    } else {
      newSelectedFiles.add(fileId);
    }
    setSelectedFiles(newSelectedFiles);
  };

  const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    if (!selectedWorkspace || !event.target.files || event.target.files.length === 0) {
      return;
  }

  const filesToUpload = event.target.files;
  
  try {
    for (const file of filesToUpload) {
      const newFileData = await createFile(selectedWorkspace.id, file);
      setFiles((prevFiles) => [...prevFiles, newFileData]);
    }
  } catch (error) {
    console.error('Failed to upload file:', error);
  }
};
 
   return (
     <ThemeProvider theme={theme}>
      <Box sx={{ display: 'flex' }}>
        <CssBaseline />
        <ExpandableSidebar handleDrawerToggle={handleDrawerToggle} />
        <CollapsibleDrawer
          open={drawerOpen}
          handleDrawerClose={handleDrawerToggle}
          workspaces={workspaces}
          selectedWorkspace={selectedWorkspace}
          newWorkspaceName={newWorkspaceName}
          setNewWorkspaceName={setNewWorkspaceName}
          handleCreateWorkspace={handleCreateWorkspace}
          handleDeleteWorkspace={handleDeleteWorkspace}
          onSelectWorkspace={setSelectedWorkspace}
        />
        <Box
          component="main"
          sx={{
            flexGrow: 1,
            p: 3,
            transition: (theme) =>
              theme.transitions.create('margin', {
                easing: theme.transitions.easing.sharp,
                duration: theme.transitions.duration.leavingScreen,
              }),
            marginLeft: `-${drawerWidth}px`,
            ...(drawerOpen && {
              transition: (theme) =>
                theme.transitions.create('margin', {
                  easing: theme.transitions.easing.easeOut,
                  duration: theme.transitions.duration.enteringScreen,
                }),
              marginLeft: 0,
            }),
          }}
        >
          <div className="flex h-screen bg-gray-100 font-sans">
            {/* Middle Pane: Files & Editor */}
            <div
              className="flex flex-col border-r border-gray-200 min-w-0 overflow-hidden"
              style={workspacePaneStyles}
            >
              {/* Workspace Header */}
              <div className="p-4 border-b border-gray-200">
                <h2 className="text-xl font-semibold text-gray-800">
                  {selectedWorkspace ? selectedWorkspace.name : 'No workspace selected'}
                </h2>
              </div>
              <div className="flex-1 flex">
                {/* File Explorer */}
                <div className={`bg-white border-r border-gray-200 flex flex-col transition-all duration-300 ${isFilePaneVisible ? 'w-80' : 'w-12'}`}>
                  <div className="p-4 border-b border-gray-200 flex justify-between items-center">
                    <div className="flex items-center">
                      {isFilePaneVisible && <h3 className="text-lg font-semibold text-gray-800">Files</h3>}
                      <button
                        onClick={() => setIsFilePaneVisible(!isFilePaneVisible)}
                        className="p-1 border rounded-md ml-2 hover:bg-gray-100"
                      >
                        <ChevronLeft size={16} className={`text-gray-600 transition-transform duration-300 ${isFilePaneVisible ? '' : 'rotate-180'}`} />
                      </button>
                    </div>
                    {isFilePaneVisible && (
                      <div className="flex items-center space-x-2">
                        <input
                          type="file"
                          id="file-upload"
                          style={{ display: 'none' }}
                          onChange={handleFileUpload}
                          multiple
                        />
                        <button
                          onClick={() => document.getElementById('file-upload')?.click()}
                          disabled={!selectedWorkspace}
                          className="p-2 rounded-lg hover:bg-gray-200 disabled:opacity-50"
                        >
                          <Plus size={18} className="text-gray-600" />
                        </button>
                        <button
                          onClick={handleRefreshFiles}
                          disabled={!selectedWorkspace}
                          className="p-2 rounded-lg hover:bg-gray-200 disabled:opacity-50"
                          title="Refresh files"
                        >
                          <RotateCcw size={18} className="text-gray-600" />
                        </button>
                        <button
                          onClick={handleBulkDelete}
                          disabled={selectedFiles.size === 0}
                          className="p-2 rounded-lg hover:bg-gray-200 disabled:opacity-50"
                        >
                          <Trash size={18} className="text-gray-600" />
                        </button>
                      </div>
                    )}
                  </div>
                  <div className={`flex-1 p-4 overflow-y-auto ${isFilePaneVisible ? 'block' : 'hidden'}`}>
                    {files.map((file) => (
                      <div
                        key={file.id}
                        className={`flex items-center p-2 rounded-lg cursor-pointer ${
                          selectedFile?.id === file.id ? 'bg-blue-100' : 'hover:bg-gray-100'
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={selectedFiles.has(file.id)}
                          onChange={() => handleFileSelect(file.id)}
                          className="mr-3"
                        />
                        <div onClick={() => {
                          setSelectedFile(file);
                          setIsEditMode(false);
                        }} className="flex items-center flex-1">
                          <FileIcon size={18} className="mr-3 text-gray-600" />
                          <span className="text-gray-800">{file.name}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Content Editor */}
                <div className="flex-1 flex flex-col bg-gray-50 overflow-hidden min-w-0">
                  <div className="p-4 border-b border-gray-200 flex justify-between items-center">
                    <h3 className="text-lg font-semibold text-gray-800">
                      {selectedFile ? selectedFile.name : 'Editor'}
                    </h3>
                    <div className="flex items-center space-x-2">
                      <button
                        className="p-2 rounded-lg hover:bg-gray-200 disabled:opacity-50"
                        onClick={() => {
                          if (!isAgentPaneVisible) {
                            setIsAgentPaneVisible(true);
                          }
                          setIsEditMode(!isEditMode);
                        }}
                        disabled={!selectedFile || !isFileEditable(selectedFile.name)}
                      >
                        <Edit size={18} className="text-gray-600" />
                      </button>
                      <button
                        className="p-2 rounded-lg hover:bg-gray-200 disabled:opacity-50"
                        onClick={() => selectedFile && handleUpdateFile(Number(selectedFile.id), fileContent)}
                        disabled={!isEditMode}
                      >
                        Save
                      </button>
                    </div>
                  </div>
                  <div className="flex-1 overflow-y-auto overflow-x-hidden">
                    {isEditMode ? (
                      <FileEditor
                        file={selectedFile}
                        fileContent={fileContent}
                        onContentChange={setFileContent}
                      />
                    ) : (
                      <div className="h-full w-full">
                        <FileRenderer file={selectedFile} fileContent={fileContent} />
                      </div>
                    )}
                  </div>
                </div>
                </div>
              </div>

            {/* Right Pane: Agent Chat */}
            {/* Right Pane: Agent Chat */}
            <div
              className="bg-white flex flex-col overflow-hidden"
              style={agentPaneStyles}
            >
              <div className="p-4 border-b border-gray-200 flex justify-between items-center">
                <div className="flex items-center">
                  <button
                    onClick={() => setIsAgentPaneVisible(!isAgentPaneVisible)}
                    className="p-2 rounded-lg hover:bg-gray-200"
                    disabled={isEditMode}
                  >
                    <ChevronRight size={18} className={`text-gray-600 transition-transform duration-300 ${isAgentPaneVisible ? '' : 'rotate-180'}`} />
                  </button>
                  {isAgentPaneVisible && <h2 className="text-lg font-semibold text-gray-800 ml-2">Agent Chat</h2>}
                </div>
                {isAgentPaneVisible && (
                  <div className="flex items-center space-x-2">
                    <button
                      onClick={handleNewChat}
                      className="p-2 rounded-lg hover:bg-gray-200"
                    >
                      <Plus size={18} className="text-gray-600" />
                    </button>
                    <button
                      onClick={toggleAgentPaneFullScreen}
                      className="p-2 rounded-lg hover:bg-gray-200"
                    >
                      {isAgentPaneFullScreen ? (
                        <Minimize2 size={18} className="text-gray-600" />
                      ) : (
                        <Maximize2 size={18} className="text-gray-600" />
                      )}
                    </button>
                  </div>
                )}
              </div>
              <div className={`flex-1 flex flex-col overflow-hidden ${
                isAgentPaneFullScreen || isAgentPaneVisible ? 'block' : 'hidden'
              }`}>
                <div className="p-4 border-b border-gray-200">
                  <PersonaSelector
                    personas={personas}
                    selectedPersona={selectedPersona}
                    onPersonaChange={setSelectedPersona}
                  />
                </div>
                <div className="p-4 border-b border-gray-200">
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-semibold text-gray-700">Recent Conversations</p>
                  </div>
                  <div className="mt-3 space-y-2 max-h-40 overflow-y-auto">
                    {conversationHistory.length === 0 ? (
                      <p className="text-xs text-gray-500">No past conversations yet.</p>
                    ) : (
                      conversationHistory.map((conversation) => {
                        const isActive = conversation.id === activeConversationId;
                        return (
                          <div key={conversation.id} className="relative group">
                            <button
                              type="button"
                              onClick={() => handleSelectConversationFromHistory(conversation.id)}
                              className={`w-full text-left p-2 pr-9 rounded-lg border transition ${
                                isActive
                                  ? 'border-blue-500 bg-blue-50'
                                  : 'border-gray-200 hover:border-blue-400 hover:bg-blue-50'
                              }`}
                            >
                              <p className="text-sm font-medium text-gray-800 truncate">{conversation.title}</p>
                              <p className="text-xs text-gray-500">
                                Persona: {conversation.persona} · {new Date(conversation.updatedAt).toLocaleString()}
                              </p>
                            </button>
                            <button
                              type="button"
                              aria-label="Delete conversation"
                              className="absolute top-1 right-1 p-1 rounded-md text-gray-400 hover:text-red-600 hover:bg-red-50 opacity-0 group-hover:opacity-100 focus:opacity-100 transition"
                              onClick={(event) => {
                                event.stopPropagation();
                                handleDeleteConversation(conversation.id);
                              }}
                            >
                              <Trash size={14} />
                            </button>
                          </div>
                        );
                      })
                    )}
                  </div>
                </div>
                <div className="flex-1 p-4 overflow-y-auto space-y-4" style={{ maxHeight: 'calc(100vh - 250px)' }}>
                  {messages.map((message) => (
                    <div
                      key={message.id}
                      className={`flex items-start group ${
                        message.sender === 'user' ? 'justify-end' : ''
                      }`}
                    >
                      {message.sender === 'agent' && (
                        <div className="w-8 h-8 rounded-full bg-blue-600 flex items-center justify-center mr-3">
                          <Star size={18} className="text-white" />
                        </div>
                      )}
                      <div style={{ maxWidth: isAgentPaneFullScreen ? '85%' : '75%' }} className="relative">
                        <div
                          className={`w-fit p-3 rounded-lg ${
                            message.sender === 'user'
                              ? 'bg-blue-600 text-white'
                              : 'bg-gray-100 text-gray-800'
                          }`}
                        >
                          {message.sender === 'agent' ? (
                            message.text ? (
                              <div className="agent-markdown text-sm">
                                <ReactMarkdown
                                  remarkPlugins={[remarkGfm]}
                                  components={{
                                    a({ node, ...props }) {
                                      return (
                                        <a
                                          {...props}
                                          target="_blank"
                                          rel="noreferrer"
                                          className="underline decoration-white/60 hover:opacity-80"
                                        />
                                      );
                                    },
                                    code({ inline, className, children, node, ...props }) {
                                      if (inline) {
                                        return (
                                          <code
                                            className={`px-1 py-0.5 rounded bg-black/20 ${className || ''}`}
                                            {...props}
                                          >
                                            {children}
                                          </code>
                                        );
                                      }
                                      return (
                                        <pre className="bg-black/20 rounded-lg p-3 overflow-x-auto text-xs sm:text-sm">
                                          <code {...props}>{children}</code>
                                        </pre>
                                      );
                                    },
                                  }}
                                >
                                  {message.text}
                                </ReactMarkdown>
                              </div>
                            ) : (
                              <span className="text-sm opacity-70">Thinking…</span>
                            )
                          ) : (
                            <p>{message.text}</p>
                          )}
                        </div>
                        {message.sender === 'user' && (
                          <button
                            type="button"
                            onClick={() => handleRerunMessage(message.id)}
                            disabled={isStreaming}
                            title="Rerun this message"
                            className={`absolute -top-2 -right-2 p-1.5 rounded-full bg-blue-500 text-white shadow transition-opacity opacity-0 ${
                              isStreaming
                                ? 'cursor-not-allowed group-hover:opacity-60 hover:opacity-60'
                                : 'group-hover:opacity-100 hover:opacity-100 focus-visible:opacity-100'
                            }`}
                          >
                            <RotateCcw size={14} />
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
                <div className="p-4 border-t border-gray-200 mt-auto">
                  <div className="relative">
                    <textarea
                      placeholder="Interact with the agent..."
                      value={chatMessage}
                      ref={chatInputRef}
                      onChange={handleChatInputChange}
                      onKeyDown={handleChatInputKeyDown}
                      onKeyUp={handleChatInputKeyUp}
                      onSelect={handleChatInputSelectionChange}
                      className="w-full pl-4 pr-12 py-3 bg-gray-100 border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none text-sm"
                      rows={3}
                      style={{ overflowY: 'auto' }}
                    />
                    {isMentionOpen && (
                      <div className="absolute left-0 right-0 bottom-16 bg-white border border-gray-200 rounded-lg shadow-lg max-h-48 overflow-y-auto z-10">
                        {mentionSuggestions.length ? (
                          mentionSuggestions.map((file, index) => (
                            <button
                              key={file.id}
                              type="button"
                              onMouseDown={(event) => {
                                event.preventDefault();
                                handleSelectMention(file);
                              }}
                              className={`w-full flex items-center text-left px-3 py-2 text-sm hover:bg-blue-50 ${
                                index === mentionSelectedIndex ? 'bg-blue-50 text-blue-700' : 'text-gray-800'
                              }`}
                            >
                              <FileIcon size={16} className="mr-2 text-gray-500" />
                              <span className="truncate">{file.name}</span>
                            </button>
                          ))
                        ) : (
                          <div className="px-3 py-2 text-sm text-gray-500">No matching files</div>
                        )}
                      </div>
                    )}
                    <button
                      onClick={handleSendMessage}
                      disabled={isStreaming}
                      className={`absolute right-2 top-1/2 -translate-y-1/2 w-9 h-9 rounded-full flex items-center justify-center text-white transition ${
                        isStreaming ? 'bg-blue-300 cursor-not-allowed' : 'bg-blue-600 hover:bg-blue-700'
                      }`}
                    >
                      <Send size={18} />
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </Box>
      </Box>
    </ThemeProvider>
  );
}
