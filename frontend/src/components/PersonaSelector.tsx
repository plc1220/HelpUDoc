import React from 'react';
import { Select, MenuItem, FormControl, InputLabel } from '@mui/material';
import type { AgentPersona } from '../types';

interface PersonaSelectorProps {
  personas: AgentPersona[];
  selectedPersona: string;
  onPersonaChange: (persona: string) => void;
}

const PersonaSelector: React.FC<PersonaSelectorProps> = ({
  personas,
  selectedPersona,
  onPersonaChange,
}) => {
  return (
    <FormControl fullWidth>
      <InputLabel>Persona</InputLabel>
      <Select
        value={selectedPersona}
        onChange={(e) => onPersonaChange(e.target.value)}
        disabled={!personas.length}
      >
        {personas.map((persona) => (
          <MenuItem key={persona.name} value={persona.name}>
            {persona.displayName}
          </MenuItem>
        ))}
      </Select>
    </FormControl>
  );
};

export default PersonaSelector;
