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
  /** Suspend enforcement for N model turns (clamped 1–20; returns applied turns). */
  suspend(turns: number): number;
  /** Advance the turn clock; expires a lapsed pause with a clean slate. */
  tickTurn(): void;
  readonly chain: number;
  readonly firings: number;
  readonly pausedTurns: number;
}

export function createGuard(): Guard;

/** True when any pipe/chain segment of the command leads with a search binary. */
export function isSearchHead(command: string | undefined): boolean;
