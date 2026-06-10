/**
 * DataverseDirectService — makes Dataverse Web API calls directly from extension pages
 * (popup, sidebar) using the browser's existing session cookies.
 *
 * Extension pages can make cross-origin requests with credentials to any URL covered
 * by the extension's host permissions (content_scripts matches: https://*\/*)
 */

const ODATA_HEADERS = {
  Accept: 'application/json',
  'Content-Type': 'application/json',
  'OData-MaxVersion': '4.0',
  'OData-Version': '4.0',
};

export interface DirectSolutionOption {
  solutionid: string;
  uniquename: string;
  friendlyname: string;
  version: string;
  ismanaged: boolean;
  isvisible?: boolean;
}

/**
 * Retrieves the stored Dataverse client URL for a given Power Platform environment ID.
 * Returns null if not yet stored (no Dynamics tab has been visited for this env).
 */
export async function getStoredClientUrl(bapEnvironmentId: string): Promise<string | null> {
  const normalized = bapEnvironmentId.replace(/[{}]/g, '').toLowerCase();
  const key = `levelup_env_client_url_${normalized}`;
  return new Promise(resolve => {
    chrome.storage.local.get([key], result => {
      resolve((result?.[key] as string) || null);
    });
  });
}

/**
 * Fetches the list of solutions available as preferred solutions from Dataverse directly.
 * Mirrors the filtering in levelup.extension.ts getSolutionsForPicker().
 */
export async function fetchSolutionsDirectly(
  clientUrl: string
): Promise<DirectSolutionOption[]> {
  const url =
    `${clientUrl}/api/data/v9.2/solutions` +
    `?$select=solutionid,uniquename,friendlyname,version,ismanaged,isvisible` +
    `&$orderby=friendlyname asc,uniquename asc`;

  const response = await fetch(url, {
    method: 'GET',
    headers: ODATA_HEADERS,
    credentials: 'include',
  });

  if (!response.ok) {
    throw new Error(`Dataverse solutions fetch failed: HTTP ${response.status}`);
  }

  const data = await response.json();
  const raw: DirectSolutionOption[] = Array.isArray(data?.value) ? data.value : [];

  // Apply same filtering as content script: exclude system / reserved solutions
  const systemPrefixesUnique = ['msdyn_', 'mspp_', 'adx_', 'microsoft'];
  const systemPrefixesFriendly = ['dynamics ', 'microsoft ', 'default ', 'active '];
  const reserved = new Set(['active', 'default']);

  const canBePreferred = (s: DirectSolutionOption) => {
    if (!s.solutionid || !s.uniquename) return false;
    if (s.isvisible === false) return false;
    const u = s.uniquename.toLowerCase();
    const f = s.friendlyname?.toLowerCase() ?? '';
    if (reserved.has(u)) return false;
    if (systemPrefixesUnique.some(p => u.startsWith(p))) return false;
    if (systemPrefixesFriendly.some(p => f.startsWith(p))) return false;
    return true;
  };

  const strict = raw.filter(s => canBePreferred(s) && !s.ismanaged);
  if (strict.length > 0) return strict;
  const relaxed = raw.filter(canBePreferred);
  if (relaxed.length > 0) return relaxed;
  return raw.filter(s => s.solutionid && s.uniquename && !reserved.has(s.uniquename.toLowerCase()));
}

/**
 * Fetches the current preferred solution from Dataverse directly.
 * Returns null if none is set.
 */
export async function fetchPreferredSolutionDirectly(
  clientUrl: string
): Promise<DirectSolutionOption | null> {
  const url = `${clientUrl}/api/data/v9.2/GetPreferredSolution`;
  const response = await fetch(url, {
    method: 'GET',
    headers: ODATA_HEADERS,
    credentials: 'include',
  });

  if (response.status === 404 || response.status === 204) return null;
  if (!response.ok) return null;

  try {
    const data = await response.json();
    if (data?.solutionid) {
      return data as DirectSolutionOption;
    }
  } catch {
    // Ignore parse errors
  }
  return null;
}

/**
 * Sets the preferred solution via Dataverse action directly.
 */
export async function setPreferredSolutionDirectly(
  clientUrl: string,
  solutionId: string
): Promise<void> {
  const normalized = solutionId.replace(/[{}]/g, '').toLowerCase();
  const url = `${clientUrl}/api/data/v9.2/SetPreferredSolution`;
  const response = await fetch(url, {
    method: 'POST',
    headers: ODATA_HEADERS,
    credentials: 'include',
    body: JSON.stringify({ SolutionId: normalized }),
  });

  if (!response.ok && response.status !== 204) {
    const text = await response.text().catch(() => '');
    throw new Error(`SetPreferredSolution failed: HTTP ${response.status}${text ? ` — ${text}` : ''}`);
  }
}
