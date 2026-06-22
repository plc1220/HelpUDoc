import { useMemo, useState } from 'react';
import {
  Image,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import type { Workspace } from '../packages/shared/src/types';

const lumoSpriteSheet = require('./assets/lumo/lumo-spritesheet.webp');

const demoWorkspace: Workspace = {
  id: 'demo',
  name: 'Demo Workspace',
  lastUsed: new Date().toISOString(),
};

type MobileView = 'chat' | 'canvas';
type SheetKind = 'workspace' | 'canvas-actions' | null;
type LumoMood = 'idle' | 'think' | 'notify' | 'wave';

type ChatMessage = {
  id: string;
  role: 'user' | 'lumo';
  text: string;
  time: string;
  mood?: LumoMood;
};

const messages: ChatMessage[] = [
  {
    id: 'm1',
    role: 'user',
    text: 'Build a sales dashboard from the workspace files and call out what changed this week.',
    time: '9:42',
  },
  {
    id: 'm2',
    role: 'lumo',
    text: 'I drafted the dashboard and pinned the key movement: revenue is up, but renewal risk rose in mid-market accounts.',
    time: '9:43',
    mood: 'notify',
  },
  {
    id: 'm3',
    role: 'user',
    text: 'Open the canvas and make it easier to review on mobile.',
    time: '9:44',
  },
  {
    id: 'm4',
    role: 'lumo',
    text: 'Canvas is ready. I kept the first screen focused on KPI movement, drivers, and the accounts that need follow-up.',
    time: '9:45',
    mood: 'wave',
  },
];

const recentItems = [
  'Revenue dashboard refresh',
  'QBR outline from call notes',
  'Contract risk summary',
];

const fileItems = [
  'sales/dashboard.spec.json',
  'sales/data/dashboard.rows.json',
  'notes/qbr-account-notes.md',
];

const chartBars = [42, 68, 51, 84, 63, 92];
const regionBars = [74, 45, 62, 89];

export default function App() {
  const [activeView, setActiveView] = useState<MobileView>('chat');
  const [activeSheet, setActiveSheet] = useState<SheetKind>(null);
  const [draft, setDraft] = useState('');

  const screen = useMemo(() => {
    if (activeView === 'canvas') {
      return (
        <CanvasScreen
          onBack={() => setActiveView('chat')}
          onOpenActions={() => setActiveSheet('canvas-actions')}
        />
      );
    }

    return (
      <ChatScreen
        draft={draft}
        onDraftChange={setDraft}
        onOpenCanvas={() => setActiveView('canvas')}
        onOpenWorkspace={() => setActiveSheet('workspace')}
      />
    );
  }, [activeView, draft]);

  return (
    <SafeAreaView style={styles.app}>
      <StatusBar barStyle="dark-content" />
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.keyboardRoot}
      >
        {screen}
      </KeyboardAvoidingView>
      <BottomSheet
        kind={activeSheet}
        onClose={() => setActiveSheet(null)}
        onOpenCanvas={() => {
          setActiveSheet(null);
          setActiveView('canvas');
        }}
      />
    </SafeAreaView>
  );
}

function ChatScreen({
  draft,
  onDraftChange,
  onOpenCanvas,
  onOpenWorkspace,
}: {
  draft: string;
  onDraftChange: (value: string) => void;
  onOpenCanvas: () => void;
  onOpenWorkspace: () => void;
}) {
  return (
    <View style={styles.screen}>
      <View style={styles.topBar}>
        <View style={styles.brandRow}>
          <LumoAvatar size={36} mood="idle" />
          <View style={styles.brandTextGroup}>
            <Text style={styles.brandName}>HelpUDoc</Text>
            <Pressable style={styles.workspacePill} onPress={onOpenWorkspace}>
              <Text style={styles.workspaceText} numberOfLines={1}>
                {demoWorkspace.name}
              </Text>
              <Text style={styles.chevron}>v</Text>
            </Pressable>
          </View>
        </View>
        <View style={styles.headerActions}>
          <HeaderButton label="Recent" onPress={onOpenWorkspace} />
          <HeaderButton label="..." onPress={onOpenWorkspace} />
        </View>
      </View>

      <ScrollView
        style={styles.chatScroll}
        contentContainerStyle={styles.chatContent}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.dayDivider}>
          <Text style={styles.dayDividerText}>Today</Text>
        </View>
        {messages.map((message) => (
          <MessageBubble key={message.id} message={message} />
        ))}
        <ArtifactCard onOpenCanvas={onOpenCanvas} />
        <View style={styles.statusCard}>
          <LumoAvatar size={30} mood="think" />
          <View style={styles.statusCopy}>
            <Text style={styles.statusTitle}>Lumo is watching the canvas</Text>
            <Text style={styles.statusText}>
              Ask for revisions from chat or while reviewing the artifact.
            </Text>
          </View>
        </View>
      </ScrollView>

      <Composer
        draft={draft}
        placeholder="Ask Lumo..."
        onDraftChange={onDraftChange}
      />
    </View>
  );
}

function CanvasScreen({
  onBack,
  onOpenActions,
}: {
  onBack: () => void;
  onOpenActions: () => void;
}) {
  return (
    <View style={styles.screen}>
      <View style={styles.canvasTopBar}>
        <Pressable style={styles.backButton} onPress={onBack}>
          <Text style={styles.backButtonText}>{'<'}</Text>
        </Pressable>
        <View style={styles.canvasTitleGroup}>
          <Text style={styles.canvasEyebrow}>Artifact canvas</Text>
          <Text style={styles.canvasTitle}>Sales Dashboard</Text>
        </View>
        <Pressable style={styles.moreButton} onPress={onOpenActions}>
          <Text style={styles.moreButtonText}>...</Text>
        </Pressable>
      </View>

      <ScrollView
        style={styles.canvasScroll}
        contentContainerStyle={styles.canvasContent}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.canvasHero}>
          <View style={styles.heroTitleRow}>
            <View>
              <Text style={styles.heroEyebrow}>Weekly sales pack</Text>
              <Text style={styles.heroTitle}>Sales Dashboard</Text>
            </View>
            <View style={styles.zoomPill}>
              <Text style={styles.zoomText}>Fit</Text>
              <Text style={styles.zoomDivider}>/</Text>
              <Text style={styles.zoomText}>100%</Text>
            </View>
          </View>
          <View style={styles.kpiGrid}>
            <KpiCard label="Revenue" value="$482K" trend="+12.4%" tone="good" />
            <KpiCard label="Renewal risk" value="18" trend="+5 acct" tone="warn" />
            <KpiCard label="Pipeline" value="$1.8M" trend="+7.1%" tone="good" />
          </View>
        </View>

        <View style={styles.filterRow}>
          {['All regions', 'Q3', 'Mid-market'].map((item) => (
            <View key={item} style={styles.filterChip}>
              <Text style={styles.filterChipText}>{item}</Text>
            </View>
          ))}
        </View>

        <ChartCard
          title="Revenue trend"
          subtitle="New business offset renewal pressure."
          bars={chartBars}
        />
        <ChartCard
          title="Regional drivers"
          subtitle="West accounts carried most of the weekly gain."
          bars={regionBars}
        />

        <View style={styles.tableCard}>
          <Text style={styles.cardTitle}>Accounts to review</Text>
          {['Acme Health', 'Northstar Labs', 'Bluepeak Systems'].map((account, index) => (
            <View key={account} style={styles.tableRow}>
              <Text style={styles.tableIndex}>{index + 1}</Text>
              <View style={styles.tableCopy}>
                <Text style={styles.tableName}>{account}</Text>
                <Text style={styles.tableMeta}>
                  Renewal risk / Owner follow-up due this week
                </Text>
              </View>
              <Text style={styles.tableAction}>Open</Text>
            </View>
          ))}
        </View>
      </ScrollView>

      <View style={styles.canvasComposer}>
        <LumoAvatar size={30} mood="idle" />
        <TextInput
          style={styles.canvasInput}
          placeholder="Ask about this artifact"
          placeholderTextColor="#64748b"
        />
        <Pressable style={styles.canvasSendButton}>
          <Text style={styles.canvasSendText}>Ask</Text>
        </Pressable>
      </View>
    </View>
  );
}

function MessageBubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === 'user';

  return (
    <View style={[styles.messageRow, isUser ? styles.userMessageRow : styles.lumoMessageRow]}>
      {!isUser ? <LumoAvatar size={32} mood={message.mood || 'idle'} /> : null}
      <View style={[styles.messageBubble, isUser ? styles.userBubble : styles.lumoBubble]}>
        {!isUser ? <Text style={styles.bubbleLabel}>Lumo</Text> : null}
        <Text style={[styles.messageText, isUser ? styles.userMessageText : styles.lumoMessageText]}>
          {message.text}
        </Text>
        <Text style={[styles.messageTime, isUser ? styles.userMessageTime : styles.lumoMessageTime]}>
          {message.time}
        </Text>
      </View>
    </View>
  );
}

function ArtifactCard({ onOpenCanvas }: { onOpenCanvas: () => void }) {
  return (
    <View style={styles.artifactCard}>
      <View style={styles.artifactHeader}>
        <View>
          <Text style={styles.artifactEyebrow}>Artifact ready</Text>
          <Text style={styles.artifactTitle}>Sales Dashboard</Text>
        </View>
        <View style={styles.artifactBadge}>
          <Text style={styles.artifactBadgeText}>Canvas</Text>
        </View>
      </View>
      <View style={styles.previewChart}>
        {chartBars.map((height, index) => (
          <View key={index} style={styles.previewBarTrack}>
            <View style={[styles.previewBar, { height }]} />
          </View>
        ))}
      </View>
      <Text style={styles.artifactSummary}>
        3 KPI cards, 2 driver charts, and a review table are ready for mobile inspection.
      </Text>
      <View style={styles.artifactActions}>
        <Pressable style={styles.primaryButton} onPress={onOpenCanvas}>
          <Text style={styles.primaryButtonText}>Open canvas</Text>
        </Pressable>
        <Pressable style={styles.secondaryButton}>
          <Text style={styles.secondaryButtonText}>Share</Text>
        </Pressable>
      </View>
    </View>
  );
}

function Composer({
  draft,
  placeholder,
  onDraftChange,
}: {
  draft: string;
  placeholder: string;
  onDraftChange: (value: string) => void;
}) {
  return (
    <View style={styles.composerShell}>
      <View style={styles.composer}>
        <View style={styles.composerTopRow}>
          <ComposerButton label="+" />
          <ComposerButton label="/" />
          <ComposerButton label="Web" active />
          <TextInput
            style={styles.composerInput}
            value={draft}
            placeholder={placeholder}
            placeholderTextColor="#64748b"
            onChangeText={onDraftChange}
            multiline
          />
          <Pressable style={styles.sendButton}>
            <Text style={styles.sendButtonText}>Send</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

function BottomSheet({
  kind,
  onClose,
  onOpenCanvas,
}: {
  kind: SheetKind;
  onClose: () => void;
  onOpenCanvas: () => void;
}) {
  const visible = kind !== null;
  const title = kind === 'canvas-actions' ? 'Canvas actions' : 'Workspace';

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.sheetBackdrop} onPress={onClose} />
      <View style={styles.sheet}>
        <View style={styles.sheetHandle} />
        <View style={styles.sheetHeader}>
          <Text style={styles.sheetTitle}>{title}</Text>
          <Pressable style={styles.sheetClose} onPress={onClose}>
            <Text style={styles.sheetCloseText}>Close</Text>
          </Pressable>
        </View>

        {kind === 'canvas-actions' ? (
          <View style={styles.sheetBody}>
            <SheetAction label="Ask Lumo to revise" detail="Keep the canvas open and send a revision request." />
            <SheetAction label="Share artifact" detail="Prepare a link for review." />
            <SheetAction label="Download package" detail="Export the current dashboard files." />
            <SheetAction label="Reload data" detail="Refresh the canvas preview." />
          </View>
        ) : (
          <View style={styles.sheetBody}>
            <View style={styles.searchBox}>
              <Text style={styles.searchText}>Search workspace...</Text>
            </View>
            <Text style={styles.sheetSectionTitle}>Recent</Text>
            {recentItems.map((item) => (
              <Pressable key={item} style={styles.sheetItem}>
                <View style={styles.sheetItemIcon}>
                  <Text style={styles.sheetItemIconText}>R</Text>
                </View>
                <Text style={styles.sheetItemText}>{item}</Text>
              </Pressable>
            ))}
            <Text style={styles.sheetSectionTitle}>Files</Text>
            {fileItems.map((item) => (
              <Pressable key={item} style={styles.sheetItem}>
                <View style={styles.sheetItemIcon}>
                  <Text style={styles.sheetItemIconText}>F</Text>
                </View>
                <Text style={styles.sheetItemText}>{item}</Text>
              </Pressable>
            ))}
            <View style={styles.sheetActionRow}>
              <Pressable style={styles.primaryButton} onPress={onOpenCanvas}>
                <Text style={styles.primaryButtonText}>Open canvas</Text>
              </Pressable>
              <Pressable style={styles.secondaryButton}>
                <Text style={styles.secondaryButtonText}>Upload</Text>
              </Pressable>
            </View>
          </View>
        )}
      </View>
    </Modal>
  );
}

function LumoAvatar({ size, mood = 'idle' }: { size: number; mood?: LumoMood }) {
  const frameWidth = Math.round(size * 0.88);
  const frameHeight = Math.round(frameWidth * (208 / 192));
  const frame = getLumoFrame(mood);

  return (
    <View style={[styles.lumoShell, { width: size, height: size, borderRadius: size / 2 }]}>
      <View style={[styles.lumoClip, { width: frameWidth, height: frameHeight }]}>
        <Image
          source={lumoSpriteSheet}
          resizeMode="stretch"
          style={{
            position: 'absolute',
            left: -frame.column * frameWidth,
            top: -frame.row * frameHeight,
            width: frameWidth * 8,
            height: frameHeight * 9,
          }}
        />
      </View>
    </View>
  );
}

function getLumoFrame(mood: LumoMood) {
  switch (mood) {
    case 'think':
      return { row: 6, column: 1 };
    case 'notify':
      return { row: 7, column: 1 };
    case 'wave':
      return { row: 3, column: 1 };
    default:
      return { row: 0, column: 0 };
  }
}

function HeaderButton({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable style={styles.headerButton} onPress={onPress}>
      <Text style={styles.headerButtonText}>{label}</Text>
    </Pressable>
  );
}

function ComposerButton({ label, active }: { label: string; active?: boolean }) {
  return (
    <Pressable style={[styles.composerButton, active ? styles.composerButtonActive : null]}>
      <Text style={[styles.composerButtonText, active ? styles.composerButtonTextActive : null]}>
        {label}
      </Text>
    </Pressable>
  );
}

function KpiCard({
  label,
  value,
  trend,
  tone,
}: {
  label: string;
  value: string;
  trend: string;
  tone: 'good' | 'warn';
}) {
  return (
    <View style={styles.kpiCard}>
      <Text style={styles.kpiLabel}>{label}</Text>
      <Text style={styles.kpiValue}>{value}</Text>
      <Text style={tone === 'good' ? styles.kpiTrendGood : styles.kpiTrendWarn}>{trend}</Text>
    </View>
  );
}

function ChartCard({
  title,
  subtitle,
  bars,
}: {
  title: string;
  subtitle: string;
  bars: number[];
}) {
  return (
    <View style={styles.chartCard}>
      <View style={styles.chartHeader}>
        <View>
          <Text style={styles.cardTitle}>{title}</Text>
          <Text style={styles.cardSubtitle}>{subtitle}</Text>
        </View>
      </View>
      <View style={styles.chartBody}>
        {bars.map((height, index) => (
          <View key={index} style={styles.chartTrack}>
            <View style={[styles.chartBar, { height }]} />
          </View>
        ))}
      </View>
    </View>
  );
}

function SheetAction({ label, detail }: { label: string; detail: string }) {
  return (
    <Pressable style={styles.sheetAction}>
      <Text style={styles.sheetActionTitle}>{label}</Text>
      <Text style={styles.sheetActionDetail}>{detail}</Text>
    </Pressable>
  );
}

const colors = {
  appBg: '#eef2f7',
  surface: '#ffffff',
  surfaceSoft: '#f8fafc',
  border: '#d8e0ea',
  borderSoft: '#e5eaf1',
  text: '#0f172a',
  textMuted: '#64748b',
  textSoft: '#94a3b8',
  accent: '#315f9f',
  accentDark: '#284f86',
  accentSoft: '#e8f1ff',
  slate: '#111827',
  success: '#138a56',
  warning: '#b45309',
};

const styles = StyleSheet.create({
  app: {
    flex: 1,
    backgroundColor: colors.appBg,
  },
  keyboardRoot: {
    flex: 1,
  },
  screen: {
    flex: 1,
    backgroundColor: colors.appBg,
  },
  topBar: {
    minHeight: 72,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    backgroundColor: 'rgba(255,255,255,0.96)',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  brandRow: {
    minWidth: 0,
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
  },
  brandTextGroup: {
    minWidth: 0,
    marginLeft: 10,
  },
  brandName: {
    color: colors.text,
    fontSize: 17,
    fontWeight: '800',
    letterSpacing: 0,
  },
  workspacePill: {
    maxWidth: 190,
    marginTop: 3,
    flexDirection: 'row',
    alignItems: 'center',
  },
  workspaceText: {
    color: colors.textMuted,
    fontSize: 12,
    fontWeight: '700',
  },
  chevron: {
    marginLeft: 4,
    color: colors.textSoft,
    fontSize: 11,
    fontWeight: '900',
  },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  headerButton: {
    minHeight: 36,
    minWidth: 36,
    marginLeft: 8,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.borderSoft,
    backgroundColor: colors.surface,
    paddingHorizontal: 10,
  },
  headerButtonText: {
    color: colors.textMuted,
    fontSize: 12,
    fontWeight: '800',
  },
  chatScroll: {
    flex: 1,
  },
  chatContent: {
    paddingHorizontal: 14,
    paddingTop: 12,
    paddingBottom: 18,
  },
  dayDivider: {
    alignSelf: 'center',
    borderRadius: 999,
    backgroundColor: '#dde6f2',
    paddingHorizontal: 10,
    paddingVertical: 5,
    marginBottom: 12,
  },
  dayDividerText: {
    color: colors.textMuted,
    fontSize: 11,
    fontWeight: '800',
  },
  messageRow: {
    width: '100%',
    marginBottom: 12,
    flexDirection: 'row',
    alignItems: 'flex-end',
  },
  lumoMessageRow: {
    justifyContent: 'flex-start',
  },
  userMessageRow: {
    justifyContent: 'flex-end',
  },
  messageBubble: {
    maxWidth: '82%',
    borderRadius: 18,
    paddingHorizontal: 14,
    paddingVertical: 10,
    shadowColor: '#0f172a',
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.06,
    shadowRadius: 20,
    elevation: 2,
  },
  lumoBubble: {
    marginLeft: 8,
    borderWidth: 1,
    borderColor: colors.borderSoft,
    backgroundColor: colors.surface,
  },
  userBubble: {
    backgroundColor: colors.accent,
  },
  bubbleLabel: {
    marginBottom: 4,
    color: colors.accent,
    fontSize: 11,
    fontWeight: '900',
  },
  messageText: {
    fontSize: 14,
    lineHeight: 20,
    letterSpacing: 0,
  },
  lumoMessageText: {
    color: colors.text,
  },
  userMessageText: {
    color: '#ffffff',
  },
  messageTime: {
    marginTop: 6,
    fontSize: 10,
    fontWeight: '700',
  },
  lumoMessageTime: {
    color: colors.textSoft,
  },
  userMessageTime: {
    color: '#dbeafe',
  },
  artifactCard: {
    marginTop: 4,
    marginBottom: 12,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    padding: 14,
    shadowColor: '#0f172a',
    shadowOffset: { width: 0, height: 18 },
    shadowOpacity: 0.08,
    shadowRadius: 30,
    elevation: 3,
  },
  artifactHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  artifactEyebrow: {
    color: colors.accent,
    fontSize: 11,
    fontWeight: '900',
    textTransform: 'uppercase',
  },
  artifactTitle: {
    marginTop: 3,
    color: colors.text,
    fontSize: 17,
    fontWeight: '900',
  },
  artifactBadge: {
    borderRadius: 999,
    backgroundColor: colors.accentSoft,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  artifactBadgeText: {
    color: colors.accent,
    fontSize: 11,
    fontWeight: '900',
  },
  previewChart: {
    height: 112,
    marginTop: 14,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.borderSoft,
    backgroundColor: colors.surfaceSoft,
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  previewBarTrack: {
    width: 24,
    height: 86,
    borderRadius: 999,
    backgroundColor: '#e2e8f0',
    justifyContent: 'flex-end',
    overflow: 'hidden',
  },
  previewBar: {
    width: '100%',
    borderRadius: 999,
    backgroundColor: colors.accent,
  },
  artifactSummary: {
    marginTop: 12,
    color: colors.textMuted,
    fontSize: 13,
    lineHeight: 19,
  },
  artifactActions: {
    marginTop: 14,
    flexDirection: 'row',
    alignItems: 'center',
  },
  primaryButton: {
    minHeight: 40,
    borderRadius: 11,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 14,
  },
  primaryButtonText: {
    color: '#ffffff',
    fontSize: 13,
    fontWeight: '900',
  },
  secondaryButton: {
    minHeight: 40,
    marginLeft: 8,
    borderRadius: 11,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 14,
  },
  secondaryButtonText: {
    color: colors.textMuted,
    fontSize: 13,
    fontWeight: '900',
  },
  statusCard: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#cfe0f7',
    backgroundColor: '#f4f8ff',
    padding: 12,
  },
  statusCopy: {
    flex: 1,
    marginLeft: 10,
  },
  statusTitle: {
    color: colors.text,
    fontSize: 13,
    fontWeight: '900',
  },
  statusText: {
    marginTop: 2,
    color: colors.textMuted,
    fontSize: 12,
    lineHeight: 17,
  },
  composerShell: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    backgroundColor: 'rgba(255,255,255,0.96)',
    paddingHorizontal: 12,
    paddingTop: 10,
    paddingBottom: 12,
  },
  composer: {
    borderRadius: 18,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    padding: 8,
  },
  composerTopRow: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'flex-end',
  },
  composerButton: {
    minWidth: 34,
    height: 34,
    marginRight: 6,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surfaceSoft,
  },
  composerButtonActive: {
    backgroundColor: colors.accentSoft,
  },
  composerButtonText: {
    color: colors.textMuted,
    fontSize: 12,
    fontWeight: '900',
  },
  composerButtonTextActive: {
    color: colors.accent,
  },
  composerInput: {
    flex: 1,
    minHeight: 34,
    maxHeight: 96,
    paddingHorizontal: 6,
    paddingVertical: 7,
    color: colors.text,
    fontSize: 14,
    lineHeight: 18,
  },
  sendButton: {
    minHeight: 34,
    borderRadius: 10,
    backgroundColor: colors.slate,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 12,
  },
  sendButtonText: {
    color: '#ffffff',
    fontSize: 12,
    fontWeight: '900',
  },
  canvasTopBar: {
    minHeight: 68,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    backgroundColor: 'rgba(255,255,255,0.96)',
    flexDirection: 'row',
    alignItems: 'center',
  },
  backButton: {
    width: 40,
    height: 40,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.borderSoft,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  backButtonText: {
    color: colors.text,
    fontSize: 19,
    fontWeight: '900',
  },
  canvasTitleGroup: {
    flex: 1,
    marginLeft: 12,
  },
  canvasEyebrow: {
    color: colors.textMuted,
    fontSize: 11,
    fontWeight: '900',
    textTransform: 'uppercase',
  },
  canvasTitle: {
    marginTop: 2,
    color: colors.text,
    fontSize: 17,
    fontWeight: '900',
  },
  moreButton: {
    width: 40,
    height: 40,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surfaceSoft,
  },
  moreButtonText: {
    color: colors.textMuted,
    fontSize: 18,
    fontWeight: '900',
  },
  canvasScroll: {
    flex: 1,
  },
  canvasContent: {
    padding: 14,
    paddingBottom: 18,
  },
  canvasHero: {
    borderRadius: 18,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    padding: 14,
  },
  heroTitleRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
  },
  heroEyebrow: {
    color: colors.textMuted,
    fontSize: 11,
    fontWeight: '900',
    textTransform: 'uppercase',
  },
  heroTitle: {
    marginTop: 3,
    color: colors.text,
    fontSize: 21,
    fontWeight: '900',
  },
  zoomPill: {
    minHeight: 34,
    borderRadius: 999,
    backgroundColor: colors.surfaceSoft,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
  },
  zoomText: {
    color: colors.textMuted,
    fontSize: 12,
    fontWeight: '900',
  },
  zoomDivider: {
    marginHorizontal: 6,
    color: colors.textSoft,
    fontSize: 12,
    fontWeight: '900',
  },
  kpiGrid: {
    marginTop: 14,
    flexDirection: 'row',
  },
  kpiCard: {
    flex: 1,
    minHeight: 92,
    marginRight: 8,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.borderSoft,
    backgroundColor: colors.surfaceSoft,
    padding: 10,
  },
  kpiLabel: {
    color: colors.textMuted,
    fontSize: 11,
    fontWeight: '900',
  },
  kpiValue: {
    marginTop: 9,
    color: colors.text,
    fontSize: 20,
    fontWeight: '900',
  },
  kpiTrendGood: {
    marginTop: 5,
    color: colors.success,
    fontSize: 12,
    fontWeight: '900',
  },
  kpiTrendWarn: {
    marginTop: 5,
    color: colors.warning,
    fontSize: 12,
    fontWeight: '900',
  },
  filterRow: {
    marginTop: 12,
    marginBottom: 2,
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  filterChip: {
    marginRight: 8,
    marginBottom: 8,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    paddingHorizontal: 11,
    paddingVertical: 7,
  },
  filterChipText: {
    color: colors.textMuted,
    fontSize: 12,
    fontWeight: '900',
  },
  chartCard: {
    marginTop: 10,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    padding: 14,
  },
  chartHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  cardTitle: {
    color: colors.text,
    fontSize: 15,
    fontWeight: '900',
  },
  cardSubtitle: {
    marginTop: 4,
    color: colors.textMuted,
    fontSize: 12,
    lineHeight: 17,
  },
  chartBody: {
    height: 156,
    marginTop: 14,
    borderRadius: 14,
    backgroundColor: colors.surfaceSoft,
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  chartTrack: {
    width: 32,
    height: 126,
    borderRadius: 999,
    backgroundColor: '#e2e8f0',
    justifyContent: 'flex-end',
    overflow: 'hidden',
  },
  chartBar: {
    width: '100%',
    borderRadius: 999,
    backgroundColor: colors.accent,
  },
  tableCard: {
    marginTop: 10,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    padding: 14,
  },
  tableRow: {
    minHeight: 58,
    flexDirection: 'row',
    alignItems: 'center',
    borderTopWidth: 1,
    borderTopColor: colors.borderSoft,
    paddingVertical: 10,
  },
  tableIndex: {
    width: 26,
    color: colors.textSoft,
    fontSize: 12,
    fontWeight: '900',
  },
  tableCopy: {
    flex: 1,
  },
  tableName: {
    color: colors.text,
    fontSize: 13,
    fontWeight: '900',
  },
  tableMeta: {
    marginTop: 2,
    color: colors.textMuted,
    fontSize: 11,
    lineHeight: 15,
  },
  tableAction: {
    color: colors.accent,
    fontSize: 12,
    fontWeight: '900',
  },
  canvasComposer: {
    minHeight: 66,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    backgroundColor: 'rgba(255,255,255,0.97)',
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  canvasInput: {
    flex: 1,
    minHeight: 42,
    marginLeft: 10,
    borderRadius: 13,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    color: colors.text,
    paddingHorizontal: 12,
    fontSize: 14,
  },
  canvasSendButton: {
    minHeight: 42,
    marginLeft: 8,
    borderRadius: 13,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 14,
  },
  canvasSendText: {
    color: '#ffffff',
    fontSize: 13,
    fontWeight: '900',
  },
  sheetBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(15,23,42,0.32)',
  },
  sheet: {
    position: 'absolute',
    right: 0,
    bottom: 0,
    left: 0,
    maxHeight: '78%',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    paddingTop: 10,
    paddingHorizontal: 16,
    paddingBottom: 22,
  },
  sheetHandle: {
    alignSelf: 'center',
    width: 44,
    height: 5,
    borderRadius: 999,
    backgroundColor: '#cbd5e1',
  },
  sheetHeader: {
    minHeight: 56,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  sheetTitle: {
    color: colors.text,
    fontSize: 18,
    fontWeight: '900',
  },
  sheetClose: {
    minHeight: 36,
    borderRadius: 10,
    backgroundColor: colors.surfaceSoft,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 12,
  },
  sheetCloseText: {
    color: colors.textMuted,
    fontSize: 12,
    fontWeight: '900',
  },
  sheetBody: {
    paddingBottom: 6,
  },
  searchBox: {
    height: 44,
    borderRadius: 13,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceSoft,
    justifyContent: 'center',
    paddingHorizontal: 12,
  },
  searchText: {
    color: colors.textSoft,
    fontSize: 13,
    fontWeight: '700',
  },
  sheetSectionTitle: {
    marginTop: 18,
    marginBottom: 8,
    color: colors.textMuted,
    fontSize: 11,
    fontWeight: '900',
    textTransform: 'uppercase',
  },
  sheetItem: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 13,
    backgroundColor: colors.surfaceSoft,
    paddingHorizontal: 10,
    marginBottom: 8,
  },
  sheetItemIcon: {
    width: 28,
    height: 28,
    borderRadius: 9,
    backgroundColor: colors.accentSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sheetItemIconText: {
    color: colors.accent,
    fontSize: 11,
    fontWeight: '900',
  },
  sheetItemText: {
    flex: 1,
    marginLeft: 10,
    color: colors.text,
    fontSize: 13,
    fontWeight: '800',
  },
  sheetActionRow: {
    marginTop: 8,
    flexDirection: 'row',
  },
  sheetAction: {
    minHeight: 64,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.borderSoft,
    backgroundColor: colors.surfaceSoft,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginBottom: 10,
  },
  sheetActionTitle: {
    color: colors.text,
    fontSize: 14,
    fontWeight: '900',
  },
  sheetActionDetail: {
    marginTop: 4,
    color: colors.textMuted,
    fontSize: 12,
    lineHeight: 16,
  },
  lumoShell: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#eef6ff',
    borderWidth: 1,
    borderColor: '#d5e6ff',
    overflow: 'visible',
  },
  lumoClip: {
    overflow: 'hidden',
  },
});
