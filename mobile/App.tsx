import { Text, View } from 'react-native';
import type { Workspace } from '../packages/shared/src/types';

const demoWorkspace: Workspace = {
  id: 'demo',
  name: 'Demo Workspace',
  lastUsed: new Date().toISOString(),
};

export default function App() {
  return (
    <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
      <Text>HelpUDoc Mobile</Text>
      <Text>{demoWorkspace.name}</Text>
    </View>
  );
}
