import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertCircle, Database, RefreshCw, Search, ShieldCheck, Wrench } from 'lucide-react';
import { fetchPlugins } from '../../../services/settingsApi';
import type { PluginDefinition } from '../../../types';
import { SettingsEmptyState, SettingsLoadingState } from './SettingsScaffold';

const cx = (...classes: Array<string | false | null | undefined>) => classes.filter(Boolean).join(' ');

const PluginsRegistryTab: React.FC = () => {
  const [plugins, setPlugins] = useState<PluginDefinition[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState('');

  const loadPlugins = useCallback(async () => {
    try {
      setLoading(true);
      const data = await fetchPlugins();
      setPlugins(data);
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
    const lower = searchTerm.trim().toLowerCase();
    const visible = plugins.filter((plugin) => plugin.skillIds.length > 0);
    if (!lower) return visible;
    return visible.filter((plugin) => {
      const searchable = [
        plugin.id,
        plugin.displayName,
        plugin.description || '',
        plugin.defaultSkillId,
        ...plugin.skillIds,
        ...plugin.tools,
        ...plugin.mcpServers,
        ...(plugin.scripts || []),
      ].join(' ').toLowerCase();
      return searchable.includes(lower);
    });
  }, [plugins, searchTerm]);

  return (
    <div className="flex h-full min-h-[640px] flex-col">
      <div className="border-b border-slate-200 bg-slate-50 p-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">Plugins</p>
            <h3 className="mt-1 text-lg font-semibold text-slate-900">Plugin registry</h3>
            <p className="mt-1 text-sm text-slate-500">Review bundled skills, tools, MCP servers, and scripts by plugin.</p>
          </div>
          <button
            type="button"
            onClick={() => void loadPlugins()}
            className="settings-portal-button-secondary inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm transition"
          >
            <RefreshCw size={15} />
            Refresh
          </button>
        </div>
        <div className="relative mt-4 max-w-xl">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            type="text"
            placeholder="Search plugins, skills, tools, or MCP servers..."
            value={searchTerm}
            onChange={(event) => setSearchTerm(event.target.value)}
            className="w-full rounded-lg border border-slate-200 bg-white py-2 pl-9 pr-3 text-sm transition-all focus:outline-none focus:ring-1 focus:ring-slate-400"
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        {loading ? <SettingsLoadingState label="Loading plugins..." /> : null}
        {!loading && error ? (
          <SettingsEmptyState
            title="Unable to load plugins"
            description={error}
            icon={AlertCircle}
            action={
              <button
                type="button"
                onClick={() => void loadPlugins()}
                className="settings-portal-button-secondary rounded-xl px-4 py-2 text-sm font-medium transition"
              >
                Retry
              </button>
            }
          />
        ) : null}
        {!loading && !error && filteredPlugins.length === 0 ? (
          <SettingsEmptyState
            title={searchTerm ? 'No plugins match your search' : 'No plugins available'}
            description={searchTerm ? 'Try a different plugin, skill, tool, or MCP server name.' : 'Installed plugins will appear here when they expose skills.'}
            icon={Database}
          />
        ) : null}
        {!loading && !error && filteredPlugins.length > 0 ? (
          <div className="grid gap-4 xl:grid-cols-2">
            {filteredPlugins.map((plugin) => {
              const toolItems = [...plugin.tools, ...plugin.mcpServers, ...(plugin.scripts || [])];
              return (
                <article key={plugin.id} className="settings-workbench-column rounded-xl border border-slate-200 bg-white p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${plugin.valid ? 'bg-emerald-500' : 'bg-amber-500'}`} />
                        <h4 className="truncate text-base font-semibold text-slate-900">{plugin.displayName}</h4>
                      </div>
                      <p className="mt-1 font-mono text-xs text-slate-400">{plugin.id}</p>
                      {plugin.description ? (
                        <p className="mt-2 text-sm leading-6 text-slate-600">{plugin.description}</p>
                      ) : null}
                    </div>
                    <span className={cx(
                      'inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-1 text-xs font-medium',
                      plugin.valid ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700',
                    )}>
                      <ShieldCheck size={13} />
                      {plugin.valid ? 'Valid' : 'Needs review'}
                    </span>
                  </div>

                  <div className="mt-4 space-y-3">
                    <div>
                      <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-slate-500">
                        <Database size={13} />
                        Skills
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {plugin.skillIds.map((skillId) => (
                          <span
                            key={skillId}
                            className={cx(
                              'rounded-md border px-2 py-1 text-xs font-mono',
                              skillId === plugin.defaultSkillId
                                ? 'border-sky-200 bg-sky-50 text-sky-700'
                                : 'border-slate-200 bg-slate-50 text-slate-600',
                            )}
                          >
                            {skillId}
                          </span>
                        ))}
                      </div>
                    </div>

                    <div>
                      <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-slate-500">
                        <Wrench size={13} />
                        Tools and servers
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {toolItems.length > 0 ? toolItems.map((item) => (
                          <span key={item} className="rounded-md border border-slate-200 bg-slate-50 px-2 py-1 text-xs font-mono text-slate-600">
                            {item}
                          </span>
                        )) : (
                          <span className="text-sm text-slate-400">No tools or MCP servers declared</span>
                        )}
                      </div>
                    </div>

                    {!plugin.valid && plugin.errors?.length ? (
                      <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-800">
                        {plugin.errors.join(' ')}
                      </div>
                    ) : null}
                  </div>
                </article>
              );
            })}
          </div>
        ) : null}
      </div>
    </div>
  );
};

export default PluginsRegistryTab;
