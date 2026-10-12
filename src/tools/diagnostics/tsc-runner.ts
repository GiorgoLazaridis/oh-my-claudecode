/**
 * TypeScript Compiler Diagnostics Runner
 *
 * Executes `tsc --noEmit` to get project-level type checking diagnostics.
 */

import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import { platform } from 'os';

export interface TscDiagnostic {
  file: string;
  line: number;
  column: number;
  code: string;
  message: string;
  severity: 'error' | 'warning';
}

export interface TscResult {
  success: boolean;
  diagnostics: TscDiagnostic[];
  errorCount: number;
  warningCount: number;
  /** Raw compiler or invocation failure when no file-position diagnostic is available. */
  error?: string;
}

/**
 * Resolve the tsc binary path, preferring local node_modules over system PATH.
 * This fixes issues on Windows where execFileSync('tsc') fails to find the .cmd shim.
 */
function resolveTscBinary(directory: string): string {
  // Try to find tsc in local node_modules/.bin first
  const localBinDir = join(directory, 'node_modules', '.bin');
  const tscPath = join(localBinDir, 'tsc');
  
  if (existsSync(tscPath)) {
    return tscPath;
  }
  
  // Windows: check for .cmd shim explicitly
  if (platform() === 'win32') {
    const tscCmdPath = join(localBinDir, 'tsc.cmd');
    if (existsSync(tscCmdPath)) {
      return tscCmdPath;
    }
  }
  
  // Fall back to system tsc
  return 'tsc';
}

/**
 * Run TypeScript compiler diagnostics on a directory
 * @param directory - Project directory containing tsconfig.json
 * @returns Result with diagnostics, error count, and warning count
 */
export function runTscDiagnostics(directory: string): TscResult {
  const tsconfigPath = join(directory, 'tsconfig.json');

  if (!existsSync(tsconfigPath)) {
    return {
      success: true,
      diagnostics: [],
      errorCount: 0,
      warningCount: 0
    };
  }

  try {
    const tscBinary = resolveTscBinary(directory);
    execFileSync(tscBinary, ['--noEmit', '--pretty', 'false'], {
      cwd: directory,
      encoding: 'utf-8',
      stdio: 'pipe',
      shell: platform() === 'win32' ? true : undefined
    });
    return {
      success: true,
      diagnostics: [],
      errorCount: 0,
      warningCount: 0
    };
  } catch (error: any) {
    const output = error.stdout || error.stderr || '';
    const result = parseTscOutput(output);
    return {
      ...result,
      success: false,
      errorCount: Math.max(1, result.errorCount),
      ...(result.diagnostics.length === 0 ? { error: output.trim() || error.message } : {}),
    };
  }
}

/**
 * Parse TypeScript compiler output into structured diagnostics
 * Format: file(line,col): error TS1234: message
 */
function parseTscOutput(output: string): TscResult {
  const diagnostics: TscDiagnostic[] = [];

  // Parse tsc output format: file(line,col): error TS1234: message
  const regex = /^(.+)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s+(.+)$/gm;
  let match;

  while ((match = regex.exec(output)) !== null) {
    diagnostics.push({
      file: match[1],
      line: parseInt(match[2], 10),
      column: parseInt(match[3], 10),
      severity: match[4] as 'error' | 'warning',
      code: match[5],
      message: match[6]
    });
  }

  const errorCount = diagnostics.filter(d => d.severity === 'error').length;
  const warningCount = diagnostics.filter(d => d.severity === 'warning').length;

  return {
    success: errorCount === 0,
    diagnostics,
    errorCount,
    warningCount
  };
}
