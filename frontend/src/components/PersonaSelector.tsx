import React from 'react';
import { Select, MenuItem, FormControl, InputLabel, useTheme } from '@mui/material';
import { alpha } from '@mui/material/styles';
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
  // Read the palette rather than branch on the mode. The menu is portalled to
  // document.body, outside the Astryx <Theme> wrapper, so var(--color-*) would
  // resolve to the library defaults there — but MUI resolves theme.palette in
  // JS, so it is correct wherever the node lands.
  const theme = useTheme();
  const menuProps = {
    PaperProps: {
      sx: {
        bgcolor: theme.palette.background.paper,
        color: theme.palette.text.primary,
        border: `1px solid ${theme.palette.divider}`,
        boxShadow: theme.shadows[8],
      },
    },
    MenuListProps: {
      sx: {
        paddingY: 0.5,
        '& .MuiMenuItem-root': {
          fontSize: '0.8rem',
          '&:hover': {
            bgcolor: theme.palette.action.hover,
          },
          // Selected reads as the accent tint, the way a selected row does
          // everywhere else in the app.
          '&.Mui-selected': {
            bgcolor: alpha(theme.palette.primary.main, 0.12),
            '&:hover': {
              bgcolor: alpha(theme.palette.primary.main, 0.18),
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
          borderColor: theme.palette.divider,
          bgcolor: theme.palette.background.default,
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
            color: theme.palette.text.secondary,
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
            color: theme.palette.text.primary,
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
