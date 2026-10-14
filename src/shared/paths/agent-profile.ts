// Agents that keep their data in the sandbox's user profile (~/.qwen ...): each folder becomes a link to a folder in
// the persistent state, so the login survives the sandbox. Pure: the guest runs the links, the tests check the pairs.
import path from 'node:path';

/** A link to create (`link`) and the folder it points to (`target`). */
export interface ProfileLink {
  readonly link: string;
  readonly target: string;
}

const parts = (relative: string): string[] => relative.split(/[\\/]/).filter(Boolean);

/** Where the agent's profile folders live in the persistent state: state\<agent>\profile. */
export function agentProfileState(stateRoot: string, agent: string): string {
  return path.join(stateRoot, agent, 'profile');
}

/** The links for one agent: <profile>\<dir> -> state\<agent>\profile\<dir>, in the order given, without repeats. */
export function profileLinkPairs(
  agent: string,
  dirs: readonly string[],
  profileRoot: string,
  stateRoot: string,
): ProfileLink[] {
  const state = agentProfileState(stateRoot, agent);
  const seen = new Set<string>();
  return dirs.flatMap((dir) => {
    const link = path.join(profileRoot, ...parts(dir));
    const key = link.toLowerCase();
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ link, target: path.join(state, ...parts(dir)) }];
  });
}
