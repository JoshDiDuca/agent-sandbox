// Which conversation of an agent a session is in, and the arguments that open that one again. Pure: the guest picks
// the conversation from the agent's own files, the host builds the command line from what the guest reported (so the
// id is checked here, whichever side calls).

/** Claude Code names a conversation file <uuid>.jsonl. */
export const CONVERSATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isConversationId(text: string): boolean {
  return CONVERSATION_ID.test(text);
}

/** One conversation file in the agent's project folder. */
export interface ConversationFile {
  /** The file name without .jsonl. */
  readonly id: string;
  /** When it was created (ms). */
  readonly createdMs: number;
}

/**
 * This session's conversation: of the files created since it started, the oldest not claimed by another session. The
 * oldest, because two sessions in one folder start a minute apart: each looks at the files when its own check runs,
 * and the first one's file is the older one. null while the agent has not written one yet.
 */
export function pickConversation(
  files: readonly ConversationFile[],
  sessionStartMs: number,
  claimed: ReadonlySet<string>,
): string | null {
  const candidates = files
    .filter((f) => isConversationId(f.id) && f.createdMs >= sessionStartMs && !claimed.has(f.id))
    .sort((a, b) => a.createdMs - b.createdMs || a.id.localeCompare(b.id));
  return candidates[0]?.id ?? null;
}

/** The ways an agent can be told to continue: the last conversation, or one by its id ({id} in the arguments). */
export interface ResumeArguments {
  readonly resumeArguments?: readonly string[];
  readonly resumeOneArguments?: readonly string[];
}

/** The arguments that continue `conversation` when the agent can open one by id, else the ones for its last one. */
export function resumeArgumentsFor(harness: ResumeArguments, conversation?: string): string[] {
  if (conversation && isConversationId(conversation) && harness.resumeOneArguments?.length)
    return harness.resumeOneArguments.map((a) => a.replace(/\{id\}/g, conversation));
  return [...(harness.resumeArguments ?? [])];
}
