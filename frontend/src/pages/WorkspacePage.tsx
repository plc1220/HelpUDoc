import { useState, useEffect } from 'react';
import {
  Box,
  CssBaseline,
  IconButton,
  ThemeProvider,
  createTheme,
} from '@mui/material';
import { Menu as MenuIcon } from '@mui/icons-material';
import { File as FileIcon, Edit, Trash, Star, Send, Plus, ChevronRight } from 'lucide-react';
import { getWorkspaces, createWorkspace, deleteWorkspace } from '../services/workspaceApi';
import { getFiles, createFile, updateFileContent, deleteFile, getFileContent } from '../services/fileApi';
import { runAgent } from '../services/agentApi';
import type { Workspace, File } from '../types';
import CollapsibleDrawer from '../components/CollapsibleDrawer';
import FileEditor from '../components/FileEditor';
import FileRenderer from '../components/FileRenderer';
import ExpandableSidebar from '../components/ExpandableSidebar';
import PersonaSelector from '../components/PersonaSelector';

const drawerWidth = 280;

const theme = createTheme({
  // Your theme customizations
});

interface Message {
  sender: 'user' | 'agent';
  text: string;
}

const personas = [
  { name: 'default', displayName: 'Default' },
  { name: 'writer', displayName: 'Creative Writer' },
];

export default function WorkspacePage() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [selectedWorkspace, setSelectedWorkspace] = useState<Workspace | null>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set());
  const [fileContent, setFileContent] = useState('');
  const [newWorkspaceName, setNewWorkspaceName] = useState('');
  const [messages, setMessages] = useState<Message[]>([]);
  const [chatMessage, setChatMessage] = useState('');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [selectedPersona, setSelectedPersona] = useState('default');
  const [isEditMode, setIsEditMode] = useState(false);
  const [isAgentPaneVisible, setIsAgentPaneVisible] = useState(true);

  const isFileEditable = (fileName: string): boolean => {
    const editableExtensions = ['.md', '.mermaid', '.txt', '.json', '.html', '.css', '.js', '.ts', '.tsx', '.jsx'];
    const ext = fileName.slice(fileName.lastIndexOf('.'));
    return editableExtensions.includes(ext);
  };

  const handleDrawerToggle = () => {
    setDrawerOpen(!drawerOpen);
  };


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
      const fetchFiles = async () => {
        const files = await getFiles(selectedWorkspace.id);
        setFiles(files);
      };
      fetchFiles();
    }
  }, [selectedWorkspace]);

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

  const handleSendMessage = async () => {
    if (chatMessage.trim()) {
      const userMessage: Message = { sender: 'user', text: chatMessage };
      setMessages((prevMessages) => [...prevMessages, userMessage]);
      setChatMessage('');

      try {
        const agentResponse = await runAgent(selectedPersona, chatMessage);
        const agentMessage: Message = { sender: 'agent', text: agentResponse.response };
        setMessages((prevMessages) => [...prevMessages, agentMessage]);
      } catch (error) {
        console.error('Failed to get agent response:', error);
        const errorMessage: Message = { sender: 'agent', text: 'Sorry, something went wrong.' };
        setMessages((prevMessages) => [...prevMessages, errorMessage]);
      }
    }
  };

  const handleNewChat = () => {
    setMessages([]);
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
    try {
      await updateFileContent(id, content);
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
            <div className="flex-1 flex flex-col border-r border-gray-200">
              {/* Workspace Header */}
              <div className="p-4 border-b border-gray-200">
                <h2 className="text-xl font-semibold text-gray-800">
                  {selectedWorkspace ? selectedWorkspace.name : 'No workspace selected'}
                </h2>
              </div>
              <div className="flex-1 flex">
                {/* File Explorer */}
                <div className="w-80 bg-white border-r border-gray-200 flex flex-col">
                  <div className="p-4 border-b border-gray-200 flex justify-between items-center">
                    <h3 className="text-lg font-semibold text-gray-800">Files</h3>
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
                        onClick={handleBulkDelete}
                        disabled={selectedFiles.size === 0}
                        className="p-2 rounded-lg hover:bg-gray-200 disabled:opacity-50"
                      >
                        <Trash size={18} className="text-gray-600" />
                      </button>
                    </div>
                  </div>
                  <div className="flex-1 p-4 overflow-y-auto">
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
                          setIsEditMode(file.name.endsWith('.md'));
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
            <div className={`bg-white flex flex-col transition-all duration-300 ${isAgentPaneVisible ? 'w-96' : 'w-12'}`}>
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
                  <button
                    onClick={handleNewChat}
                    className="p-2 rounded-lg hover:bg-gray-200"
                  >
                    <Plus size={18} className="text-gray-600" />
                  </button>
                )}
              </div>
              <div className={`flex-1 flex flex-col overflow-hidden ${isAgentPaneVisible ? 'block' : 'hidden'}`}>
                <div className="p-4 border-b border-gray-200">
                  <PersonaSelector
                    personas={personas}
                    selectedPersona={selectedPersona}
                    onPersonaChange={setSelectedPersona}
                  />
                </div>
                <div className="flex-1 p-4 overflow-y-auto space-y-4" style={{ maxHeight: 'calc(100vh - 250px)' }}>
                  {messages.map((message, index) => (
                    <div
                      key={index}
                      className={`flex items-start ${
                        message.sender === 'user' ? 'justify-end' : ''
                      }`}
                    >
                      {message.sender === 'agent' && (
                        <div className="w-8 h-8 rounded-full bg-blue-600 flex items-center justify-center mr-3">
                          <Star size={18} className="text-white" />
                        </div>
                      )}
                      <div
                        className={`max-w-xs p-3 rounded-lg ${
                          message.sender === 'user'
                            ? 'bg-blue-600 text-white'
                            : 'bg-gray-100 text-gray-800'
                        }`}
                      >
                        <p>{message.text}</p>
                      </div>
                    </div>
                  ))}
                </div>
                <div className="p-4 border-t border-gray-200 mt-auto">
                  <div className="relative">
                    <textarea
                      placeholder="Interact with the agent..."
                      value={chatMessage}
                      onChange={(e) => setChatMessage(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.shiftKey) {
                          e.preventDefault();
                          handleSendMessage();
                        }
                      }}
                      className="w-full pl-4 pr-12 py-3 bg-gray-100 border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none text-sm"
                      rows={3}
                      style={{ overflowY: 'auto' }}
                    />
                    <button
                      onClick={handleSendMessage}
                      className="absolute right-2 top-1/2 -translate-y-1/2 w-9 h-9 bg-blue-600 text-white rounded-full flex items-center justify-center hover:bg-blue-700 transition"
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