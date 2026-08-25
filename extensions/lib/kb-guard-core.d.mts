// Type declarations for kb-guard-core.mjs (plain JS, no types shipped).
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const GREP_TOOLS: Set<string>;
export const RESET_TOOLS: Set<string>;
export const WARNING: string;
export const ESCALATION: string;
export const BLOCK_REASON: string;

export interface BlockVerdict {
  block: true;
  reason: string;
}

export interface Guard {
  note(toolName: string, input: Record<string, unknown>): string | BlockVerdict | null;
  readonly chain: number;
}

export function createGuard(): Guard;

/** True when any pipe/chain segment of the command leads with a search binary. */
export function isSearchHead(command: string | undefined): boolean;
