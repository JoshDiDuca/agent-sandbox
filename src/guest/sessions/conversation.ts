// Which of Claude's conversation files (<claude config>\projects\<folder>\<uuid>.jsonl) belongs to a session, so the
// host can reopen exactly that one later.
import fs from 'node:fs';
import path from 'node:path';
import { isConversationId, pickConversation, type ConversationFile } from '../../shared/paths/conversation.js';
import { projectFolderName } from '../../shared/paths/claude-paths.js';
import { sandboxFolder } from '../../shared/paths/guest-paths.js';

/** Never stat more files than this in one look (a folder of years of conversations). */
const MAX_FILES = 2000;

/** The conversation files Claude keeps for sessions started in `cwd` (a mirrored drive has its real path too). */
export function conversationFiles(claudeDir: string, cwd: string): ConversationFile[] {
  const names = new Set([projectFolderName(cwd), projectFolderName(sandboxFolder(cwd))]);
  return [...names].flatMap((name) => {
    const dir = path.join(claudeDir, 'projects', name);
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      return []; // Claude has not written anything for this folder yet
    }
    return entries
      .filter((e) => e.endsWith('.jsonl') && isConversationId(e.slice(0, -'.jsonl'.length)))
      .slice(0, MAX_FILES)
      .flatMap((e) => {
        try {
          return [{ id: e.slice(0, -'.jsonl'.length), createdMs: fs.statSync(path.join(dir, e)).birthtimeMs }];
        } catch {
          return []; // gone since the listing
        }
      });
  });
}

/** This session's conversation, or null while Claude has not written one. */
export function findConversation(
  claudeDir: string,
  cwd: string,
  sessionStartMs: number,
  claimed: ReadonlySet<string>,
): string | null {
  return pickConversation(conversationFiles(claudeDir, cwd), sessionStartMs, claimed);
}
