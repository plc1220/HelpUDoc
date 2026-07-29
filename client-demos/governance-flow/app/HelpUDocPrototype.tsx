"use client";

import { useState } from "react";

type ScenarioId =
  | "private-owner"
  | "share-external"
  | "external-contributor"
  | "submit-update"
  | "skill-creator"
  | "admin-review"
  | "runtime-run"
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
    id: "share-external",
    number: "02",
    label: "Share published version",
    viewer: "Alice Chen",
    role: "Workspace Owner",
    summary:
      "Alice publishes a stable version, then gives Bob Contributor access without adding him to her team.",
    surface: "workspace",
  },
  {
    id: "external-contributor",
    number: "03",
    label: "External contributor",
    viewer: "Bob Rahman",
    role: "Workspace Contributor",
    summary:
      "Bob can read the published version and create his own private working copy, but cannot edit the published workspace.",
    surface: "workspace",
  },
  {
    id: "submit-update",
    number: "04",
    label: "Submit workspace update",
    viewer: "Bob Rahman",
    role: "Workspace Contributor",
    summary:
      "Bob’s work stays private until he submits a frozen update request for Alice to review.",
    surface: "workspace",
  },
  {
    id: "skill-creator",
    number: "05",
    label: "Create private skill",
    viewer: "Priya Nair",
    role: "Skill Creator",
    summary:
      "Priya builds and tests a private skill. The draft is not available to other users or the shared catalog.",
    surface: "skills",
  },
  {
    id: "admin-review",
    number: "06",
    label: "Review and assign skill",
    viewer: "Maya Wong",
    role: "Skill Catalog Admin",
    summary:
      "Maya reviews the frozen candidate, requested capabilities, and sandbox tests before approving and assigning it.",
    surface: "skills",
  },
  {
    id: "runtime-run",
    number: "07",
    label: "Governed runtime",
    viewer: "Priya Nair",
    role: "Skill Consumer · Sandbox Executor",
    summary:
      "A run proceeds only when the user, group, workspace, skill, connection, and sandbox gates all agree.",
    surface: "runtime",
  },
  {
    id: "annotate-published",
    number: "08",
    label: "Annotate published work",
    viewer: "Elena Garcia",
    role: "Workspace Commenter",
    summary:
      "Elena cannot edit version 3, but she can anchor a shared annotation, mention authorized collaborators, and create a team task.",
    surface: "workspace",
  },
  {
    id: "discussion-proposal",
    number: "09",
    label: "Turn discussion into proposal",
    viewer: "Bob Rahman",
    role: "Workspace Contributor",
    summary:
      "Bob turns the version-anchored discussion into a governed change proposal and private work without changing version 3.",
    surface: "workspace",
  },
];

const privateWorkspaces = [
  { name: "Customer research", meta: "Private · changes to publish" },
  { name: "Proposal sandbox", meta: "Private draft" },
  { name: "Q3 planning", meta: "Up to date" },
];

const publishedWorkspaces = [
  { name: "Product knowledge", meta: "Product Team · v8" },
  { name: "Customer research", meta: "Shared by Alice · v3" },
  { name: "Policy handbook", meta: "Operations · v12" },
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
  published,
}: {
  selected: string;
  published: boolean;
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
                  selected === workspace.name && !published ? "workspace-active" : ""
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
            <span>Published workspaces</span>
            <span>{publishedWorkspaces.length}</span>
          </div>
          <div className="workspace-list">
            {publishedWorkspaces.map((workspace) => (
              <button
                type="button"
                className={
                  selected === workspace.name && published ? "workspace-active" : ""
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
  submitState,
  collaborationState,
  onCollaborationAction,
}: {
  readOnly?: boolean;
  submitState?: boolean;
  collaborationState?: "annotate" | "proposal";
  onCollaborationAction?: () => void;
}) {
  const collaborating = Boolean(collaborationState);
  return (
    <section className={`document-canvas ${collaborating ? "collaboration-mode" : ""}`}>
      <div className="document-toolbar">
        <div>
          <Glyph>▤</Glyph>
          <span>Research / interview-summary.md</span>
          {readOnly ? <StatusChip tone="published">Read only</StatusChip> : null}
          {submitState ? <StatusChip tone="pending">4 unpublished changes</StatusChip> : null}
        </div>
        <div>
          <button type="button" className={!collaborating ? "toolbar-active" : ""}>Preview</button>
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
          <div className={submitState ? "changed-finding" : ""}>
            <span>03</span>
            <strong>Clear contribution boundaries</strong>
            <p>Contributors should propose changes without replacing the approved version.</p>
            {submitState ? <small>Edited in this private copy</small> : null}
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
            <b>Research group</b>
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
            <button type="button" className="primary-action" onClick={onCollaborationAction}>Convert to change proposal</button>
          </div>
        </aside>
      ) : null}
      {collaborating ? (
        <div className="sticky-tray">
          <div><span>Sticky note</span><strong>Confirm notification privacy</strong><small>Research group · open</small></div>
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
  const runtime = scenario === "runtime-run";
  const contributor = scenario === "external-contributor";
  const submit = scenario === "submit-update";
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
              I can create a change proposal linked to this thread, then open private work for you. Alice will still approve what becomes version 4.
            </div>
            <div className="tool-activity">
              <div><span className="pulse-dot"></span><strong>Proposal handoff</strong><small>Ready</small></div>
              <p>Origin version, content anchor, participants, and discussion summary will be preserved.</p>
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
              This version is read-only. Choose <strong>Work privately</strong> to make changes in your own copy.
            </div>
          </>
        ) : submit ? (
          <>
            <div className="user-message">Summarize what I changed before I submit it.</div>
            <div className="assistant-message">
              You clarified the contribution boundary and added evidence from the latest interviews. These changes are still private.
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

function ShareDialog({
  onNext,
}: {
  onNext: () => void;
}) {
  return (
    <div className="modal-layer">
      <div className="share-dialog" role="dialog" aria-modal="true" aria-labelledby="share-title">
        <div className="dialog-head">
          <div>
            <small>Published workspace</small>
            <h2 id="share-title">Manage access</h2>
          </div>
          <button type="button">×</button>
        </div>
        <p className="dialog-copy">
          Share the stable published version of <strong>Customer research</strong>.
          Your private workspace and conversations remain visible only to you.
        </p>
        <label className="people-search">
          <span>⌕</span>
          <input value="Bob Rahman" readOnly aria-label="Search registered users" />
          <StatusChip tone="pending">Registered user</StatusChip>
        </label>
        <div className="role-choice">
          <span>Role</span>
          <button type="button">Viewer</button>
          <button type="button">Commenter</button>
          <button type="button" className="selected">Contributor</button>
          <button type="button">Publisher</button>
        </div>
        <div className="policy-note">
          <Glyph>✓</Glyph>
          <div>
            <strong>Approval required</strong>
            <p>Bob can submit changes from a private copy. Alice approves what becomes published.</p>
          </div>
        </div>
        <div className="access-list">
          <span>People with access</span>
          <div><b className="avatar alice">AC</b><p><strong>Alice Chen</strong><small>Owner · Direct access</small></p><em>Owner</em></div>
          <div><b className="avatar bob">BR</b><p><strong>Bob Rahman</strong><small>Outside Product Team · Direct access</small></p><em>Contributor</em></div>
          <div><b className="avatar group">PT</b><p><strong>Product Team</strong><small>8 members · Group access</small></p><em>Viewer</em></div>
        </div>
        <div className="dialog-actions">
          <button type="button">Cancel</button>
          <button type="button" className="primary-action" onClick={onNext}>Update access</button>
        </div>
      </div>
    </div>
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
  const published =
    scenario.id === "share-external" ||
    scenario.id === "external-contributor" ||
    scenario.id === "annotate-published" ||
    scenario.id === "discussion-proposal";
  const collaborating =
    scenario.id === "annotate-published" || scenario.id === "discussion-proposal";
  const readOnly =
    scenario.id === "external-contributor" || collaborating;
  const submitting = scenario.id === "submit-update";
  const headerStatus = collaborating
    ? "Published · version 3 · 3 discussions"
    : published
      ? "Published · version 3"
      : submitting
        ? "Private copy · 4 changes"
        : "Private · only you";
  const action =
    scenario.id === "private-owner"
      ? "Publish workspace"
      : scenario.id === "share-external"
        ? "Manage access"
        : scenario.id === "external-contributor"
          ? "Work privately"
          : scenario.id === "annotate-published"
            ? "Notes & tasks"
            : scenario.id === "discussion-proposal"
              ? "Open discussions"
              : "Submit update";

  const triggerAction = () => {
    const messages: Record<string, string> = {
      "private-owner": "Published version 3 created. Your private workspace remains private.",
      "share-external": "Bob now has Contributor access.",
      "external-contributor": "Private working copy created for Bob.",
      "submit-update": "Update request sent to Alice for review.",
      "annotate-published": "Annotation sent to Priya, Alice, and the Research group.",
      "discussion-proposal": "Change proposal created. Bob can now work on it privately.",
    };
    onToast(messages[scenario.id]);
    onNext();
  };

  return (
    <div className="product-shell">
      <ProductRail />
      <WorkspaceDrawer selected="Customer research" published={published} />
      <div className="workspace-main">
        <header className="workspace-header">
          <div className="workspace-identity">
            <div className="workspace-icon">CR</div>
            <div>
              <span>{published ? "Published workspaces" : "Private workspaces"} /</span>
              <strong>Customer research</strong>
            </div>
            <StatusChip tone={published ? "published" : submitting ? "pending" : "private"}>
              {headerStatus}
            </StatusChip>
          </div>
          <div className="workspace-actions">
            {published ? <button type="button">Version history</button> : null}
            <button type="button" className="primary-action" onClick={triggerAction}>{action}</button>
            <button type="button">···</button>
          </div>
        </header>
        {collaborating ? (
          <div className="context-banner collaboration-banner">
            <span>Published content is read-only</span>
            Discussions, annotations, and tasks stay active in a separate collaboration layer.
            <button type="button" onClick={triggerAction}>{action}</button>
          </div>
        ) : readOnly ? (
          <div className="context-banner">
            <span>Published workspace</span>
            This is a stable read-only version shared directly with you by Alice Chen.
            <button type="button" onClick={triggerAction}>Work privately</button>
          </div>
        ) : submitting ? (
          <div className="context-banner contribution-banner">
            <span>Private working copy</span>
            Only you can see these changes. Submit an update when they are ready for Alice’s review.
            <button type="button" onClick={triggerAction}>Submit update</button>
          </div>
        ) : null}
        <div className="workspace-columns">
          <FilePane readOnly={readOnly} />
          <DocumentCanvas
            readOnly={readOnly}
            submitState={submitting}
            collaborationState={
              scenario.id === "annotate-published"
                ? "annotate"
                : scenario.id === "discussion-proposal"
                  ? "proposal"
                  : undefined
            }
            onCollaborationAction={triggerAction}
          />
          <LumoPane scenario={scenario.id} />
        </div>
      </div>
      {scenario.id === "share-external" ? <ShareDialog onNext={triggerAction} /> : null}
    </div>
  );
}

function SettingsSidebar({ review }: { review: boolean }) {
  return (
    <aside className="settings-sidebar">
      <div>
        <small>Administration</small>
        <button type="button"><Glyph>⌂</Glyph>Dashboard</button>
        <button type="button"><Glyph>♙</Glyph>Users &amp; Groups</button>
        <button type="button"><Glyph>◇</Glyph>Knowledge</button>
      </div>
      <div>
        <small>Agents</small>
        <button type="button" className="active"><Glyph>✦</Glyph>{review ? "Skill reviews" : "My skills"}</button>
        <button type="button"><Glyph>⌘</Glyph>Plugins &amp; Tools</button>
        <button type="button"><Glyph>⇄</Glyph>MCP servers</button>
      </div>
      <div className="settings-user">
        <div className="avatar alice">{review ? "MW" : "PN"}</div>
        <span><strong>{review ? "Maya Wong" : "Priya Nair"}</strong><small>{review ? "Platform Admin" : "Platform Member"}</small></span>
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
    onToast("Skill publication request submitted to the review queue.");
    onNext();
  };
  return (
    <div className="settings-main">
      <header className="settings-header">
        <div><small>Skills &amp; tooling</small><h1>My skills</h1><p>Create and test private skills before requesting publication.</p></div>
        <button type="button" className="primary-action">＋ Create skill</button>
      </header>
      <div className="skill-workbench">
        <aside className="skill-list-pane">
          <label className="search-box"><span>⌕</span><input placeholder="Search my skills" /></label>
          <div className="skill-filter"><button type="button" className="active">All</button><button type="button">Drafts</button><button type="button">In review</button></div>
          <button type="button" className="skill-list-item active">
            <div className="skill-symbol">✦</div>
            <span><strong>Research synthesis</strong><small>research-synthesis · edited 4m ago</small></span>
            <StatusChip tone="private">Private draft</StatusChip>
          </button>
          <button type="button" className="skill-list-item">
            <div className="skill-symbol muted">✦</div>
            <span><strong>Proposal helper</strong><small>proposal-helper · version 2</small></span>
            <StatusChip tone="published">Published</StatusChip>
          </button>
        </aside>
        <section className="skill-editor">
          <div className="skill-editor-head">
            <div><span className="skill-symbol">✦</span><div><small>Private skill draft</small><h2>Research synthesis</h2></div></div>
            <div><button type="button">Test privately</button><button type="button" className="primary-action" onClick={submit}>Submit for publication</button></div>
          </div>
          <div className="editor-tabs"><button type="button" className="active">Overview</button><button type="button">SKILL.md</button><button type="button">Scripts</button><button type="button">Test runs</button></div>
          <div className="skill-editor-body">
            <div className="field-block"><label>Description</label><div>Synthesize customer interviews and structured survey evidence into traceable research findings.</div></div>
            <div className="two-fields">
              <div className="field-block"><label>Owner</label><div><span className="avatar small-avatar">PN</span>Priya Nair</div></div>
              <div className="field-block"><label>Visibility</label><div><StatusChip tone="private">Only you</StatusChip></div></div>
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
            <div className="assistant-message">I updated the skill to require explicit workspace inputs and declared the analysis script for sandbox execution.</div>
            <div className="user-message">Check whether it is ready to submit.</div>
            <div className="assistant-message">All structural checks pass. The reviewer will see one MCP server and one sandbox script request.</div>
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
    onToast("Research synthesis approved and assigned to the Research group.");
    onNext();
  };
  return (
    <div className="settings-main">
      <header className="settings-header">
        <div><small>Governance</small><h1>Skill review queue</h1><p>Review frozen candidates before activation and group assignment.</p></div>
        <div className="review-count"><strong>3</strong><span>Awaiting review</span></div>
      </header>
      <div className="review-layout">
        <aside className="review-queue">
          <div className="queue-head"><strong>Publication requests</strong><button type="button">Filter</button></div>
          <button type="button" className="review-item active">
            <div className="avatar small-avatar">PN</div>
            <span><strong>Research synthesis</strong><small>Priya Nair · submitted 9m ago</small><em>1 script · 1 MCP server</em></span>
          </button>
          <button type="button" className="review-item">
            <div className="avatar small-avatar bob">BR</div>
            <span><strong>Contract extractor</strong><small>Bob Rahman · submitted 2h ago</small><em>2 tools · no scripts</em></span>
          </button>
          <button type="button" className="review-item">
            <div className="avatar small-avatar group">SL</div>
            <span><strong>Sales follow-up</strong><small>Sarah Lee · submitted yesterday</small><em>Gmail MCP · approval required</em></span>
          </button>
        </aside>
        <section className="review-detail">
          <div className="review-title">
            <div><small>Publication request · candidate v1</small><h2>Research synthesis</h2><p>Synthesize customer interviews and survey evidence into traceable findings.</p></div>
            <StatusChip tone="pending">Awaiting review</StatusChip>
          </div>
          <div className="review-meta">
            <div><span>Creator</span><strong>Priya Nair</strong></div>
            <div><span>Submitted</span><strong>29 Jul · 17:42</strong></div>
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
          <div><small>After approval</small><h3>Activate and assign</h3><p>Approval creates an immutable catalog version. Assignment controls who can invoke it.</p></div>
          <label>Active version<select aria-label="Active version"><option>Candidate version 1</option></select></label>
          <label>Assign to groups<div className="group-select"><span>Research</span><button type="button">×</button></div></label>
          <div className="assignment-note"><Glyph>i</Glyph><p>The Research group already has the required data-artifacts MCP entitlement and Sandbox Executor role.</p></div>
          <div className="review-actions"><button type="button">Request changes</button><button type="button" className="primary-action" onClick={approve}>Approve &amp; activate</button></div>
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
  const review = scenario.id === "admin-review";
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
  const [blocked, setBlocked] = useState(false);
  const checks = [
    ["Skill assignment", "Research group", true],
    ["Tool entitlement", "workspace_read", true],
    ["MCP entitlement", "data-artifacts", true],
    ["Workspace policy", "Customer research allows analysis", true],
    ["Skill declaration", blocked ? "undeclared shell command" : "analyze_research.py", !blocked],
    ["Sandbox policy", "Restricted Python · current-run outputs", true],
  ] as const;
  const run = () => {
    if (blocked) {
      onToast("Run blocked: the requested command is not declared by the active skill.");
    } else {
      onToast("All six checks passed. Sandboxed analysis started.");
      onNext();
    }
  };
  return (
    <div className="product-shell">
      <ProductRail />
      <WorkspaceDrawer selected="Customer research" published={false} />
      <div className="workspace-main">
        <header className="workspace-header">
          <div className="workspace-identity">
            <div className="workspace-icon">CR</div>
            <div><span>Private workspaces /</span><strong>Customer research</strong></div>
            <StatusChip tone="private">Private · only you</StatusChip>
          </div>
          <div className="workspace-actions"><button type="button">Runtime policy</button><button type="button">···</button></div>
        </header>
        <div className="workspace-columns runtime-columns">
          <FilePane />
          <section className="runtime-canvas">
            <div className="runtime-title">
              <div><small>Tool activity · authorization preview</small><h2>Research synthesis run</h2><p>HelpUDoc evaluates every governing layer at invocation time.</p></div>
              <StatusChip tone={blocked ? "blocked" : "allowed"}>{blocked ? "Will be blocked" : "Ready to run"}</StatusChip>
            </div>
            <div className="runtime-toggle">
              <button type="button" className={!blocked ? "active" : ""} onClick={() => setBlocked(false)}>Approved request</button>
              <button type="button" className={blocked ? "active danger" : ""} onClick={() => setBlocked(true)}>Undeclared command</button>
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
              <div><Glyph>⌘</Glyph><span><strong>Restricted Python sandbox</strong><small>No ambient credentials · network denied · workspace read-only</small></span></div>
              <div><span>CPU 1</span><span>Memory 1 GiB</span><span>Timeout 30s</span><span>Outputs isolated</span></div>
            </div>
            <div className="run-actions">
              <p>{blocked ? "The tool guard fails closed before any code is staged." : "Selected inputs: survey-results.xlsx and customer-quotes.csv"}</p>
              <button type="button" className={blocked ? "blocked-action" : "primary-action"} onClick={run}>{blocked ? "Demonstrate blocked run" : "Start governed run"}</button>
            </div>
          </section>
          <LumoPane scenario="runtime-run" />
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
