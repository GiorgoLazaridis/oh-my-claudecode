import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, symlinkSync, utimesSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT_PATH = join(__dirname, '..', '..', '..', 'templates', 'hooks', 'session-start.mjs');
const NODE = process.execPath;

describe('session-start template retired-state handling', () => {
  let tempDir: string;
  let fakeHome: string;
  let fakeProject: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'omc-session-start-template-'));
    fakeHome = join(tempDir, 'home');
    fakeProject = join(tempDir, 'project');
    mkdirSync(join(fakeProject, '.omc', 'state'), { recursive: true });
    // Add .git so validateCwd accepts this directory as a valid workspace anchor
    mkdirSync(join(fakeProject, '.git'), { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function runSessionStart(input: Record<string, unknown>, extraEnv: Record<string, string> = {}) {
    const raw = execFileSync(NODE, [SCRIPT_PATH], {
      input: JSON.stringify(input),
      encoding: 'utf-8',
      env: {
        ...process.env,
        HOME: fakeHome,
        USERPROFILE: fakeHome,
        ...extraEnv,
      },
      timeout: 15000,
    }).trim();

    return JSON.parse(raw) as {
      continue: boolean;
      suppressOutput?: boolean;
      hookSpecificOutput?: { additionalContext?: string };
    };
  }

  it('ignores retired ultrawork state from a different active session', () => {
    const now = new Date().toISOString();
    writeFileSync(
      join(fakeProject, '.omc', 'state', 'ultrawork-state.json'),
      JSON.stringify({
        active: true,
        session_id: 'session-a',
        started_at: now,
        last_checked_at: now,
        original_prompt: 'Old task that should not bleed into session-b',
      }),
    );

    const output = runSessionStart({
      hook_event_name: 'SessionStart',
      session_id: 'session-b',
      cwd: fakeProject,
    });

    const context = output.hookSpecificOutput?.additionalContext || '';
    expect(output.continue).toBe(true);
    expect(context).not.toContain('[PARALLEL SESSION WARNING]');
    expect(context).not.toContain('[ULTRAWORK MODE RESTORED]');
    expect(context).not.toContain('Old task that should not bleed into session-b');
  });

  it('purges legacy tool-failure state without disturbing unrelated inactive-session state', () => {
    const stateDir = join(fakeProject, '.omc', 'state');
    const oldSessionDir = join(stateDir, 'sessions', 'session-old-without-marker');
    mkdirSync(oldSessionDir, { recursive: true });
    const legacyRootError = join(stateDir, 'last-tool-error.json');
    const legacySessionError = join(oldSessionDir, 'last-tool-error-state.json');
    const unrelatedState = join(oldSessionDir, 'unrelated-state.json');
    writeFileSync(legacyRootError, JSON.stringify({ tool_input_preview: 'legacy input secret', error: 'legacy raw error' }));
    writeFileSync(legacySessionError, JSON.stringify({ tool_input_preview: 'legacy input secret', error: 'legacy raw error' }));
    writeFileSync(unrelatedState, 'preserve this state');

    const output = runSessionStart({
      hook_event_name: 'SessionStart',
      session_id: 'session-current',
      cwd: fakeProject,
    }, { CLAUDE_PLUGIN_ROOT: '', OMC_STATE_DIR: '' });

    expect(output.continue).toBe(true);
    expect(existsSync(legacyRootError)).toBe(false);
    expect(existsSync(legacySessionError)).toBe(false);
    expect(existsSync(join(oldSessionDir, 'session-started.json'))).toBe(false);
    expect(readFileSync(unrelatedState, 'utf-8')).toBe('preserve this state');
  });

  it('preserves sanitized canonical tool-failure records and their retry counts', () => {
    const stateDir = join(fakeProject, '.omc', 'state');
    const sessionDir = join(stateDir, 'sessions', 'session-retry-state');
    mkdirSync(sessionDir, { recursive: true });
    const rootPath = join(stateDir, 'last-tool-error.json');
    const sessionPath = join(sessionDir, 'last-tool-error-state.json');
    const rootState = {
      tool_name: 'Bash',
      error: 'Tool execution failed (details omitted for privacy).',
      timestamp: new Date().toISOString(),
      retry_count: 4,
    };
    const sessionState = { ...rootState, retry_count: 7 };
    writeFileSync(rootPath, JSON.stringify(rootState));
    writeFileSync(sessionPath, JSON.stringify(sessionState));

    const output = runSessionStart({
      hook_event_name: 'SessionStart',
      session_id: 'session-current',
      cwd: fakeProject,
    }, { CLAUDE_PLUGIN_ROOT: '', OMC_STATE_DIR: '' });

    expect(output.continue).toBe(true);
    expect(JSON.parse(readFileSync(rootPath, 'utf-8'))).toEqual(rootState);
    expect(JSON.parse(readFileSync(sessionPath, 'utf-8'))).toEqual(sessionState);
  });

  it('removes stale tool-failure atomic temps at root and session scope but retains fresh temps', () => {
    const stateDir = join(fakeProject, '.omc', 'state');
    const sessionDir = join(stateDir, 'sessions', 'session-temp-files');
    mkdirSync(sessionDir, { recursive: true });
    const stalePaths = [
      join(stateDir, `.last-tool-error.json.tmp.${randomUUID()}`),
      join(stateDir, `.last-tool-error-state.json.tmp.${randomUUID()}`),
      join(sessionDir, `.last-tool-error.json.tmp.${randomUUID()}`),
      join(sessionDir, `.last-tool-error-state.json.tmp.${randomUUID()}`),
    ];
    for (const path of stalePaths) writeFileSync(path, 'orphaned atomic temp');
    const staleTime = new Date(Date.now() - 61_000);
    for (const path of stalePaths) utimesSync(path, staleTime, staleTime);

    const freshPath = join(stateDir, `.last-tool-error.json.tmp.${randomUUID()}`);
    const unrelatedTempPath = join(stateDir, '.last-tool-error.json.tmp.not-a-uuid');
    writeFileSync(freshPath, 'active atomic temp');
    writeFileSync(unrelatedTempPath, 'not an atomic temp name');
    utimesSync(unrelatedTempPath, staleTime, staleTime);

    const output = runSessionStart({
      hook_event_name: 'SessionStart',
      session_id: 'session-current',
      cwd: fakeProject,
    }, { CLAUDE_PLUGIN_ROOT: '', OMC_STATE_DIR: '' });

    expect(output.continue).toBe(true);
    for (const path of stalePaths) expect(existsSync(path)).toBe(false);
    expect(existsSync(freshPath)).toBe(true);
    expect(existsSync(unrelatedTempPath)).toBe(true);
  });

  it('purges legacy tool-failure state from the home root on no-workspace startup', () => {
    const homeStateDir = join(fakeHome, '.omc', 'state');
    const homeSessionDir = join(homeStateDir, 'sessions', 'session-old-home');
    const otherWorkspaceRecord = join(fakeProject, '.omc', 'state', 'last-tool-error.json');
    mkdirSync(homeSessionDir, { recursive: true });
    const homeRootRecord = join(homeStateDir, 'last-tool-error.json');
    const homeSessionRecord = join(homeSessionDir, 'last-tool-error-state.json');
    writeFileSync(homeRootRecord, JSON.stringify({ tool_input_preview: 'legacy home secret' }));
    writeFileSync(homeSessionRecord, JSON.stringify({ tool_input_preview: 'legacy home session secret' }));
    writeFileSync(otherWorkspaceRecord, JSON.stringify({ tool_input_preview: 'unrelated workspace secret' }));

    const output = runSessionStart({
      hook_event_name: 'SessionStart',
      session_id: 'session-no-workspace',
      cwd: tempDir,
    }, { CLAUDE_PLUGIN_ROOT: '', OMC_STATE_DIR: '' });

    expect(output.continue).toBe(true);
    expect(existsSync(homeRootRecord)).toBe(false);
    expect(existsSync(homeSessionRecord)).toBe(false);
    expect(existsSync(otherWorkspaceRecord)).toBe(true);

    const customRoot = join(tempDir, 'custom-state');
    const customStateDir = join(customRoot, 'non-git', 'state');
    const customSessionDir = join(customStateDir, 'sessions', 'session-old-custom');
    mkdirSync(customSessionDir, { recursive: true });
    const customRootRecord = join(customStateDir, 'last-tool-error.json');
    const customSessionRecord = join(customSessionDir, 'last-tool-error-state.json');
    writeFileSync(customRootRecord, JSON.stringify({ tool_input_preview: 'legacy custom-root secret' }));
    writeFileSync(customSessionRecord, JSON.stringify({ tool_input_preview: 'legacy custom-session secret' }));

    const customOutput = runSessionStart({
      hook_event_name: 'SessionStart',
      session_id: 'session-no-workspace-custom',
      cwd: tempDir,
    }, { CLAUDE_PLUGIN_ROOT: '', OMC_STATE_DIR: customRoot });

    expect(customOutput.continue).toBe(true);
    expect(existsSync(customRootRecord)).toBe(false);
    expect(existsSync(customSessionRecord)).toBe(false);
    expect(existsSync(otherWorkspaceRecord)).toBe(true);
  });

  it.skipIf(process.platform === 'win32')('does not follow symlinked session directories or state files', () => {
    const sessionsDir = join(fakeProject, '.omc', 'state', 'sessions');
    mkdirSync(sessionsDir, { recursive: true });
    const externalSessionDir = join(tempDir, 'external-session');
    mkdirSync(externalSessionDir, { recursive: true });
    const externalDirectoryState = join(externalSessionDir, 'last-tool-error-state.json');
    writeFileSync(externalDirectoryState, 'preserve through directory symlink');
    const directoryLink = join(sessionsDir, 'session-directory-link');
    symlinkSync(externalSessionDir, directoryLink, 'dir');

    const fileSessionDir = join(sessionsDir, 'session-file-link');
    mkdirSync(fileSessionDir, { recursive: true });
    const externalFileState = join(tempDir, 'external-state.json');
    writeFileSync(externalFileState, 'preserve through file symlink');
    const fileLink = join(fileSessionDir, 'last-tool-error-state.json');
    symlinkSync(externalFileState, fileLink, 'file');

    runSessionStart({
      hook_event_name: 'SessionStart',
      session_id: 'session-current',
      cwd: fakeProject,
    }, { CLAUDE_PLUGIN_ROOT: '', OMC_STATE_DIR: '' });

    expect(existsSync(directoryLink)).toBe(true);
    expect(existsSync(externalDirectoryState)).toBe(true);
    expect(existsSync(fileLink)).toBe(true);
    expect(existsSync(externalFileState)).toBe(true);
  });

  it('keeps template session-start under budget when only a tiny omission remainder remains', () => {
    writeFileSync(
      join(fakeProject, '.omc', 'state', 'ultrawork-state.json'),
      JSON.stringify({
        active: true,
        session_id: 'session-budget-owner',
        started_at: '2026-04-23T00:00:00.000Z',
        last_checked_at: '2026-04-23T00:05:00.000Z',
        original_prompt: 'budget '.repeat(520),
      }),
    );
    writeFileSync(
      join(fakeProject, 'AGENTS.md'),
      `# oh-my-claudecode - Intelligent Multi-Agent Orchestration

<guidance_schema_contract>schema</guidance_schema_contract>

<operating_principles>
${'- preserve this startup guidance\n'.repeat(400)}
</operating_principles>`,
    );

    const output = runSessionStart({
      hook_event_name: 'SessionStart',
      session_id: 'session-budget-owner',
      cwd: fakeProject,
    });

    const context = output.hookSpecificOutput?.additionalContext || '';
    expect(output.continue).toBe(true);
    expect(context.length).toBeLessThanOrEqual(6000);
  });

  it('compacts large OMC AGENTS guidance and caps aggregate session context', () => {
    mkdirSync(fakeProject, { recursive: true });
    const largeAgents = [
      '# oh-my-claudecode - Intelligent Multi-Agent Orchestration',
      '<guidance_schema_contract>schema details</guidance_schema_contract>',
      '<operating_principles>keep this high value section</operating_principles>',
      '<agent_catalog>' + 'agent '.repeat(5000) + '</agent_catalog>',
      '<skills>' + 'skill '.repeat(5000) + '</skills>',
      '<team_compositions>' + 'team '.repeat(5000) + '</team_compositions>',
      '<verification>verify before claiming completion</verification>',
    ].join('\n\n');
    writeFileSync(join(fakeProject, 'AGENTS.md'), largeAgents);

    const output = runSessionStart({
      hook_event_name: 'SessionStart',
      session_id: 'session-large-agents',
      cwd: fakeProject,
    });

    const context = output.hookSpecificOutput?.additionalContext || '';
    expect(output.continue).toBe(true);
    expect(context).toContain('[ROOT AGENTS.md LOADED]');
    expect(context).toContain('<operating_principles>keep this high value section</operating_principles>');
    expect(context).toContain('<verification>verify before claiming completion</verification>');
    expect(context).not.toContain('<agent_catalog>');
    expect(context).not.toContain('<skills>');
    expect(context.length).toBeLessThanOrEqual(6000);
  });

  it('does not restore retired ultrawork for the owning session', () => {
    writeFileSync(
      join(fakeProject, '.omc', 'state', 'ultrawork-state.json'),
      JSON.stringify({
        active: true,
        session_id: 'session-owner',
        started_at: '2026-03-19T00:00:00.000Z',
        last_checked_at: '2026-03-19T00:05:00.000Z',
        original_prompt: 'Resume me',
      }),
    );

    const output = runSessionStart({
      hook_event_name: 'SessionStart',
      session_id: 'session-owner',
      cwd: fakeProject,
    });

    const context = output.hookSpecificOutput?.additionalContext || '';
    expect(output.continue).toBe(true);
    expect(context).not.toContain('[ULTRAWORK MODE RESTORED]');
    expect(context).not.toContain('Resume me');
    expect(context).not.toContain('[PARALLEL SESSION WARNING]');
  });

  it('does not warn for global fallback state from a different normalized project path', () => {
    mkdirSync(join(fakeHome, '.omc', 'state'), { recursive: true });
    writeFileSync(
      join(fakeHome, '.omc', 'state', 'ultrawork-state.json'),
      JSON.stringify({
        active: true,
        session_id: 'session-a',
        started_at: '2026-03-19T00:00:00.000Z',
        last_checked_at: '2026-03-19T00:05:00.000Z',
        original_prompt: 'Different project task',
        project_path: join(tempDir, 'other-project'),
      }),
    );

    const output = runSessionStart({
      hook_event_name: 'SessionStart',
      session_id: 'session-b',
      cwd: fakeProject,
    });

    expect(output.continue).toBe(true);
    const context = output.hookSpecificOutput?.additionalContext || '';
    expect(context).not.toContain('[PARALLEL SESSION WARNING]');
    expect(context).not.toContain('[ULTRAWORK MODE RESTORED]');
  });

  it('keeps model routing override under budget for non-standard providers', () => {
    writeFileSync(
      join(fakeProject, 'AGENTS.md'),
      `# oh-my-claudecode - Intelligent Multi-Agent Orchestration

<guidance_schema_contract>schema</guidance_schema_contract>

<operating_principles>
${'- oversized startup guidance\n'.repeat(700)}
</operating_principles>`,
    );

    const output = runSessionStart({
      hook_event_name: 'SessionStart',
      session_id: 'session-bedrock-template',
      cwd: fakeProject,
    }, {
      CLAUDE_CODE_USE_BEDROCK: '1',
    });

    const context = output.hookSpecificOutput?.additionalContext || '';
    expect(output.continue).toBe(true);
    expect(context).toContain('[MODEL ROUTING OVERRIDE');
    expect(context).toContain('tier alias');
    expect(context).toMatch(/\b(sonnet|opus|haiku)\b/);
    expect(context).not.toContain('Do NOT pass the `model` parameter');
    expect(context).not.toContain('Omit it entirely');
    expect(context.length).toBeLessThanOrEqual(6000);
  });

  it('surfaces update notices through systemMessage without injecting them into additionalContext', () => {
    const omcDir = join(fakeHome, '.claude', '.omc');
    mkdirSync(omcDir, { recursive: true });
    writeFileSync(
      join(omcDir, 'update-check.json'),
      JSON.stringify({
        timestamp: Date.now(),
        latestVersion: '999.0.0',
        currentVersion: '1.0.0',
        updateAvailable: true,
      }),
    );

    const result = spawnSync(NODE, [SCRIPT_PATH], {
      input: JSON.stringify({
        hook_event_name: 'SessionStart',
        session_id: 'session-update-visible',
        cwd: fakeProject,
      }),
      encoding: 'utf-8',
      env: {
        ...process.env,
        HOME: fakeHome,
        USERPROFILE: fakeHome,
      },
      timeout: 15000,
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    const output = JSON.parse(result.stdout) as {
      continue: boolean;
      systemMessage?: string;
      hookSpecificOutput?: { additionalContext?: string };
    };
    expect(output.continue).toBe(true);
    expect(output.systemMessage).toContain('[OMC UPDATE AVAILABLE]');
    expect(output.systemMessage).toContain('v999.0.0');
    expect(output.systemMessage).toContain('/update');
    expect(output.hookSpecificOutput?.additionalContext ?? '').not.toContain('[OMC UPDATE AVAILABLE]');
    expect(output.hookSpecificOutput?.additionalContext ?? '').not.toContain('999.0.0');
  });

  it('honors autoUpgradePrompt=false with passive systemMessage wording', () => {
    const omcDir = join(fakeHome, '.claude', '.omc');
    mkdirSync(omcDir, { recursive: true });
    writeFileSync(join(fakeHome, '.claude', '.omc-config.json'), JSON.stringify({ autoUpgradePrompt: false }));
    writeFileSync(
      join(omcDir, 'update-check.json'),
      JSON.stringify({
        timestamp: Date.now(),
        latestVersion: '999.0.0',
        currentVersion: '1.0.0',
        updateAvailable: true,
      }),
    );

    const result = spawnSync(NODE, [SCRIPT_PATH], {
      input: JSON.stringify({
        hook_event_name: 'SessionStart',
        session_id: 'session-update-passive',
        cwd: fakeProject,
      }),
      encoding: 'utf-8',
      env: {
        ...process.env,
        HOME: fakeHome,
        USERPROFILE: fakeHome,
      },
      timeout: 15000,
    });

    const output = JSON.parse(result.stdout) as { systemMessage?: string };
    expect(output.systemMessage).toContain('To update later, run: omc update');
    expect(output.systemMessage).not.toContain('Run /update to upgrade now');
  });

});

// ==========================================================================
// E.2 — PID-aware liveness in session-start template (Wave E)
// ==========================================================================

describe('session-start template cwd validation (Wave B1)', () => {
  let tempDir: string;
  let fakeHome: string;
  let emptyCwd: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'omc-session-start-cwdval-'));
    fakeHome = join(tempDir, 'home');
    mkdirSync(fakeHome, { recursive: true });
    // A truly empty directory with no .omc-workspace or .git marker.
    // Keep it under fakeHome so validateCwd stops before ambient /tmp markers.
    emptyCwd = mkdtempSync(join(fakeHome, 'omc-empty-cwd-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    rmSync(emptyCwd, { recursive: true, force: true });
  });

  function runSessionStartRaw(input: Record<string, unknown>, extraEnv: Record<string, string> = {}) {
    const result = spawnSync(process.execPath, [SCRIPT_PATH], {
      input: JSON.stringify(input),
      encoding: 'utf-8',
      env: {
        ...process.env,
        HOME: fakeHome,
        USERPROFILE: fakeHome,
        ...extraEnv,
      },
      timeout: 15000,
    });
    return {
      stdout: result.stdout?.trim() ?? '',
      stderr: result.stderr?.trim() ?? '',
      status: result.status,
    };
  }

  it('emits warning to stderr and outputs no-op JSON when cwd has no .omc-workspace or .git marker', () => {
    // emptyCwd is a real temp dir with no markers — cross-platform guaranteed
    const { stdout, stderr } = runSessionStartRaw({
      hook_event_name: 'SessionStart',
      session_id: 'session-empty-cwd',
      cwd: emptyCwd,
    });

    // Must warn on stderr
    expect(stderr).toContain('[OMC] session-start: refusing to use cwd');
    expect(stderr).toContain('no .omc-workspace or .git marker');

    // Output must be a valid JSON with continue:true and no hookSpecificOutput with state writes
    const parsed = JSON.parse(stdout) as { continue: boolean; hookSpecificOutput?: unknown };
    expect(parsed.continue).toBe(true);
    expect(parsed.hookSpecificOutput).toBeUndefined();

    // Must NOT have written any state files into the empty dir
    expect(existsSync(join(emptyCwd, '.omc'))).toBe(false);
  });

  it('does NOT warn or skip when cwd contains a .git directory', () => {
    const gitProject = mkdtempSync(join(tmpdir(), 'omc-git-project-'));
    try {
      mkdirSync(join(gitProject, '.git'), { recursive: true });
      mkdirSync(join(gitProject, '.omc', 'state'), { recursive: true });

      const { stderr, stdout } = runSessionStartRaw({
        hook_event_name: 'SessionStart',
        session_id: 'session-git-cwd',
        cwd: gitProject,
      });

      // Should NOT emit the warning
      expect(stderr).not.toContain('[OMC] session-start: refusing to use cwd');

      // Should produce normal hook output (continue: true)
      const parsed = JSON.parse(stdout) as { continue: boolean };
      expect(parsed.continue).toBe(true);
    } finally {
      rmSync(gitProject, { recursive: true, force: true });
    }
  });

  it('does NOT warn or skip when cwd contains a .omc-workspace marker', () => {
    const wsProject = mkdtempSync(join(tmpdir(), 'omc-ws-project-'));
    try {
      writeFileSync(join(wsProject, '.omc-workspace'), '{}');
      mkdirSync(join(wsProject, '.omc', 'state'), { recursive: true });

      const { stderr, stdout } = runSessionStartRaw({
        hook_event_name: 'SessionStart',
        session_id: 'session-ws-cwd',
        cwd: wsProject,
      });

      expect(stderr).not.toContain('[OMC] session-start: refusing to use cwd');

      const parsed = JSON.parse(stdout) as { continue: boolean };
      expect(parsed.continue).toBe(true);
    } finally {
      rmSync(wsProject, { recursive: true, force: true });
    }
  });

  it('does NOT warn or skip when cwd is a SUBDIRECTORY of a .git repo (walks up)', () => {
    const gitProject = mkdtempSync(join(tmpdir(), 'omc-git-subdir-'));
    try {
      mkdirSync(join(gitProject, '.git'), { recursive: true });
      mkdirSync(join(gitProject, '.omc', 'state'), { recursive: true });
      const nested = join(gitProject, 'packages', 'app', 'src');
      mkdirSync(nested, { recursive: true });

      const { stderr, stdout } = runSessionStartRaw({
        hook_event_name: 'SessionStart',
        session_id: 'session-git-subdir',
        cwd: nested,
      });

      // A subdirectory of a real repo must be accepted, not rejected.
      expect(stderr).not.toContain('[OMC] session-start: refusing to use cwd');

      const parsed = JSON.parse(stdout) as { continue: boolean };
      expect(parsed.continue).toBe(true);
    } finally {
      rmSync(gitProject, { recursive: true, force: true });
    }
  });

  it('does NOT warn or skip when cwd is a nested SUBDIR whose only anchor is a .omc-workspace at an ancestor (no .git anywhere)', () => {
    const wsRoot = mkdtempSync(join(tmpdir(), 'omc-ws-ancestor-'));
    try {
      // Place .omc-workspace at the ancestor root (no .git anywhere)
      writeFileSync(join(wsRoot, '.omc-workspace'), '{}');
      // cwd is a deeply nested subdirectory — no .git, no .omc-workspace at this level
      const nested = join(wsRoot, 'packages', 'app', 'src');
      mkdirSync(nested, { recursive: true });

      const { stderr, stdout } = runSessionStartRaw(
        {
          hook_event_name: 'SessionStart',
          session_id: 'session-ws-ancestor-subdir',
          cwd: nested,
        },
        { HOME: fakeHome, USERPROFILE: fakeHome },
      );

      // validateCwd must walk up, find .omc-workspace at wsRoot, and accept
      expect(stderr).not.toContain('[OMC] session-start: refusing to use cwd');

      const parsed = JSON.parse(stdout) as { continue: boolean };
      expect(parsed.continue).toBe(true);
    } finally {
      rmSync(wsRoot, { recursive: true, force: true });
    }
  });
});
