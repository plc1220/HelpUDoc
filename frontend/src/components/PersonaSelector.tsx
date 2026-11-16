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
        bgcolor: isDarkMode ? 'var(--owl-espresso)' : 'var(--owl-cream)',
        color: isDarkMode ? 'var(--owl-cream)' : 'var(--owl-espresso)',
        border: isDarkMode ? '1px solid var(--owl-cocoa)' : '1px solid var(--owl-cream)',
        boxShadow: '0 16px 40px var(--color-overlay)',
      },
    },
    MenuListProps: {
      sx: {
        paddingY: 0.5,
        '& .MuiMenuItem-root': {
          fontSize: '0.8rem',
          '&:hover': {
            bgcolor: isDarkMode ? 'var(--owl-cocoa)' : 'var(--owl-cream)',
          },
          '&.Mui-selected': {
            bgcolor: isDarkMode ? 'var(--owl-cocoa)' : 'var(--owl-cream)',
            '&:hover': {
              bgcolor: isDarkMode ? 'var(--owl-cocoa)' : 'var(--owl-cream)',
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
          borderColor: isDarkMode ? 'var(--owl-cocoa)' : 'var(--owl-cream)',
          bgcolor: isDarkMode ? 'var(--owl-espresso)' : 'var(--owl-cream)',
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
            color: isDarkMode ? 'var(--owl-taupe)' : 'var(--owl-gold)',
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
            color: isDarkMode ? 'var(--owl-cream)' : 'var(--owl-cocoa)',
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
