// Type declarations for kb-guard-core.mjs (plain JS, no types shipped).
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const GREP_TOOLS: Set<string>;
export const RESET_TOOLS: Set<string>;
export const WARNING: string;
export const ESCALATION: string;

export interface Guard {
  note(toolName: string, input: Record<string, unknown>): string | null;
  readonly chain: number;
}

export function createGuard(): Guard;
