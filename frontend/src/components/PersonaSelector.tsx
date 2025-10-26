import React from 'react';
import { Select, MenuItem, FormControl, InputLabel } from '@mui/material';

interface Persona {
  name: string;
  displayName: string;
}

interface PersonaSelectorProps {
  personas: Persona[];
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