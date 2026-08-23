import { TranslationFunc } from '@/hooks/useTranslation';
import { isUpdateNewer } from '@/utils/version';
import { READEST_UPDATER_FILE, READEST_NIGHTLY_UPDATER_FILE } from '@/services/constants';

type FetchFn = typeof fetch;

export interface UpdateManifestEntry {
  url?: string;
  signature?: string;
}
export interface UpdateManifest {
  version: string;
  pub_date?: string;
  notes?: string;
  platforms: Record<string, UpdateManifestEntry>;
}
export interface ResolvedNightlyUpdate {
  endpoint: string; // manifest URL (for the Tauri UpdaterBuilder path)
  version: string;
  notes?: string;
  pubDate?: string;
  platformKey: string;
  url: string; // artifact URL (for the custom install flows)
  signature: string; // artifact signature
}

export const getNightlyPlatformKey = (
  osTypeVal: string,
  osArchVal: string,
  isPortable: boolean,
  isAppImage: boolean,
): string | null => {
  if (osTypeVal === 'android')
    return osArchVal === 'aarch64' ? 'android-arm64' : 'android-universal';
  if (osTypeVal === 'macos') return osArchVal === 'aarch64' ? 'darwin-aarch64' : 'darwin-x86_64';
  // Match the arch explicitly so a 32-bit (or otherwise unknown) arch yields no
  // nightly rather than mis-routing to aarch64.
  if (osTypeVal === 'windows') {
    if (osArchVal === 'x86_64') return isPortable ? 'windows-x86_64-portable' : 'windows-x86_64';
    if (osArchVal === 'aarch64') return isPortable ? 'windows-aarch64-portable' : 'windows-aarch64';
    return null;
  }
  if (osTypeVal === 'linux') {
    // Nightly Linux is AppImage-only; a deb/rpm install has no nightly
    // artifact, so it cleanly gets no nightly rather than mis-routing.
    if (isAppImage) {
      if (osArchVal === 'x86_64') return 'linux-x86_64-appimage';
      if (osArchVal === 'aarch64') return 'linux-aarch64-appimage';
    }
    return null;
  }
  return null;
};

const fetchManifest = async (fetchFn: FetchFn, url: string): Promise<UpdateManifest | null> => {
  try {
    const res = await fetchFn(url, { connectTimeout: 5000 } as RequestInit);
    if (!res.ok) return null;
    return (await res.json()) as UpdateManifest;
  } catch (err) {
    console.warn('Failed to fetch update manifest', url, err);
    return null;
  }
};

// Nightly channel resolution: fetch the nightly + stable manifests, keep only
// candidates that (a) have a usable artifact for this platform and (b) are newer
// than the installed version, then return the newest by the base-aware rule.
export const resolveNightlyUpdate = async (
  currentVersion: string,
  platformKey: string,
  fetchFn: FetchFn,
): Promise<ResolvedNightlyUpdate | null> => {
  const [nightly, stable] = await Promise.all([
    fetchManifest(fetchFn, READEST_NIGHTLY_UPDATER_FILE),
    fetchManifest(fetchFn, READEST_UPDATER_FILE),
  ]);
  const sources: Array<[UpdateManifest | null, string]> = [
    [nightly, READEST_NIGHTLY_UPDATER_FILE],
    [stable, READEST_UPDATER_FILE],
  ];
  const candidates: ResolvedNightlyUpdate[] = [];
  for (const [manifest, endpoint] of sources) {
    if (!manifest?.version) continue;
    const entry = manifest.platforms?.[platformKey];
    if (!entry?.url || !entry?.signature) continue; // platform-eligibility filter
    if (!isUpdateNewer(manifest.version, currentVersion)) continue;
    candidates.push({
      endpoint,
      version: manifest.version,
      notes: manifest.notes,
      pubDate: manifest.pub_date,
      platformKey,
      url: entry.url,
      signature: entry.signature,
    });
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) =>
    isUpdateNewer(a.version, b.version) ? -1 : isUpdateNewer(b.version, a.version) ? 1 : 0,
  );
  return candidates[0]!;
};

/**
 * Disabled on the Izum StoryFlow fork: there is no own release feed yet, and
 * the upstream Readest feeds would offer to install upstream Readest builds
 * over the fork. Always returns false; re-enable once the fork publishes its
 * own signed releases.
 */
export const checkForAppUpdates = async (
  _: TranslationFunc,
  _isAutoCheck = true,
  _updateChannel: 'stable' | 'nightly' = 'stable',
): Promise<boolean> => {
  return false;
};

const LAST_SHOWN_RELEASE_NOTES_KEY = 'lastShownReleaseNotesVersion';

export const setLastShownReleaseNotesVersion = (version: string) => {
  localStorage.setItem(LAST_SHOWN_RELEASE_NOTES_KEY, version);
};

export const getLastShownReleaseNotesVersion = () => {
  return localStorage.getItem(LAST_SHOWN_RELEASE_NOTES_KEY) || '';
};

/**
 * Disabled on the Izum StoryFlow fork along with `checkForAppUpdates` (see
 * above): the release notes come from the upstream Readest feed. Always
 * returns false.
 */
export const checkAppReleaseNotes = async (_isAutoCheck = true): Promise<boolean> => {
  return false;
};
