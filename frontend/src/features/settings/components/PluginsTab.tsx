import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertCircle,
  Check,
  CheckCircle2,
  Copy,
  Database,
  FileCode2,
  KeyRound,
  RefreshCw,
  Search,
  Server,
  Wrench,
} from 'lucide-react';
import { fetchPlugins } from '../../../services/settingsApi';
import type { PluginDefinition } from '../../../types';
import { SettingsEmptyState, SettingsLoadingState, SettingsNotice } from './SettingsScaffold';

const secondaryButtonClass = 'settings-portal-button-secondary inline-flex items-center gap-2 rounded-xl px-3 py-2 text-sm font-medium transition disabled:opacity-60';

const statusLabel = (plugin: PluginDefinition) => (plugin.valid ? 'Valid' : 'Needs attention');

const ChipList = ({
  items,
  emptyLabel,
  tone = 'slate',
}: {
  items: string[];
  emptyLabel: string;
  tone?: 'slate' | 'sky' | 'emerald';
}) => {
  const toneClass = {
    slate: 'border-slate-200 bg-white text-slate-600',
    sky: 'border-sky-100 bg-sky-50 text-sky-700',
    emerald: 'border-emerald-100 bg-emerald-50 text-emerald-700',
  }[tone];

  if (!items.length) {
    return <p className="text-sm text-slate-500">{emptyLabel}</p>;
  }

  return (
    <div className="flex flex-wrap gap-2">
      {items.map((item) => (
        <span
          key={item}
          className={`rounded-lg border px-2 py-1 text-xs font-medium ${toneClass}`}
        >
          {item}
        </span>
      ))}
    </div>
  );
};

const PluginsTab = () => {
  const [plugins, setPlugins] = useState<PluginDefinition[]>([]);
  const [selectedPluginId, setSelectedPluginId] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copiedCommand, setCopiedCommand] = useState(false);

  const loadPlugins = useCallback(async () => {
    try {
      setLoading(true);
      const data = await fetchPlugins();
      setPlugins(data);
      setSelectedPluginId((current) => current && data.some((plugin) => plugin.id === current)
        ? current
        : data[0]?.id || null);
      setError(null);
    } catch (err) {
      console.error('Failed to load plugins', err);
      setError(err instanceof Error ? err.message : 'Failed to load plugins');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadPlugins();
  }, [loadPlugins]);

  const filteredPlugins = useMemo(() => {
    const query = searchTerm.trim().toLowerCase();
    if (!query) return plugins;
    return plugins.filter((plugin) => (
      plugin.id.toLowerCase().includes(query)
      || plugin.displayName.toLowerCase().includes(query)
      || (plugin.description || '').toLowerCase().includes(query)
      || plugin.defaultSkillId.toLowerCase().includes(query)
      || plugin.skillIds.some((skillId) => skillId.toLowerCase().includes(query))
    ));
  }, [plugins, searchTerm]);

  const selectedPlugin = useMemo(
    () => filteredPlugins.find((plugin) => plugin.id === selectedPluginId)
      || plugins.find((plugin) => plugin.id === selectedPluginId)
      || filteredPlugins[0]
      || plugins[0]
      || null,
    [filteredPlugins, plugins, selectedPluginId],
  );

  const launcherCommand = selectedPlugin ? `/skill ${selectedPlugin.defaultSkillId}` : '';
  const validCount = plugins.filter((plugin) => plugin.valid).length;

  const copyLauncherCommand = async () => {
    if (!launcherCommand || typeof navigator === 'undefined' || !navigator.clipboard) {
      return;
    }
    await navigator.clipboard.writeText(launcherCommand);
    setCopiedCommand(true);
    window.setTimeout(() => setCopiedCommand(false), 1500);
  };

  if (loading) {
    return (
      <div className="flex min-h-[420px] items-center justify-center">
        <SettingsLoadingState label="Loading plugins..." />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex min-h-[420px] items-center">
        <SettingsEmptyState
          title="Unable to load plugins"
          description={error}
          icon={AlertCircle}
          action={(
            <button
              type="button"
              onClick={() => void loadPlugins()}
              className={secondaryButtonClass}
            >
              <RefreshCw size={15} />
              Retry
            </button>
          )}
        />
      </div>
    );
  }

  if (!plugins.length) {
    return (
      <div className="flex min-h-[420px] items-center">
        <SettingsEmptyState
          title="No plugins installed"
          description="Plugin manifests are loaded from the configured plugin runtime directory."
          icon={Database}
          action={(
            <button
              type="button"
              onClick={() => void loadPlugins()}
              className={secondaryButtonClass}
            >
              <RefreshCw size={15} />
              Refresh
            </button>
          )}
        />
      </div>
    );
  }

  return (
    <div className="grid min-h-[560px] gap-6 xl:grid-cols-[22rem_minmax(0,1fr)]">
      <aside className="settings-soft-panel flex min-h-0 flex-col rounded-2xl border border-slate-200">
        <div className="border-b border-slate-200 p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Plugins</p>
              <p className="mt-1 text-sm text-slate-600">{validCount} of {plugins.length} valid</p>
            </div>
            <button
              type="button"
              onClick={() => void loadPlugins()}
              className="rounded-xl p-2 text-slate-500 transition hover:bg-white hover:text-slate-900"
              title="Refresh plugins"
              aria-label="Refresh plugins"
            >
              <RefreshCw size={16} />
            </button>
          </div>
          <div className="relative mt-4">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              value={searchTerm}
              onChange={(event) => setSearchTerm(event.target.value)}
              placeholder="Search plugins"
              className="settings-control w-full rounded-xl py-2 pl-9 pr-3 text-sm"
            />
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          {filteredPlugins.length ? (
            <div className="space-y-2">
              {filteredPlugins.map((plugin) => {
                const selected = selectedPlugin?.id === plugin.id;
                return (
                  <button
                    key={plugin.id}
                    type="button"
                    onClick={() => setSelectedPluginId(plugin.id)}
                    className={`w-full rounded-2xl border px-3 py-3 text-left transition ${
                      selected
                        ? 'settings-selection-card settings-selection-card-active text-slate-900'
                        : 'settings-selection-card text-slate-900'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold">{plugin.displayName}</p>
                        <p className="mt-1 truncate font-mono text-xs text-slate-500">{plugin.id}</p>
                      </div>
                      <span className={`mt-1 h-2.5 w-2.5 shrink-0 rounded-full ${plugin.valid ? 'bg-emerald-500' : 'bg-amber-500'}`} />
                    </div>
                    {plugin.description ? (
                      <p className="mt-2 line-clamp-2 text-xs leading-5 text-slate-500">{plugin.description}</p>
                    ) : null}
                    <div className="mt-3 flex flex-wrap gap-1.5 text-[11px]">
                      <span className="rounded-md bg-white px-1.5 py-0.5 font-mono text-slate-600">{plugin.skillIds.length} skills</span>
                      <span className="rounded-md bg-white px-1.5 py-0.5 font-mono text-slate-600">{plugin.mcpServers.length} MCP</span>
                    </div>
                  </button>
                );
              })}
            </div>
          ) : (
            <div className="py-12 text-center text-sm text-slate-500">No plugins match your search.</div>
          )}
        </div>
      </aside>

      {selectedPlugin ? (
        <section className="min-w-0 space-y-6">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-2xl font-semibold tracking-tight text-slate-950">{selectedPlugin.displayName}</h3>
                <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ${
                  selectedPlugin.valid
                    ? 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-100'
                    : 'bg-amber-50 text-amber-700 ring-1 ring-amber-100'
                }`}
                >
                  {selectedPlugin.valid ? <CheckCircle2 size={13} /> : <AlertCircle size={13} />}
                  {statusLabel(selectedPlugin)}
                </span>
              </div>
              {selectedPlugin.description ? (
                <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">{selectedPlugin.description}</p>
              ) : null}
            </div>
            <Link
              to="/settings/users"
              className={secondaryButtonClass}
            >
              <KeyRound size={15} />
              Manage access
            </Link>
          </div>

          <div className="grid gap-3 md:grid-cols-3">
            <div className="rounded-2xl border border-slate-200 bg-white p-4">
              <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">
                <Database size={14} />
                Skills
              </div>
              <p className="mt-3 text-2xl font-semibold text-slate-950">{selectedPlugin.skillIds.length}</p>
            </div>
            <div className="rounded-2xl border border-slate-200 bg-white p-4">
              <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">
                <Server size={14} />
                MCP Servers
              </div>
              <p className="mt-3 text-2xl font-semibold text-slate-950">{selectedPlugin.mcpServers.length}</p>
            </div>
            <div className="rounded-2xl border border-slate-200 bg-white p-4">
              <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">
                <FileCode2 size={14} />
                Scripts
              </div>
              <p className="mt-3 text-2xl font-semibold text-slate-950">{selectedPlugin.scripts?.length || 0}</p>
            </div>
          </div>

          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_18rem]">
            <div className="rounded-2xl border border-slate-200 bg-white p-4">
              <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                <div>
                  <p className="text-sm font-semibold text-slate-900">Launcher command</p>
                  <p className="mt-1 text-xs text-slate-500">Plugin launchers insert the skill directive used by the runtime.</p>
                </div>
                <button
                  type="button"
                  onClick={() => void copyLauncherCommand()}
                  disabled={!launcherCommand}
                  className={secondaryButtonClass}
                >
                  {copiedCommand ? <Check size={15} /> : <Copy size={15} />}
                  {copiedCommand ? 'Copied' : 'Copy'}
                </button>
              </div>
              <code className="mt-4 block rounded-xl border border-slate-200 bg-slate-950 px-4 py-3 font-mono text-sm text-slate-50">
                {launcherCommand}
              </code>
            </div>

            <div className="rounded-2xl border border-slate-200 bg-white p-4">
              <p className="text-sm font-semibold text-slate-900">Default skill</p>
              <p className="mt-4 rounded-xl border border-sky-100 bg-sky-50 px-3 py-2 font-mono text-sm font-semibold text-sky-700">
                {selectedPlugin.defaultSkillId}
              </p>
              <p className="mt-3 text-xs leading-5 text-slate-500">
                User visibility follows access to this skill.
              </p>
            </div>
          </div>

          {!selectedPlugin.valid && selectedPlugin.errors?.length ? (
            <SettingsNotice variant="warning">
              {selectedPlugin.errors.join(' ')}
            </SettingsNotice>
          ) : null}

          <div className="grid gap-5 xl:grid-cols-2">
            <div className="rounded-2xl border border-slate-200 bg-white p-4">
              <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-900">
                <Database size={15} />
                Bundled skills
              </div>
              <ChipList items={selectedPlugin.skillIds} emptyLabel="No skills declared." tone="sky" />
            </div>

            <div className="rounded-2xl border border-slate-200 bg-white p-4">
              <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-900">
                <Wrench size={15} />
                Tools and MCP
              </div>
              <div className="space-y-4">
                <div>
                  <p className="mb-2 text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">Tools</p>
                  <ChipList items={selectedPlugin.tools} emptyLabel="No tools declared." tone="emerald" />
                </div>
                <div>
                  <p className="mb-2 text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">MCP servers</p>
                  <ChipList items={selectedPlugin.mcpServers} emptyLabel="No MCP servers declared." />
                </div>
              </div>
            </div>

            <div className="rounded-2xl border border-slate-200 bg-white p-4 xl:col-span-2">
              <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-900">
                <FileCode2 size={15} />
                Sandbox scripts
              </div>
              <ChipList items={selectedPlugin.scripts || []} emptyLabel="No sandbox scripts declared." />
            </div>
          </div>

          <SettingsNotice>
            Users see this plugin launcher when their group grants <code className="font-mono">{selectedPlugin.defaultSkillId}</code>. Use Users to grant the plugin bundle or the default skill.
          </SettingsNotice>
        </section>
      ) : null}
    </div>
  );
};

export default PluginsTab;
