"use client";

import { useState } from "react";

type ScenarioId =
  | "private-owner"
  | "team-policy"
  | "freeflow-edit"
  | "publisher-queue"
  | "skill-improvement"
  | "team-skill-review"
  | "cross-team-runtime"
  | "annotate-published"
  | "discussion-proposal";

type Scenario = {
  id: ScenarioId;
  number: string;
  label: string;
  viewer: string;
  role: string;
  summary: string;
  surface: "workspace" | "skills" | "runtime";
};

const scenarios: Scenario[] = [
  {
    id: "private-owner",
    number: "01",
    label: "Private workspace",
    viewer: "Alice Chen",
    role: "Workspace Owner",
    summary:
      "Alice works privately. Nobody else can see her files, conversations, or unfinished changes.",
    surface: "workspace",
  },
  {
    id: "team-policy",
    number: "02",
    label: "Configure team workspace",
    viewer: "Alice Chen",
    role: "Workspace Owner",
    summary:
      "Alice shares the workspace with teams and named users, enables Freeflow editing, and delegates publication to Priya.",
    surface: "workspace",
  },
  {
    id: "freeflow-edit",
    number: "03",
    label: "Edit in Freeflow",
    viewer: "Bob Rahman",
    role: "Workspace Contributor",
    summary:
      "Bob edits the current Team Workspace directly. Changes autosave into the activity feed without changing published version 3.",
    surface: "workspace",
  },
  {
    id: "publisher-queue",
    number: "04",
    label: "Publisher change feed",
    viewer: "Priya Nair",
    role: "Workspace Publisher",
    summary:
      "Priya reviews the accumulated changes and publishes version 4 without waiting for the Workspace Owner.",
    surface: "workspace",
  },
  {
    id: "skill-improvement",
    number: "05",
    label: "Propose skill improvement",
    viewer: "Priya Nair",
    role: "Skill Creator",
    summary:
      "Priya privately improves a Research Team skill and submits a frozen candidate to the owning Team Lead.",
    surface: "skills",
  },
  {
    id: "team-skill-review",
    number: "06",
    label: "Team Lead skill review",
    viewer: "Maya Wong",
    role: "Research Team Lead",
    summary:
      "Maya reviews the improvement, creates an immutable team version, and controls which other teams may consume it.",
    surface: "skills",
  },
  {
    id: "cross-team-runtime",
    number: "07",
    label: "Cross-team skill coverage",
    viewer: "Elena Garcia",
    role: "Workspace Contributor · Policy Team",
    summary:
      "The workspace pins one approved skill version. Team affiliation and explicit grants determine who can invoke it.",
    surface: "runtime",
  },
  {
    id: "annotate-published",
    number: "08",
    label: "Annotate published work",
    viewer: "Elena Garcia",
    role: "Workspace Contributor",
    summary:
      "Elena cannot edit published version 3, but she can anchor an annotation, mention authorized workspace members, and create a team task.",
    surface: "workspace",
  },
  {
    id: "discussion-proposal",
    number: "09",
    label: "Turn discussion into proposal",
    viewer: "Bob Rahman",
    role: "Workspace Contributor",
    summary:
      "Bob converts a version-anchored discussion into a tracked Team Workspace change without modifying published version 3.",
    surface: "workspace",
  },
];

const privateWorkspaces = [
  { name: "Customer research", meta: "Private · only you" },
  { name: "Proposal sandbox", meta: "Private draft" },
  { name: "Q3 planning", meta: "Up to date" },
];

const teamWorkspaces = [
  { name: "Product knowledge", meta: "Product Team · published v8" },
  { name: "Customer research", meta: "2 teams · published v3" },
  { name: "Policy handbook", meta: "Operations Team · published v12" },
];

function Glyph({ children }: { children: React.ReactNode }) {
  return <span className="glyph" aria-hidden="true">{children}</span>;
}

function StatusChip({
  tone,
  children,
}: {
  tone: "private" | "published" | "pending" | "allowed" | "blocked";
  children: React.ReactNode;
}) {
  return <span className={`status-chip status-${tone}`}>{children}</span>;
}

function WorkspaceDrawer({
  selected,
  team,
}: {
  selected: string;
  team: boolean;
}) {
  return (
    <aside className="workspace-drawer">
      <div className="drawer-actions">
        <button type="button" aria-label="Create workspace"><Glyph>＋</Glyph></button>
        <button type="button" aria-label="Schedules"><Glyph>▦</Glyph></button>
        <button type="button" aria-label="Close workspace menu"><Glyph>‹</Glyph></button>
      </div>
      <label className="search-box">
        <span>⌕</span>
        <input aria-label="Search workspaces" placeholder="Search workspaces" />
      </label>
      <div className="workspace-scroll">
        <section>
          <div className="section-label">
            <span>Private workspaces</span>
            <span>{privateWorkspaces.length}</span>
          </div>
          <div className="workspace-list">
            {privateWorkspaces.map((workspace) => (
              <button
                type="button"
                className={
                  selected === workspace.name && !team ? "workspace-active" : ""
                }
                key={workspace.name}
              >
                <Glyph>▱</Glyph>
                <span>
                  <strong>{workspace.name}</strong>
                  <small>{workspace.meta}</small>
                </span>
                <b>···</b>
              </button>
            ))}
          </div>
        </section>
        <section>
          <div className="section-label">
            <span>Team workspaces</span>
            <span>{teamWorkspaces.length}</span>
          </div>
          <div className="workspace-list">
            {teamWorkspaces.map((workspace) => (
              <button
                type="button"
                className={
                  selected === workspace.name && team ? "workspace-active" : ""
                }
                key={workspace.name}
              >
                <Glyph>◫</Glyph>
                <span>
                  <strong>{workspace.name}</strong>
                  <small>{workspace.meta}</small>
                </span>
                <b>···</b>
              </button>
            ))}
          </div>
        </section>
      </div>
      <div className="drawer-footer">
        <button type="button" aria-label="Theme"><Glyph>◐</Glyph></button>
        <button type="button" aria-label="Settings"><Glyph>⚙</Glyph></button>
        <button type="button" aria-label="Sign out"><Glyph>↪</Glyph></button>
      </div>
    </aside>
  );
}

function ProductRail({ settings = false }: { settings?: boolean }) {
  return (
    <aside className="product-rail">
      <div className="product-mark">H</div>
      <div className="rail-items">
        <button type="button" className={!settings ? "active" : ""} title="Workspaces">
          <Glyph>▦</Glyph>
        </button>
        <button type="button" title="Knowledge"><Glyph>◇</Glyph></button>
        <button type="button" title="Schedules"><Glyph>◷</Glyph></button>
      </div>
      <button type="button" className={settings ? "active" : ""} title="Settings">
        <Glyph>⚙</Glyph>
      </button>
    </aside>
  );
}

function FilePane({ readOnly = false }: { readOnly?: boolean }) {
  return (
    <aside className="file-pane">
      <div className="pane-title">
        <div><button type="button">‹</button><strong>Files</strong></div>
        <button type="button" disabled={readOnly}>＋</button>
      </div>
      <div className="file-tree">
        <button type="button"><span>⌄</span><Glyph>▰</Glyph><strong>Research</strong></button>
        <button type="button" className="file-selected"><span></span><Glyph>▤</Glyph><strong>interview-summary.md</strong></button>
        <button type="button"><span></span><Glyph>▤</Glyph><strong>themes.md</strong></button>
        <button type="button"><span>⌄</span><Glyph>▰</Glyph><strong>Evidence</strong></button>
        <button type="button"><span></span><Glyph>▧</Glyph><strong>survey-results.xlsx</strong></button>
        <button type="button"><span></span><Glyph>▧</Glyph><strong>customer-quotes.csv</strong></button>
        <button type="button"><span></span><Glyph>▤</Glyph><strong>README.md</strong></button>
      </div>
      <div className="file-foot">
        <span>{readOnly ? "Published files are read-only" : "7 files · 2 folders"}</span>
      </div>
    </aside>
  );
}

function DocumentCanvas({
  readOnly,
  freeflowState,
  collaborationState,
  onCollaborationAction,
}: {
  readOnly?: boolean;
  freeflowState?: "editing" | "publisher";
  collaborationState?: "annotate" | "proposal";
  onCollaborationAction?: () => void;
}) {
  const collaborating = Boolean(collaborationState);
  const changed = Boolean(freeflowState);
  return (
    <section className={`document-canvas ${collaborating ? "collaboration-mode" : ""} ${changed ? "freeflow-document" : ""}`}>
      <div className="document-toolbar">
        <div>
          <Glyph>▤</Glyph>
          <span>Research / interview-summary.md</span>
          {readOnly ? <StatusChip tone="published">Read only</StatusChip> : null}
          {freeflowState === "editing" ? <StatusChip tone="allowed">Autosaved · Bob</StatusChip> : null}
          {freeflowState === "publisher" ? <StatusChip tone="pending">4 changes since v3</StatusChip> : null}
        </div>
        <div>
          <button type="button" className={!collaborating ? "toolbar-active" : ""}>{changed ? "Edit" : "Preview"}</button>
          {changed ? <button type="button">History</button> : null}
          {collaborating ? <button type="button" className="toolbar-active">Annotate</button> : null}
          {collaborating ? <button type="button">Notes &amp; tasks <b>2</b></button> : null}
          <button type="button">···</button>
        </div>
      </div>
      <article className="document-page">
        <p className="doc-kicker">Customer discovery · July 2026</p>
        <h1>Interview synthesis</h1>
        <p className="doc-lead">
          A synthesis of twelve customer interviews focused on knowledge access,
          collaboration boundaries, and reusable agent workflows.
        </p>
        <hr />
        <h2>What customers need</h2>
        <div className="finding-grid">
          <div>
            <span>01</span>
            <strong>A safe place to experiment</strong>
            <p>Unfinished work should remain private until its owner chooses to publish.</p>
          </div>
          <div className={collaborating ? "annotated-finding" : ""}>
            <span>02</span>
            <strong>Sharing beyond the team</strong>
            <p>Registered collaborators need access without joining an internal team.</p>
            {collaborating ? <button type="button" className="annotation-pin" aria-label="Open annotation thread">3</button> : null}
          </div>
          <div className={changed ? "changed-finding" : ""}>
            <span>03</span>
            <strong>Clear contribution boundaries</strong>
            <p>Contributors can edit the Team Workspace while published versions remain immutable.</p>
            {freeflowState === "editing" ? <small>Bob edited · autosaved 1m ago</small> : null}
            {freeflowState === "publisher" ? <small>Changed since published v3</small> : null}
          </div>
        </div>
        <h2>Recommended direction</h2>
        <p>
          Separate private creation, governed publication, audience assignment,
          and runtime execution into independent, explainable controls.
        </p>
      </article>
      {collaborationState === "annotate" ? (
        <aside className="annotation-popover" aria-label="New shared annotation">
          <div className="annotation-head">
            <span className="avatar elena">EG</span>
            <div><strong>New annotation</strong><small>Anchored to version 3 · finding 02</small></div>
            <button type="button">×</button>
          </div>
          <blockquote>“Registered collaborators need access without joining an internal team.”</blockquote>
          <div className="annotation-message">
            We should validate whether external contributors can be mentioned without being added to Product Team.
          </div>
          <div className="annotation-audience">
            <span>Share with</span>
            <b>Priya Nair</b>
            <b>Research Team</b>
          </div>
          <div className="annotation-meta-row">
            <span>Assign to Alice Chen</span>
            <span>Due 5 Aug</span>
          </div>
          <div className="annotation-actions">
            <button type="button">Private note</button>
            <button type="button" className="primary-action" onClick={onCollaborationAction}>Send annotation</button>
          </div>
        </aside>
      ) : collaborationState === "proposal" ? (
        <aside className="annotation-popover thread-popover" aria-label="Shared annotation discussion">
          <div className="annotation-head">
            <span className="thread-count">3</span>
            <div><strong>External collaboration boundary</strong><small>Open · version 3 · assigned to Alice</small></div>
            <button type="button">···</button>
          </div>
          <blockquote>Finding 02 · Sharing beyond the team</blockquote>
          <div className="thread-message">
            <span className="avatar elena">EG</span>
            <p><strong>Elena Garcia</strong><small>Yesterday</small>Can we validate external mentions without team membership?</p>
          </div>
          <div className="thread-message">
            <span className="avatar priya">PN</span>
            <p><strong>Priya Nair</strong><small>2h ago</small>Yes—mentions should require workspace access, not team membership.</p>
          </div>
          <div className="proposal-preview">
            <span>Suggested outcome</span>
            <strong>Clarify the access rule and add a notification privacy check.</strong>
          </div>
          <div className="annotation-actions">
            <button type="button">Resolve</button>
            <button type="button" className="primary-action" onClick={onCollaborationAction}>Create tracked team change</button>
          </div>
        </aside>
      ) : null}
      {collaborating ? (
        <div className="sticky-tray">
          <div><span>Sticky note</span><strong>Confirm notification privacy</strong><small>Research Team · open</small></div>
          <div><span>Task</span><strong>Review external access wording</strong><small>Alice Chen · due 5 Aug</small></div>
        </div>
      ) : null}
    </section>
  );
}

function LumoPane({
  scenario,
}: {
  scenario: ScenarioId;
}) {
  const runtime = scenario === "cross-team-runtime";
  const contributor = scenario === "freeflow-edit";
  const submit = scenario === "publisher-queue";
  const annotating = scenario === "annotate-published";
  const proposing = scenario === "discussion-proposal";
  return (
    <aside className="lumo-pane">
      <div className="lumo-head">
        <div><button type="button">›</button><span>Mode</span><strong>General</strong></div>
        <div><button type="button">◷</button><button type="button">＋</button><button type="button">□</button></div>
      </div>
      <div className="chat-scroll">
        <div className="lumo-intro">
          <div className="lumo-orb">L</div>
          <strong>Lumo</strong>
          <p>Ask about this workspace or choose an available skill.</p>
        </div>
        {annotating ? (
          <>
            <div className="published-chat-boundary">
              <strong>Published version 3</strong>
              Chat and annotations cannot change this version. Generated changes are saved privately.
            </div>
            <div className="user-message">Summarize the open discussion before I send this annotation.</div>
            <div className="assistant-message">
              The team is validating how external registered users can collaborate without receiving team membership. I can help phrase the annotation, but I cannot change version 3.
            </div>
          </>
        ) : proposing ? (
          <>
            <div className="published-chat-boundary">
              <strong>Published version 3</strong>
              This discussion is active, while the published content remains read-only.
            </div>
            <div className="user-message">Turn this thread into an actionable change.</div>
            <div className="assistant-message">
              I can create a tracked change linked to this thread in the current Team Workspace. Published version 3 will remain unchanged.
            </div>
            <div className="tool-activity">
              <div><span className="pulse-dot"></span><strong>Proposal handoff</strong><small>Ready</small></div>
              <p>The source version, content anchor, participants, and discussion summary will be preserved in the change feed.</p>
            </div>
          </>
        ) : runtime ? (
          <>
            <div className="user-message">Use the Research Analysis skill to summarize the survey spreadsheet.</div>
            <div className="assistant-message">
              I’ll check the skill and runtime permissions before using the spreadsheet.
            </div>
            <div className="tool-activity">
              <div><span className="pulse-dot"></span><strong>Runtime authorization</strong><small>6 checks</small></div>
              <p>Skill, MCP, workspace, connection, and sandbox policies evaluated.</p>
            </div>
          </>
        ) : contributor ? (
          <>
            <div className="user-message">Can you update the published interview summary?</div>
            <div className="assistant-message">
              Freeflow is enabled. Your edits are autosaved to the Team Workspace and attributed in the change feed.
            </div>
          </>
        ) : submit ? (
          <>
            <div className="user-message">Summarize what I changed before I submit it.</div>
            <div className="assistant-message">
              Four changes have accumulated since published version 3. As Publisher, you can inspect the feed and publish version 4.
            </div>
          </>
        ) : (
          <>
            <div className="user-message">What are the strongest findings in these interviews?</div>
            <div className="assistant-message">
              Customers consistently want private experimentation, deliberate publishing, and access that is independent from team membership.
            </div>
          </>
        )}
      </div>
      <div className="chat-input">
        <div>Interact with the agent… <span>Type / for skills and tools</span></div>
        <button type="button">↑</button>
      </div>
    </aside>
  );
}

function TeamWorkspaceSettingsDialog({
  onNext,
}: {
  onNext: () => void;
}) {
  const [freeflow, setFreeflow] = useState(true);
  return (
    <div className="modal-layer">
      <div className="share-dialog" role="dialog" aria-modal="true" aria-labelledby="share-title">
        <div className="dialog-head">
          <div>
            <small>Team Workspace</small>
            <h2 id="share-title">Collaboration settings</h2>
          </div>
          <button type="button">×</button>
        </div>
        <p className="dialog-copy">
          Choose how people collaborate in <strong>Customer research</strong>.
          Published versions remain immutable in either mode.
        </p>
        <div className="editing-policy" aria-label="Editing policy">
          <span>Editing policy</span>
          <button type="button" className={!freeflow ? "selected" : ""} onClick={() => setFreeflow(false)}>
            <strong>Changes require review</strong>
            <small>Contributors submit proposals for an Owner or Publisher to merge.</small>
          </button>
          <button type="button" className={freeflow ? "selected" : ""} onClick={() => setFreeflow(true)}>
            <strong>Freeflow editing</strong>
            <small>Contributors edit directly; every revision appears in the change feed.</small>
          </button>
        </div>
        <div className="policy-note">
          <Glyph>✓</Glyph>
          <div>
            <strong>Owner and Publishers can publish</strong>
            <p>Priya can publish a new immutable version without waiting for Alice.</p>
          </div>
        </div>
        <div className="access-list">
          <span>Teams and people with access</span>
          <div><b className="avatar alice">AC</b><p><strong>Alice Chen</strong><small>Owner · Direct access</small></p><em>Owner</em></div>
          <div><b className="avatar priya">PN</b><p><strong>Priya Nair</strong><small>Product Team · Direct role</small></p><em>Publisher</em></div>
          <div><b className="avatar group">PT</b><p><strong>Product Team</strong><small>8 members · Team access</small></p><em>Contributor</em></div>
          <div><b className="avatar group">PL</b><p><strong>Policy Team</strong><small>5 members · Team access</small></p><em>Contributor</em></div>
        </div>
        <div className="capability-boundary"><Glyph>i</Glyph><p>Workspace access does not merge team skill catalogs. Pinned skills are checked separately for every user.</p></div>
        <div className="dialog-actions">
          <button type="button">Cancel</button>
          <button type="button" className="primary-action" onClick={onNext}>Save collaboration policy</button>
        </div>
      </div>
    </div>
  );
}

function ChangeQueuePane({ onPublish }: { onPublish: () => void }) {
  const changes = [
    ["BR", "interview-summary.md", "Bob Rahman · manual edit · 1m ago", "Modified"],
    ["L", "themes.md", "Lumo · research-synthesis@3.2.0 · 8m ago", "Modified"],
    ["EG", "survey-results.xlsx", "Elena Garcia · uploaded · 18m ago", "Replaced"],
    ["PN", "README.md", "Priya Nair · manual edit · 32m ago", "Modified"],
  ];
  return (
    <aside className="change-queue-pane">
      <div className="change-queue-head">
        <div><small>Publisher view</small><strong>Changes since v3</strong></div>
        <span>4</span>
      </div>
      <div className="queue-summary-card">
        <div><strong>Current Team Workspace</strong><small>All changes are included in the next snapshot.</small></div>
        <StatusChip tone="allowed">No conflicts</StatusChip>
      </div>
      <div className="change-list">
        {changes.map(([initials, file, detail, state]) => (
          <button type="button" key={file}>
            <span className={`avatar small-avatar ${initials === "BR" ? "bob" : initials === "L" ? "group" : ""}`}>{initials}</span>
            <p><strong>{file}</strong><small>{detail}</small></p>
            <em>{state}</em>
          </button>
        ))}
      </div>
      <div className="skill-lock-card">
        <div><Glyph>✦</Glyph><p><strong>Workspace skill set</strong><small>research-synthesis@3.2.0 · exact version pinned</small></p></div>
        <StatusChip tone="allowed">2 teams covered</StatusChip>
      </div>
      <div className="change-queue-foot">
        <p>Publishing creates immutable version 4. The Team Workspace remains open for new work.</p>
        <button type="button" className="primary-action" onClick={onPublish}>Publish version 4</button>
      </div>
    </aside>
  );
}

function WorkspaceSurface({
  scenario,
  onNext,
  onToast,
}: {
  scenario: Scenario;
  onNext: () => void;
  onToast: (message: string) => void;
}) {
  const team = scenario.id !== "private-owner";
  const freeflowEditing = scenario.id === "freeflow-edit";
  const publisherQueue = scenario.id === "publisher-queue";
  const publishedSnapshot =
    scenario.id === "annotate-published" || scenario.id === "discussion-proposal";
  const collaborating =
    scenario.id === "annotate-published" || scenario.id === "discussion-proposal";
  const readOnly = publishedSnapshot;
  const headerStatus = collaborating
    ? "Published · version 3 · 3 discussions"
    : freeflowEditing
      ? "Team · Freeflow · autosaved"
      : publisherQueue
        ? "Team · 4 changes since v3"
        : team
          ? "Team · Freeflow · published v3"
          : "Private · only you";
  const action =
    scenario.id === "private-owner"
      ? "Create Team Workspace"
      : scenario.id === "team-policy"
        ? "Collaboration settings"
        : scenario.id === "freeflow-edit"
          ? "Open change feed"
          : scenario.id === "publisher-queue"
            ? "Publish version 4"
          : scenario.id === "annotate-published"
            ? "Notes & tasks"
            : scenario.id === "discussion-proposal"
              ? "Open discussions"
              : "Submit update";

  const triggerAction = () => {
    const messages: Record<string, string> = {
      "private-owner": "Team Workspace setup opened. Your original private workspace remains private.",
      "team-policy": "Freeflow enabled. Priya can publish without waiting for Alice.",
      "freeflow-edit": "Bob’s autosaved revision is visible in the Publisher change feed.",
      "publisher-queue": "Immutable version 4 published. The Team Workspace remains open for new work.",
      "annotate-published": "Annotation sent to Priya, Alice, and the Research Team.",
      "discussion-proposal": "Tracked Team Workspace change created from the version 3 discussion.",
    };
    onToast(messages[scenario.id]);
    onNext();
  };

  return (
    <div className="product-shell">
      <ProductRail />
      <WorkspaceDrawer selected="Customer research" team={team} />
      <div className="workspace-main">
        <header className="workspace-header">
          <div className="workspace-identity">
            <div className="workspace-icon">CR</div>
            <div>
              <span>{team ? "Team workspaces" : "Private workspaces"} /</span>
              <strong>Customer research</strong>
            </div>
            <StatusChip tone={publishedSnapshot ? "published" : publisherQueue ? "pending" : team ? "allowed" : "private"}>
              {headerStatus}
            </StatusChip>
          </div>
          <div className="workspace-actions">
            {team ? <button type="button">Published versions</button> : null}
            <button type="button" className="primary-action" onClick={triggerAction}>{action}</button>
            <button type="button">···</button>
          </div>
        </header>
        {freeflowEditing ? (
          <div className="context-banner freeflow-banner">
            <span>Freeflow editing</span>
            Contributors edit directly. Revisions autosave to the change feed; published version 3 stays unchanged.
            <button type="button" onClick={triggerAction}>View change feed</button>
          </div>
        ) : publisherQueue ? (
          <div className="context-banner publisher-banner">
            <span>Publisher review</span>
            No per-change approval is required. Review the activity feed and publish the current Team Workspace.
            <button type="button" onClick={triggerAction}>Publish version 4</button>
          </div>
        ) : collaborating ? (
          <div className="context-banner collaboration-banner">
            <span>Published content is read-only</span>
            Discussions and tasks stay active; tracked changes target the current Team Workspace.
            <button type="button" onClick={triggerAction}>{action}</button>
          </div>
        ) : null}
        <div className="workspace-columns">
          <FilePane readOnly={readOnly} />
          <DocumentCanvas
            readOnly={readOnly}
            freeflowState={freeflowEditing ? "editing" : publisherQueue ? "publisher" : undefined}
            collaborationState={
              scenario.id === "annotate-published"
                ? "annotate"
                : scenario.id === "discussion-proposal"
                  ? "proposal"
                  : undefined
            }
            onCollaborationAction={triggerAction}
          />
          {publisherQueue ? <ChangeQueuePane onPublish={triggerAction} /> : <LumoPane scenario={scenario.id} />}
        </div>
      </div>
      {scenario.id === "team-policy" ? <TeamWorkspaceSettingsDialog onNext={triggerAction} /> : null}
    </div>
  );
}

function SettingsSidebar({ review }: { review: boolean }) {
  return (
    <aside className="settings-sidebar">
      <div>
        <small>Administration</small>
        <button type="button"><Glyph>⌂</Glyph>Dashboard</button>
        <button type="button"><Glyph>♙</Glyph>Users &amp; Teams</button>
        <button type="button"><Glyph>◇</Glyph>Knowledge</button>
      </div>
      <div>
        <small>Agents</small>
        <button type="button" className="active"><Glyph>✦</Glyph>{review ? "Team skill reviews" : "My skill proposals"}</button>
        <button type="button"><Glyph>⌘</Glyph>Plugins &amp; Tools</button>
        <button type="button"><Glyph>⇄</Glyph>MCP servers</button>
      </div>
      <div className="settings-user">
        <div className="avatar alice">{review ? "MW" : "PN"}</div>
        <span><strong>{review ? "Maya Wong" : "Priya Nair"}</strong><small>{review ? "Research Team Lead" : "Product Team member"}</small></span>
      </div>
    </aside>
  );
}

function SkillCreatorView({
  onNext,
  onToast,
}: {
  onNext: () => void;
  onToast: (message: string) => void;
}) {
  const submit = () => {
    onToast("Skill improvement proposal submitted to the Research Team Lead.");
    onNext();
  };
  return (
    <div className="settings-main">
      <header className="settings-header">
        <div><small>Skills &amp; tooling</small><h1>My skill proposals</h1><p>Improve a team skill privately, then submit a frozen candidate to its owning team.</p></div>
        <button type="button" className="primary-action">＋ Create private skill</button>
      </header>
      <div className="skill-workbench">
        <aside className="skill-list-pane">
          <label className="search-box"><span>⌕</span><input placeholder="Search proposals" /></label>
          <div className="skill-filter"><button type="button" className="active">All</button><button type="button">Drafts</button><button type="button">In review</button></div>
          <button type="button" className="skill-list-item active">
            <div className="skill-symbol">✦</div>
            <span><strong>Research synthesis</strong><small>Research Team v3.1.0 · edited 4m ago</small></span>
            <StatusChip tone="private">Private improvement</StatusChip>
          </button>
          <button type="button" className="skill-list-item">
            <div className="skill-symbol muted">✦</div>
            <span><strong>Proposal helper</strong><small>Product Team v2.0.0</small></span>
            <StatusChip tone="published">Team skill</StatusChip>
          </button>
        </aside>
        <section className="skill-editor">
          <div className="skill-editor-head">
            <div><span className="skill-symbol">✦</span><div><small>Private improvement of Research Team v3.1.0</small><h2>Research synthesis · proposed v3.2</h2></div></div>
            <div><button type="button">Test privately</button><button type="button" className="primary-action" onClick={submit}>Submit to Team Lead</button></div>
          </div>
          <div className="editor-tabs"><button type="button" className="active">Overview</button><button type="button">SKILL.md</button><button type="button">Scripts</button><button type="button">Test runs</button></div>
          <div className="skill-editor-body">
            <div className="field-block"><label>Description</label><div>Synthesize customer interviews and structured survey evidence into traceable research findings.</div></div>
            <div className="two-fields">
              <div className="field-block"><label>Creator</label><div><span className="avatar small-avatar">PN</span>Priya Nair</div></div>
              <div className="field-block"><label>Owning team</label><div><span className="avatar small-avatar group">RT</span>Research Team</div></div>
            </div>
            <div className="field-block">
              <label>Declared capabilities</label>
              <div className="capability-tags"><span>Tool · workspace_read</span><span>MCP · data-artifacts</span><span>Sandbox · analyze_research.py</span></div>
              <small>Declarations describe what the skill may request. They do not grant access.</small>
            </div>
            <div className="sandbox-test-card">
              <div><Glyph>▷</Glyph><span><strong>Last private sandbox test passed</strong><small>12 files staged · 18.4s · 3 outputs</small></span></div>
              <StatusChip tone="allowed">Passed</StatusChip>
            </div>
          </div>
        </section>
        <aside className="builder-pane">
          <div className="builder-head"><span className="lumo-orb mini">L</span><div><strong>Skill Creator</strong><small>Private assistant</small></div></div>
          <div className="builder-chat">
            <div className="assistant-message">I based this improvement on Research Team version 3.1.0 and preserved its capability boundaries.</div>
            <div className="user-message">Check whether it is ready for the Team Lead.</div>
            <div className="assistant-message">All checks pass. Maya will see the exact diff, one MCP dependency, and the sandbox test evidence.</div>
          </div>
          <div className="builder-input">Ask Skill Creator…<button type="button">↑</button></div>
        </aside>
      </div>
    </div>
  );
}

function AdminReviewView({
  onNext,
  onToast,
}: {
  onNext: () => void;
  onToast: (message: string) => void;
}) {
  const approve = () => {
    onToast("Research synthesis v3.2.0 approved for the Research Team and shared with the Policy Team.");
    onNext();
  };
  return (
    <div className="settings-main">
      <header className="settings-header">
        <div><small>Research Team governance</small><h1>Skill improvement queue</h1><p>Review frozen proposals before creating a new immutable team skill version.</p></div>
        <div className="review-count"><strong>3</strong><span>Awaiting review</span></div>
      </header>
      <div className="review-layout">
        <aside className="review-queue">
          <div className="queue-head"><strong>Improvement proposals</strong><button type="button">Filter</button></div>
          <button type="button" className="review-item active">
            <div className="avatar small-avatar">PN</div>
            <span><strong>Research synthesis · v3.2</strong><small>Priya Nair · submitted 9m ago</small><em>Based on Research Team v3.1.0</em></span>
          </button>
          <button type="button" className="review-item">
            <div className="avatar small-avatar bob">BR</div>
            <span><strong>Contract extractor · v2.1</strong><small>Bob Rahman · submitted 2h ago</small><em>Based on Research Team v2.0.0</em></span>
          </button>
          <button type="button" className="review-item">
            <div className="avatar small-avatar group">SL</div>
            <span><strong>Evidence checker · v1.4</strong><small>Sarah Lee · submitted yesterday</small><em>New BigQuery dependency</em></span>
          </button>
        </aside>
        <section className="review-detail">
          <div className="review-title">
            <div><small>Research Team · improvement proposal</small><h2>Research synthesis · proposed v3.2.0</h2><p>Synthesize customer interviews and survey evidence into traceable findings.</p></div>
            <StatusChip tone="pending">Team Lead review</StatusChip>
          </div>
          <div className="review-meta">
            <div><span>Creator</span><strong>Priya Nair</strong></div>
            <div><span>Submitted</span><strong>29 Jul · 17:42</strong></div>
            <div><span>Base version</span><strong>v3.1.0 · exact</strong></div>
            <div><span>Validation</span><strong className="green-text">All checks passed</strong></div>
            <div><span>Self-approval</span><strong>Blocked</strong></div>
          </div>
          <div className="review-section">
            <div className="review-section-head"><strong>Requested capabilities</strong><span>Reviewed independently</span></div>
            <div className="permission-row"><Glyph>▦</Glyph><span><strong>Built-in tool</strong><small>workspace_read · read selected workspace files</small></span><StatusChip tone="allowed">Allowed</StatusChip></div>
            <div className="permission-row"><Glyph>⇄</Glyph><span><strong>MCP server</strong><small>data-artifacts · group entitlement still required</small></span><StatusChip tone="allowed">Registered</StatusChip></div>
            <div className="permission-row"><Glyph>⌘</Glyph><span><strong>Sandbox script</strong><small>analyze_research.py · hash pinned · 30s timeout</small></span><StatusChip tone="allowed">Passed</StatusChip></div>
          </div>
          <div className="review-section">
            <div className="review-section-head"><strong>Review checklist</strong><span>5 of 5 complete</span></div>
            <div className="check-grid">
              <span>✓ Clear purpose and owner</span><span>✓ Safe input boundaries</span><span>✓ No ambient credentials</span><span>✓ Sandbox resource limits</span><span>✓ Output paths constrained</span>
            </div>
          </div>
        </section>
        <aside className="assignment-pane">
          <div><small>After approval</small><h3>Create team version</h3><p>The Research Team remains the sole owner. Other teams receive consumption grants, not ownership.</p></div>
          <label>New immutable version<select aria-label="New immutable version"><option>3.2.0</option></select></label>
          <label>Available to teams<div className="group-select"><span>Research Team</span><span>Policy Team</span></div></label>
          <div className="assignment-note"><Glyph>i</Glyph><p>Existing workspaces stay pinned to v3.1.0 until an Owner or Publisher intentionally upgrades them.</p></div>
          <div className="review-actions"><button type="button">Request changes</button><button type="button" className="primary-action" onClick={approve}>Approve team version</button></div>
        </aside>
      </div>
    </div>
  );
}

function SkillsSurface({
  scenario,
  onNext,
  onToast,
}: {
  scenario: Scenario;
  onNext: () => void;
  onToast: (message: string) => void;
}) {
  const review = scenario.id === "team-skill-review";
  return (
    <div className="product-shell">
      <ProductRail settings />
      <SettingsSidebar review={review} />
      {review ? <AdminReviewView onNext={onNext} onToast={onToast} /> : <SkillCreatorView onNext={onNext} onToast={onToast} />}
    </div>
  );
}

function RuntimeSurface({
  onNext,
  onToast,
}: {
  onNext: () => void;
  onToast: (message: string) => void;
}) {
  const [persona, setPersona] = useState<"research" | "policy" | "direct">("policy");
  const allowed = persona !== "direct";
  const affiliation =
    persona === "research"
      ? "Research Team · owning-team grant"
      : persona === "policy"
        ? "Policy Team · cross-team grant"
        : "Direct workspace access · no skill grant";
  const checks = [
    ["Workspace access", persona === "direct" ? "Direct Contributor grant" : `${persona === "research" ? "Research" : "Policy"} Team`, true],
    ["Workspace pin", "research-synthesis@3.2.0 · exact immutable version", true],
    ["Skill assignment", affiliation, allowed],
    ["Tool entitlement", allowed ? "workspace_read · granted through team" : "Missing for this direct user", allowed],
    ["Skill declaration", "workspace_read and analyze_research.py", true],
    ["Platform policy", "Skill version active · sandbox healthy", true],
  ] as const;
  const run = () => {
    if (!allowed) {
      onToast("Run blocked: workspace access does not grant the pinned team skill.");
    } else {
      onToast("All six checks passed. The pinned team skill v3.2.0 started.");
      onNext();
    }
  };
  return (
    <div className="product-shell">
      <ProductRail />
      <WorkspaceDrawer selected="Customer research" team />
      <div className="workspace-main">
        <header className="workspace-header">
          <div className="workspace-identity">
            <div className="workspace-icon">CR</div>
            <div><span>Team workspaces /</span><strong>Customer research</strong></div>
            <StatusChip tone="allowed">Pinned skill set · 2 skills</StatusChip>
          </div>
          <div className="workspace-actions"><button type="button">Manage skill set</button><button type="button">Published versions</button><button type="button">···</button></div>
        </header>
        <div className="workspace-columns runtime-columns">
          <FilePane />
          <section className="runtime-canvas">
            <div className="runtime-title">
              <div><small>Team Workspace · skill coverage preview</small><h2>One pinned version, different affiliations</h2><p>The workspace constrains the version; team and direct grants determine who may invoke it.</p></div>
              <StatusChip tone={allowed ? "allowed" : "blocked"}>{allowed ? "Ready to run" : "Skill access missing"}</StatusChip>
            </div>
            <div className="runtime-toggle">
              <button type="button" className={persona === "research" ? "active" : ""} onClick={() => setPersona("research")}>Research Team member</button>
              <button type="button" className={persona === "policy" ? "active" : ""} onClick={() => setPersona("policy")}>Policy Team member</button>
              <button type="button" className={persona === "direct" ? "active danger" : ""} onClick={() => setPersona("direct")}>Direct workspace member</button>
            </div>
            <div className="auth-checks">
              {checks.map(([label, detail, allowed], index) => (
                <div className={!allowed ? "failed-check" : ""} key={label}>
                  <span className="check-number">{String(index + 1).padStart(2, "0")}</span>
                  <p><strong>{label}</strong><small>{detail}</small></p>
                  <StatusChip tone={allowed ? "allowed" : "blocked"}>{allowed ? "Pass" : "Block"}</StatusChip>
                </div>
              ))}
            </div>
            <div className="sandbox-envelope">
              <div><Glyph>✦</Glyph><span><strong>Workspace Skill Set</strong><small>research-synthesis@3.2.0 · source-checker@1.4.2</small></span></div>
              <div><span>Research Team owner</span><span>Policy Team shared</span><span>Exact versions</span><span>2 of 2 teams covered</span></div>
            </div>
            <div className="run-actions">
              <p>{allowed ? "Every authorized member runs the same pinned skill version." : "The user can edit workspace files, but needs a team or direct skill grant before invoking this skill."}</p>
              <button type="button" className={allowed ? "primary-action" : "blocked-action"} onClick={run}>{allowed ? "Run pinned skill" : "Demonstrate blocked run"}</button>
            </div>
          </section>
          <LumoPane scenario="cross-team-runtime" />
        </div>
      </div>
    </div>
  );
}

export function HelpUDocPrototype() {
  const [activeIndex, setActiveIndex] = useState(0);
  const [toast, setToast] = useState<string | null>(null);
  const scenario = scenarios[activeIndex];

  const chooseScenario = (index: number) => {
    setActiveIndex(index);
    setToast(null);
  };

  const next = () => {
    setActiveIndex((current) => (current + 1) % scenarios.length);
  };

  const showToast = (message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(null), 3600);
  };

  return (
    <main className="prototype-page">
      <header className="prototype-toolbar">
        <div className="prototype-title">
          <span className="prototype-badge">Prototype</span>
          <div><strong>HelpUDoc governance scenarios</strong><small>Click a scenario to relocate the existing UI into that user’s view.</small></div>
        </div>
        <div className="scenario-tabs" role="tablist" aria-label="Prototype scenarios">
          {scenarios.map((item, index) => (
            <button
              type="button"
              role="tab"
              aria-selected={index === activeIndex}
              className={index === activeIndex ? "active" : ""}
              onClick={() => chooseScenario(index)}
              key={item.id}
            >
              <span>{item.number}</span>
              {item.label}
            </button>
          ))}
        </div>
        <button type="button" className="next-scenario" onClick={next}>Next scenario →</button>
      </header>

      <section className="scenario-context">
        <div className="viewer-card"><div className="avatar">{scenario.viewer.split(" ").map((part) => part[0]).join("")}</div><span><small>Viewing as</small><strong>{scenario.viewer}</strong></span></div>
        <StatusChip tone={scenario.role.includes("Admin") ? "pending" : scenario.role.includes("Owner") ? "private" : "published"}>{scenario.role}</StatusChip>
        <p>{scenario.summary}</p>
        <span className="demo-note">Demonstration only · no data is saved</span>
      </section>

      <div className="app-stage">
        {scenario.surface === "workspace" ? (
          <WorkspaceSurface scenario={scenario} onNext={next} onToast={showToast} />
        ) : scenario.surface === "skills" ? (
          <SkillsSurface scenario={scenario} onNext={next} onToast={showToast} />
        ) : (
          <RuntimeSurface onNext={next} onToast={showToast} />
        )}
      </div>

      {toast ? <div className="prototype-toast"><span>✓</span>{toast}</div> : null}
    </main>
  );
}
