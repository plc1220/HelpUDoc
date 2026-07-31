import path from 'path';
import { promises as fs } from 'fs';
import { parse as parseYaml } from 'yaml';
import { extractFrontmatter } from '../skills/frontmatter';
import { listPlugins } from '../plugins/registry';
import {
  FileSnapshot,
  GOVERNANCE_POLICY_VERSION,
  GovernanceIssue,
  JsonRecord,
  ValidationResult,
  isTextMime,
  normalizeGovernedFilePath,
  normalizeGovernedSkillKey,
  normalizeUnique,
} from './skillGovernanceModel';

export class SkillPackageValidator {
  constructor(
    private readonly readBlob: (contentHash: string) => Promise<Buffer>,
    private readonly assertPackageLimits: (files: FileSnapshot[]) => void,
  ) {}

  async validate(draft: any, files: FileSnapshot[]): Promise<ValidationResult> {
    const issues: GovernanceIssue[] = [];
    this.assertPackageLimits(files);
    const skillFile = files.find((file) => file.path === 'SKILL.md');
    let frontmatter: any = {};
    if (!skillFile) {
      issues.push({ code: 'MISSING_SKILL_MD', message: 'SKILL.md is required', path: 'SKILL.md' });
    } else {
      try {
        const content = (await this.readBlob(skillFile.contentHash)).toString('utf-8');
        const raw = extractFrontmatter(content);
        if (!raw) {
          issues.push({ code: 'MISSING_FRONTMATTER', message: 'SKILL.md must begin with YAML frontmatter', path: 'SKILL.md' });
        } else {
          frontmatter = parseYaml(raw) || {};
          if (!frontmatter || typeof frontmatter !== 'object' || Array.isArray(frontmatter)) {
            issues.push({ code: 'INVALID_FRONTMATTER', message: 'SKILL.md frontmatter must be an object', path: 'SKILL.md' });
            frontmatter = {};
          }
        }
      } catch (error: any) {
        issues.push({ code: 'INVALID_FRONTMATTER', message: error?.message || 'SKILL.md cannot be parsed', path: 'SKILL.md' });
      }
    }
    try {
      normalizeGovernedSkillKey(draft.proposedSkillKey || '');
    } catch (error: any) {
      issues.push({
        code: 'INVALID_SKILL_ID',
        message: error instanceof Error ? error.message : 'Invalid skill ID',
        field: 'proposedSkillKey',
      });
    }
    if (!String(frontmatter.name || draft.displayName || '').trim()) {
      issues.push({ code: 'MISSING_NAME', message: 'Skill display name is required', field: 'displayName' });
    }
    if (!String(frontmatter.description || draft.description || '').trim()) {
      issues.push({ code: 'MISSING_DESCRIPTION', message: 'Skill description is required', field: 'description' });
    }

    const tools = normalizeUnique(frontmatter.tools);
    const mcpServers = normalizeUnique(frontmatter.mcp_servers ?? frontmatter.mcpServers);
    const runtimeCapabilities = await this.configuredRuntimeCapabilities();
    for (const tool of tools) {
      if (!runtimeCapabilities.tools.has(tool)) {
        issues.push({
          code: 'UNKNOWN_DECLARED_TOOL',
          message: `Declared tool '${tool}' is not present in the runtime registry`,
          path: 'SKILL.md',
        });
      }
    }
    for (const serverId of mcpServers) {
      if (!runtimeCapabilities.mcpServers.has(serverId)) {
        issues.push({
          code: 'UNKNOWN_DECLARED_MCP_SERVER',
          message: `Declared MCP server '${serverId}' is not present in the runtime registry`,
          path: 'SKILL.md',
        });
      }
    }

    const scripts = Array.isArray(frontmatter.sandbox_scripts) ? frontmatter.sandbox_scripts : [];
    const scriptNames: string[] = [];
    for (const rawScript of scripts) {
      if (!rawScript || typeof rawScript !== 'object') {
        issues.push({ code: 'INVALID_SANDBOX_SCRIPT', message: 'Sandbox script declarations must be objects', path: 'SKILL.md' });
        continue;
      }
      const script = rawScript as JsonRecord;
      const scriptName = String(script.name || '').trim();
      const scriptPath = String(script.path || '').trim();
      const declaredHash = String(script.sha256 || '').trim().toLowerCase();
      const timeoutSeconds = Number(script.timeout_seconds ?? script.timeoutSeconds);
      const outputs = normalizeUnique(script.outputs);
      if (scriptName) scriptNames.push(scriptName);
      let normalizedPath = '';
      try {
        normalizedPath = normalizeGovernedFilePath(scriptPath);
      } catch {
        issues.push({ code: 'INVALID_SANDBOX_SCRIPT_PATH', message: 'Sandbox script path is invalid', path: scriptPath });
        continue;
      }
      const snapshot = files.find((file) => file.path === normalizedPath);
      if (!scriptName || !snapshot || !/^[a-f0-9]{64}$/.test(declaredHash) || snapshot.contentHash !== declaredHash) {
        issues.push({
          code: 'INVALID_SANDBOX_SCRIPT',
          message: 'Sandbox scripts require a name, package file, and matching SHA-256 hash',
          path: normalizedPath,
        });
      }
      if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 300) {
        issues.push({
          code: 'INVALID_SANDBOX_TIMEOUT',
          message: 'Sandbox scripts require an integer timeout_seconds between 1 and 300',
          path: normalizedPath,
        });
      }
      if (!outputs.length || outputs.some((output) =>
        output.startsWith('/')
        || output.includes('\\')
        || output.split('/').some((part) => !part || part === '.' || part === '..'))) {
        issues.push({
          code: 'INVALID_SANDBOX_OUTPUTS',
          message: 'Sandbox scripts require one or more safe relative output paths',
          path: normalizedPath,
        });
      }
    }

    const rawInteractionContract = frontmatter.interaction_contract ?? frontmatter.interactionContract;
    const interactionFile = files.find((file) =>
      file.path === 'interaction_contract.yaml' || file.path === 'interaction_contract.yml');
    let interactionContract: unknown = rawInteractionContract;
    if (interactionFile) {
      try {
        interactionContract = parseYaml((await this.readBlob(interactionFile.contentHash)).toString('utf-8'));
      } catch (error: any) {
        issues.push({
          code: 'INVALID_INTERACTION_CONTRACT',
          message: error?.message || 'Interaction contract YAML cannot be parsed',
          path: interactionFile.path,
        });
      }
    }
    if (interactionContract !== undefined && interactionContract !== null) {
      const gates = !Array.isArray(interactionContract)
        && typeof interactionContract === 'object'
        && Array.isArray((interactionContract as JsonRecord).gates)
        ? (interactionContract as JsonRecord).gates as unknown[]
        : [];
      const invalidGate = !gates.length || gates.some((gate) =>
        !gate
        || typeof gate !== 'object'
        || !String((gate as JsonRecord).gate_id ?? (gate as JsonRecord).gateId ?? (gate as JsonRecord).id ?? '').trim()
        || !String((gate as JsonRecord).presentation ?? '').trim());
      if (invalidGate) {
        issues.push({
          code: 'INVALID_INTERACTION_CONTRACT',
          message: 'Interaction contracts require at least one gate with an ID and presentation',
          path: interactionFile?.path || 'SKILL.md',
        });
      }
    }

    const secretPatterns = [
      /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
      /\b(?:api[_-]?key|client[_-]?secret|access[_-]?token)\s*[:=]\s*["'][^"']{12,}["']/i,
      /\bAKIA[0-9A-Z]{16}\b/,
    ];
    for (const file of files) {
      if (!isTextMime(file.mimeType)) continue;
      const content = (await this.readBlob(file.contentHash)).toString('utf-8');
      if (secretPatterns.some((pattern) => pattern.test(content))) {
        issues.push({ code: 'POTENTIAL_SECRET', message: 'Potential credential or private key detected', path: file.path });
      }
    }

    const pluginId = String(frontmatter.plugin || frontmatter.plugin_id || frontmatter.pluginId || '').trim() || null;
    if (pluginId) {
      const plugin = (await listPlugins()).find((entry) => entry.id === pluginId);
      if (!plugin || !plugin.valid) {
        issues.push({
          code: 'INVALID_PLUGIN_REFERENCE',
          message: `Plugin '${pluginId}' is missing or invalid`,
          path: 'SKILL.md',
        });
      }
    }
    const riskClass: ValidationResult['riskClass'] = scripts.length || mcpServers.length
      ? 'high'
      : tools.length
        ? 'medium'
        : 'low';
    return {
      valid: issues.length === 0,
      outcome: issues.length === 0 ? 'pass' : 'block',
      riskClass,
      issues,
      declaredCapabilities: {
        tools,
        mcpServers,
        scripts: Array.from(new Set(scriptNames)).sort(),
        pluginId,
      },
      checkedAt: new Date().toISOString(),
      policyVersion: GOVERNANCE_POLICY_VERSION,
    };
  }

  private async configuredRuntimeCapabilities(): Promise<{ tools: Set<string>; mcpServers: Set<string> }> {
    const repoRoot = path.resolve(__dirname, '../../../../');
    const resolveConfigPath = (value?: string): string | null => {
      const trimmed = String(value || '').trim();
      if (!trimmed) return null;
      return path.isAbsolute(trimmed) ? trimmed : path.resolve(repoRoot, trimmed);
    };
    const basePath = path.join(repoRoot, 'agent', 'config', 'runtime.yaml');
    const configuredPath = resolveConfigPath(process.env.AGENT_CONFIG_PATH)
      || path.join(resolveConfigPath(process.env.AGENT_CONFIG_DIR) || path.join(repoRoot, 'agent', 'config'), 'runtime.yaml');
    const tools = new Set<string>();
    const mcpServers = new Set<string>();
    for (const configPath of Array.from(new Set([basePath, configuredPath]))) {
      try {
        const parsed = parseYaml(await fs.readFile(configPath, 'utf-8')) as JsonRecord | null;
        for (const entry of Array.isArray(parsed?.tools) ? parsed.tools : []) {
          const name = entry && typeof entry === 'object' ? String((entry as JsonRecord).name || '').trim() : '';
          if (name) tools.add(name);
        }
        for (const entry of Array.isArray(parsed?.mcp_servers) ? parsed.mcp_servers : []) {
          const name = entry && typeof entry === 'object' ? String((entry as JsonRecord).name || '').trim() : '';
          if (name) mcpServers.add(name);
        }
      } catch (error: any) {
        if (error?.code !== 'ENOENT') throw error;
      }
    }
    if (tools.has('document_inspection')) {
      tools.add('inspect_document');
      tools.add('search_document');
    }
    if (tools.has('knowledge_navigation')) {
      tools.add('knowledge_search');
      tools.add('knowledge_read');
    }
    return { tools, mcpServers };
  }
}
