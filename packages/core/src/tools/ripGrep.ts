/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';
import { EOL } from 'node:os';
import { spawn } from 'node:child_process';
import { downloadRipGrep } from '@joshua.litt/get-ripgrep';
import type { ToolInvocation, ToolResult } from './tools.js';
import { BaseDeclarativeTool, BaseToolInvocation, Kind } from './tools.js';
import { makeRelative, shortenPath } from '../utils/paths.js';
import { getErrorMessage } from '../utils/errors.js';
import type { Config } from '../config/config.js';
import { fileExists } from '../utils/fileUtils.js';
import { Storage } from '../config/storage.js';
import { resolveToolPath } from '../utils/pathResolution.js';

const DEFAULT_TOTAL_MAX_MATCHES = 20000;

function getRgPath(): string {
  return path.join(Storage.getGlobalBinDir(), 'rg');
}

/**
 * Checks if `rg` exists, if not then attempt to download it.
 */
export async function canUseRipgrep(): Promise<boolean> {
  if (await fileExists(getRgPath())) {
    return true;
  }

  await downloadRipGrep(Storage.getGlobalBinDir());
  return await fileExists(getRgPath());
}

/**
 * Ensures `rg` is downloaded, or throws.
 */
export async function ensureRgPath(): Promise<string> {
  if (await canUseRipgrep()) {
    return getRgPath();
  }
  throw new Error('Cannot use ripgrep.');
}

/**
 * Parameters for the GrepTool
 */
export interface RipGrepToolParams {
  /**
   * The regular expression pattern to search for in file contents
   */
  pattern: string;

  /**
   * The directory to search in (optional, defaults to current directory relative to root)
   */
  path?: string;

  /**
   * File pattern to include in the search (e.g. "*.js", "*.{ts,tsx}")
   */
  include?: string;
}

/**
 * Result object for a single grep match
 */
interface GrepMatch {
  filePath: string;
  lineNumber: number;
  line: string;
}

class GrepToolInvocation extends BaseToolInvocation<
  RipGrepToolParams,
  ToolResult
> {
  constructor(
    private readonly config: Config,
    params: RipGrepToolParams,
  ) {
    super(params);
  }

  async execute(signal: AbortSignal): Promise<ToolResult> {
    try {
      const workspaceContext = this.config.getWorkspaceContext();
      const searchDirDisplay = this.params.path || '.';

      // Determine which paths to search
      let searchPaths: readonly string[];

      if (this.params.path) {
        // 1. Resolve the path asynchronously
        const resolution = await resolveToolPath({
          inputPath: this.params.path,
          config: this.config,
          expectedType: 'either',
          allowNonExistent: false,
        });

        if (!resolution.success) {
          return {
            llmContent: resolution.error,
            returnDisplay: `Error: ${resolution.error}`,
            error: {
              message: resolution.error,
              type: resolution.errorType,
            },
          };
        }
        searchPaths = [resolution.absolutePath];
      } else {
        // No path specified - search all workspace directories
        searchPaths = workspaceContext.getDirectories();
      }

      let allMatches: GrepMatch[] = [];
      const totalMaxMatches = DEFAULT_TOTAL_MAX_MATCHES;

      if (this.config.getDebugMode()) {
        console.log(`[GrepTool] Total result limit: ${totalMaxMatches}`);
      }

      const targetDir = this.config.getTargetDir();

      for (const searchPath of searchPaths) {
        const searchResult = await this.performRipgrepSearch({
          pattern: this.params.pattern,
          path: searchPath,
          include: this.params.include,
          signal,
        });

        // Make paths relative to targetDir
        searchResult.forEach((match) => {
          match.filePath = path.relative(targetDir, match.filePath);
        });

        allMatches = allMatches.concat(searchResult);

        if (allMatches.length >= totalMaxMatches) {
          allMatches = allMatches.slice(0, totalMaxMatches);
          break;
        }
      }

      let searchLocationDescription: string;
      if (!this.params.path) {
        const numDirs = workspaceContext.getDirectories().length;
        searchLocationDescription =
          numDirs > 1
            ? `across ${numDirs} workspace directories`
            : `in the workspace directory`;
      } else {
        searchLocationDescription = `in path "${searchDirDisplay}"`;
      }

      if (allMatches.length === 0) {
        const noMatchMsg = `No matches found for pattern "${this.params.pattern}" ${searchLocationDescription}${this.params.include ? ` (filter: "${this.params.include}")` : ''}.`;
        return { llmContent: noMatchMsg, returnDisplay: `No matches found` };
      }

      const wasTruncated = allMatches.length >= totalMaxMatches;

      const matchesByFile = allMatches.reduce(
        (acc, match) => {
          const fileKey = match.filePath;
          if (!acc[fileKey]) {
            acc[fileKey] = [];
          }
          acc[fileKey].push(match);
          acc[fileKey].sort((a, b) => a.lineNumber - b.lineNumber);
          return acc;
        },
        {} as Record<string, GrepMatch[]>,
      );

      const matchCount = allMatches.length;
      const matchTerm = matchCount === 1 ? 'match' : 'matches';

      let llmContent = `Found ${matchCount} ${matchTerm} for pattern "${this.params.pattern}" ${searchLocationDescription}${this.params.include ? ` (filter: "${this.params.include}")` : ''}`;

      if (wasTruncated) {
        llmContent += ` (results limited to ${totalMaxMatches} matches for performance)`;
      }

      llmContent += `:\n---\n`;

      for (const filePath in matchesByFile) {
        llmContent += `File: ${filePath}\n`;
        matchesByFile[filePath].forEach((match) => {
          const trimmedLine = match.line.trim();
          llmContent += `L${match.lineNumber}: ${trimmedLine}\n`;
        });
        llmContent += '---\n';
      }

      let displayMessage = `Found ${matchCount} ${matchTerm}`;
      if (wasTruncated) {
        displayMessage += ` (limited)`;
      }

      return {
        llmContent: llmContent.trim(),
        returnDisplay: displayMessage,
      };
    } catch (error) {
      console.error(`Error during GrepLogic execution: ${error}`);
      const errorMessage = getErrorMessage(error);
      return {
        llmContent: `Error during grep search operation: ${errorMessage}`,
        returnDisplay: `Error: ${errorMessage}`,
      };
    }
  }

  private parseRipgrepOutput(output: string): GrepMatch[] {
    const results: GrepMatch[] = [];
    if (!output) return results;

    const lines = output.split(EOL);

    for (const line of lines) {
      if (!line.trim()) continue;

      const firstColonIndex = line.indexOf(':');
      if (firstColonIndex === -1) continue;

      const secondColonIndex = line.indexOf(':', firstColonIndex + 1);
      if (secondColonIndex === -1) continue;

      // ripgrep with --with-filename returns absolute paths
      const absoluteFilePath = line.substring(0, firstColonIndex);
      const lineNumberStr = line.substring(
        firstColonIndex + 1,
        secondColonIndex,
      );
      const lineContent = line.substring(secondColonIndex + 1);

      const lineNumber = parseInt(lineNumberStr, 10);

      if (!isNaN(lineNumber)) {
        results.push({
          filePath: absoluteFilePath,
          lineNumber,
          line: lineContent,
        });
      }
    }
    return results;
  }

  private async performRipgrepSearch(options: {
    pattern: string;
    path: string;
    include?: string;
    signal: AbortSignal;
  }): Promise<GrepMatch[]> {
    const { pattern, path: absolutePath, include } = options;

    const isFile = fs.statSync(absolutePath).isFile();

    const rgArgs = [
      '--line-number',
      '--no-heading',
      '--with-filename', // Ensures absolute paths in output
      '--ignore-case',
      '--regexp',
      pattern,
    ];

    // Only use include/exclude if searching a directory
    if (!isFile) {
      if (include) {
        rgArgs.push('--glob', include);
      }

      const excludes = [
        '.git',
        'node_modules',
        'bower_components',
        '*.log',
        '*.tmp',
        'build',
        'dist',
        'coverage',
      ];
      excludes.forEach((exclude) => {
        rgArgs.push('--glob', `!${exclude}`);
      });
    }

    rgArgs.push('--threads', '4');
    rgArgs.push(absolutePath);

    try {
      const rgPath = await ensureRgPath();
      const output = await new Promise<string>((resolve, reject) => {
        const child = spawn(rgPath, rgArgs, {
          windowsHide: true,
        });

        const stdoutChunks: Buffer[] = [];
        const stderrChunks: Buffer[] = [];

        const cleanup = () => {
          if (options.signal.aborted) {
            child.kill();
          }
        };

        options.signal.addEventListener('abort', cleanup, { once: true });

        child.stdout.on('data', (chunk) => stdoutChunks.push(chunk));
        child.stderr.on('data', (chunk) => stderrChunks.push(chunk));

        child.on('error', (err) => {
          options.signal.removeEventListener('abort', cleanup);
          reject(
            new Error(
              `Failed to start ripgrep: ${err.message}. Please ensure @lvce-editor/ripgrep is properly installed.`,
            ),
          );
        });

        child.on('close', (code) => {
          options.signal.removeEventListener('abort', cleanup);
          const stdoutData = Buffer.concat(stdoutChunks).toString('utf8');
          const stderrData = Buffer.concat(stderrChunks).toString('utf8');

          if (code === 0) {
            resolve(stdoutData);
          } else if (code === 1) {
            resolve(''); // No matches found
          } else {
            reject(
              new Error(`ripgrep exited with code ${code}: ${stderrData}`),
            );
          }
        });
      });

      return this.parseRipgrepOutput(output);
    } catch (error: unknown) {
      console.error(`GrepLogic: ripgrep failed: ${getErrorMessage(error)}`);
      throw error;
    }
  }

  /**
   * Gets a description of the grep operation
   * @param params Parameters for the grep operation
   * @returns A string describing the grep
   */
  getDescription(): string {
    let description = `'${this.params.pattern}'`;
    if (this.params.include) {
      description += ` in ${this.params.include}`;
    }
    if (this.params.path) {
      // Best effort relative path for display
      try {
        const relativePath = makeRelative(
          this.params.path,
          this.config.getTargetDir(),
        );
        description += ` within ${shortenPath(relativePath)}`;
      } catch {
        description += ` within ${this.params.path}`;
      }
    } else {
      // When no path is specified, indicate searching all workspace directories
      const workspaceContext = this.config.getWorkspaceContext();
      const directories = workspaceContext.getDirectories();
      if (directories.length > 1) {
        description += ` across all workspace directories`;
      }
    }
    return description;
  }
}

/**
 * Implementation of the Grep tool logic (moved from CLI)
 */
export class RipGrepTool extends BaseDeclarativeTool<
  RipGrepToolParams,
  ToolResult
> {
  static readonly Name = 'search_file_content';

  constructor(private readonly config: Config) {
    super(
      RipGrepTool.Name,
      'SearchText',
      'Searches file contents for a pattern. Use this tool to locate relevant files *before* reading them. Best Practice: Search directories to find all references; only search single files if you are certain of the location.',
      Kind.Search,
      {
        properties: {
          pattern: {
            description:
              "The exact string or regular expression (regex) to search for. Prefer simple, literal strings for exact matches (e.g., 'export class User'). Use regex only when necessary for flexible matching.",
            type: 'string',
          },
          path: {
            description:
              'Optional: The path to a specific file or directory to narrow the search scope. Can be absolute, relative to the workspace, or a unique filename. Defaults to the current working directory.',
            type: 'string',
          },
          include: {
            description:
              "Optional: A glob pattern to only search specific file types or patterns (e.g., '*.ts', 'src/controllers/**'). Use this to reduce noise in results.",
            type: 'string',
          },
        },
        required: ['pattern'],
        type: 'object',
      },
    );
  }

  protected createInvocation(
    params: RipGrepToolParams,
  ): ToolInvocation<RipGrepToolParams, ToolResult> {
    return new GrepToolInvocation(this.config, params);
  }
}
