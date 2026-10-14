import { fetchJson, fetchRetry, fetchText } from './http.js';

export interface ReleaseAsset {
  url: string;
  name: string;
  sha256: string | null;
}

interface GithubRelease {
  prerelease: boolean;
  draft: boolean;
  assets: { name: string; browser_download_url: string; digest?: string }[];
}

const toAsset = (asset: GithubRelease['assets'][number]): ReleaseAsset => ({
  url: asset.browser_download_url,
  name: asset.name,
  sha256: asset.digest?.startsWith('sha256:') ? asset.digest.slice(7) : null,
});

/**
 * Finds an asset in the latest GitHub release of `repo` (with its published sha256 when available). With
 * `searchOlder`, falls back to the newest stable release that still ships a matching asset (projects drop assets).
 */
export async function githubAsset(repo: string, pattern: RegExp, searchOlder = false): Promise<ReleaseAsset> {
  let latest: GithubRelease;
  try {
    latest = await fetchJson<GithubRelease>('https://api.github.com/repos/' + repo + '/releases/latest');
  } catch (e) {
    // The API allows 60 requests an hour per IP without a token; a first boot alone makes a dozen. The release page has
    // the same assets and digests and no such limit.
    if (!/HTTP (403|429)/.test(e instanceof Error ? e.message : '')) throw e;
    return githubAssetFromPage(repo, pattern, searchOlder);
  }
  const hit = latest.assets.find((a) => pattern.test(a.name));
  if (hit) return toAsset(hit);
  if (searchOlder) {
    const releases = await fetchJson<GithubRelease[]>(
      'https://api.github.com/repos/' + repo + '/releases?per_page=100',
    );
    for (const release of releases.filter((r) => !r.prerelease && !r.draft)) {
      const older = release.assets.find((a) => pattern.test(a.name));
      if (older) return toAsset(older);
    }
  }
  throw new Error(
    'No asset matching ' + pattern + ' in the ' + (searchOlder ? 'stable' : 'latest') + ' ' + repo + ' release(s)',
  );
}

/**
 * A release's assets from github.com's expanded_assets page (no API rate limit): each download link, then its sha256.
 */
export function parseReleasePage(html: string): ReleaseAsset[] {
  const links = [...html.matchAll(/href="(\/[^"]+\/releases\/download\/[^"]+)"/g)];
  return links.map((link, i) => {
    const digest =
      /sha256:([0-9a-f]{64})/.exec(html.slice(link.index, links[i + 1]?.index ?? html.length))?.[1] ?? null;
    return { url: 'https://github.com' + link[1], name: decodeURIComponent(link[1].split('/').pop()!), sha256: digest };
  });
}

/** The latest release's tag, from github.com's own redirect (no API, no rate limit). */
export async function latestGithubTag(repo: string): Promise<string> {
  const latest = await fetchRetry('https://github.com/' + repo + '/releases/latest', {}, 2, 20000);
  const tag = decodeURIComponent(latest.url.split('/releases/tag/')[1] ?? '');
  return tag || Promise.reject(new Error('Could not find the latest release of ' + repo));
}

/** Release tags in the order github.com's /<repo>/releases page lists them (newest first), without duplicates. */
export function parseReleaseTags(html: string, repo: string): string[] {
  const escaped = repo.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  const tags = [...html.matchAll(new RegExp('href="/' + escaped + '/releases/tag/([^"?#]+)"', 'gi'))].map((m) =>
    decodeURIComponent(m[1]),
  );
  return [...new Set(tags)];
}

/** How many releases the rate-limit fallback looks through for `searchOlder` (one page request each). */
const OLDER_RELEASES = 10;

const githubAssetFromPage = async (repo: string, pattern: RegExp, searchOlder: boolean): Promise<ReleaseAsset> => {
  const assetsOf = async (tag: string): Promise<ReleaseAsset | undefined> =>
    parseReleasePage(
      await fetchText('https://github.com/' + repo + '/releases/expanded_assets/' + encodeURIComponent(tag)),
    ).find((a) => pattern.test(a.name));
  const latest = await latestGithubTag(repo);
  const hit = await assetsOf(latest);
  if (hit) return hit;
  // nvm-windows' portable zip and winlibs' builds only exist in older releases: walk the release list like the API path
  // does.
  if (searchOlder) {
    const older = parseReleaseTags(await fetchText('https://github.com/' + repo + '/releases'), repo).filter(
      (t) => t !== latest,
    );
    for (const tag of older.slice(0, OLDER_RELEASES)) {
      const found = await assetsOf(tag);
      if (found) return found;
    }
  }
  throw new Error(
    'No asset matching ' + pattern + ' in ' + repo + ' ' + latest + (searchOlder ? ' or the releases before it' : ''),
  );
};
