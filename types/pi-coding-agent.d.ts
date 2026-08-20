/**
 * Minimal type stub for the Pi coding agent host API (@earendil-works/pi-coding-agent).
 * The real package ships inside the harness; this stub lets the extensions
 * typecheck standalone in this repo. Replace with `npm i @earendil-works/pi-coding-agent`
 * if/when the package is published.
 */
declare module "@earendil-works/pi-coding-agent" {
	export interface ToolResult {
		content: { type: string; text?: string }[];
		details?: Record<string, unknown>;
	}
	export interface ToolResultEvent {
		toolName: string;
		isError?: boolean;
		input?: Record<string, unknown>;
		content?: { type?: string; text?: string }[];
	}
	export interface InputEvent {
		text?: string;
		action?: string;
	}
	export interface UserBashEvent {
		command: string;
	}
	export type EventMap = {
		tool_result: ToolResultEvent;
		input: InputEvent;
		user_bash: UserBashEvent;
	};
	export interface ExtensionAPI {
		registerTool(opts: {
			name: string;
			label?: string;
			description?: string;
			promptSnippet?: string;
			promptGuidelines?: string[];
			parameters?: unknown;
			execute: (
				id: string,
				params: Record<string, any>,
				signal?: AbortSignal
			) => Promise<ToolResult>;
		}): void;
		on<K extends keyof EventMap>(
			event: K,
			handler: (
				event: EventMap[K]
			) => Promise<Record<string, unknown>> | Record<string, unknown> | void
		): void;
		on(
			event: string,
			handler: (
				event: Record<string, unknown>
			) => Promise<Record<string, unknown>> | Record<string, unknown> | void
		): void;
	}
}
