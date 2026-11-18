import React from 'react';
import { Select, MenuItem, FormControl, InputLabel, useTheme } from '@mui/material';
import type { AgentPersona } from '../types';

interface PersonaSelectorProps {
  personas: AgentPersona[];
  selectedPersona: string;
  onPersonaChange: (persona: string) => void;
  variant?: 'full' | 'compact';
}

const PersonaSelector: React.FC<PersonaSelectorProps> = ({
  personas,
  selectedPersona,
  onPersonaChange,
  variant = 'full',
}) => {
  const theme = useTheme();
  const isDarkMode = theme.palette.mode === 'dark';
  const menuProps = {
    PaperProps: {
      sx: {
        bgcolor: isDarkMode ? '#1e1e1e' : '#ffffff',
        color: isDarkMode ? '#e5e7eb' : '#111827',
        border: isDarkMode ? '1px solid #2a2a2a' : '1px solid #e5e7eb',
        boxShadow: '0 16px 40px rgba(0, 0, 0, 0.25)',
      },
    },
    MenuListProps: {
      sx: {
        paddingY: 0.5,
        '& .MuiMenuItem-root': {
          fontSize: '0.8rem',
          '&:hover': {
            bgcolor: isDarkMode ? '#333333' : '#f3f4f6',
          },
          '&.Mui-selected': {
            bgcolor: isDarkMode ? '#2a2a2a' : '#e5e7eb',
            '&:hover': {
              bgcolor: isDarkMode ? '#333333' : '#e0e7ff',
            },
          },
        },
      },
    },
  } as const;

  if (variant === 'compact') {
    return (
      <FormControl
        size="small"
        variant="standard"
        className="inline-flex"
        sx={{
          borderRadius: '9999px',
          border: '1px solid',
          borderColor: isDarkMode ? '#2a2a2a' : '#e5e7eb',
          bgcolor: isDarkMode ? '#111827' : '#f9fafb',
          paddingLeft: 1,
          paddingRight: 1,
          paddingY: 0.25,
          minWidth: 160,
        }}
      >
        <InputLabel
          shrink
          sx={{
            fontSize: '0.65rem',
            textTransform: 'uppercase',
            letterSpacing: '0.08em',
            color: isDarkMode ? '#9ca3af' : '#6b7280',
            position: 'static',
            transform: 'none',
            marginRight: 1,
          }}
        >
          Persona
        </InputLabel>
        <Select
          value={selectedPersona}
          onChange={(event) => onPersonaChange(event.target.value as string)}
          disabled={!personas.length}
          MenuProps={menuProps}
          disableUnderline
          sx={{
            fontSize: '0.8rem',
            fontWeight: 600,
            color: isDarkMode ? '#e5e7eb' : '#374151',
            '& .MuiSelect-select': {
              paddingY: 0,
              paddingX: 0.5,
            },
          }}
          aria-label="Persona"
        >
          <MenuItem value="" disabled>
            Choose persona
          </MenuItem>
          {personas.map((persona) => (
            <MenuItem key={persona.name} value={persona.name}>
              {persona.displayName || persona.name}
            </MenuItem>
          ))}
        </Select>
      </FormControl>
    );
  }
  return (
    <FormControl fullWidth>
      <InputLabel>Persona</InputLabel>
      <Select
        value={selectedPersona}
        onChange={(e) => onPersonaChange(e.target.value)}
        disabled={!personas.length}
        MenuProps={menuProps}
      >
        {personas.map((persona) => (
          <MenuItem key={persona.name} value={persona.name}>
            {persona.displayName || persona.name}
          </MenuItem>
        ))}
      </Select>
    </FormControl>
  );
};

export default PersonaSelector;
