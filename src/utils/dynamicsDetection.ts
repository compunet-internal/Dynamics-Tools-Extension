// Dynamics detection: URL/hostname-based only.
// The extension supports *.crm.dynamics.com environments, make.powerapps.com, and admin.powerplatform.microsoft.com.
export const checkDynamicsViaXrm = async (): Promise<boolean> => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url) return false;
    return (
      /\.crm\d*\.dynamics\.com\//i.test(tab.url) ||
      /^https:\/\/make\.powerapps\.com\//i.test(tab.url) ||
      /^https:\/\/admin\.powerplatform\.microsoft\.com\//i.test(tab.url)
    );
  } catch {
    return false;
  }
};

/**
 * Returns true if the active tab is a Power Apps maker page (make.powerapps.com)
 * or the Power Platform admin center (admin.powerplatform.microsoft.com).
 * Both behave identically: no Xrm context, but environment ID is available from the URL.
 */
export const checkIsMakePage = async (): Promise<boolean> => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url) return false;
    return (
      /^https:\/\/make\.powerapps\.com\//i.test(tab.url) ||
      /^https:\/\/admin\.powerplatform\.microsoft\.com\//i.test(tab.url)
    );
  } catch {
    return false;
  }
};

/**
 * Attempts to retrieve the Dynamics environment client URL from the active tab
 * by accessing `Xrm.Utility.getGlobalContext().getClientUrl()` in the page context.
 * Returns an empty string if unavailable.
 */
export const getEnvironmentUrlFromXrm = async (): Promise<string> => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) {
      return '';
    }

    // Primary: extract from tab URL directly — no extra permissions needed
    if (tab.url) {
      try {
        const parsed = new URL(tab.url);
        const host = parsed.hostname.toLowerCase();
        if (/^[^.]+\.crm\d*\.dynamics\.com$/.test(host)) {
          return parsed.origin;
        }
      } catch {
        // fall through to executeScript
      }
    }

    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => {
          try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const win = window as any;
            if (win.Xrm?.Utility?.getGlobalContext) {
              try {
                const ctx = win.Xrm.Utility.getGlobalContext();
                if (typeof ctx.getClientUrl === 'function') {
                  return ctx.getClientUrl();
                }
              } catch (e) {
                // ignore
              }
            }
          } catch (e) {
            // ignore
          }
          return '';
        },
      });

      if (results && results[0] && typeof results[0].result === 'string' && results[0].result) {
        return results[0].result as string;
      }
    } catch (error) {
      return '';
    }
  } catch (error) {
    return '';
  }

  return '';
};

/**
 * Returns the current page type ('entityrecord', 'entitylist', or null)
 * by reading the `pagetype` query parameter from the active tab URL.
 * This is instant and requires no content script communication.
 */
export const getPageTypeFromTab = async (): Promise<'entityrecord' | 'entitylist' | null> => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url) return null;
    const pageType = new URL(tab.url).searchParams.get('pagetype');
    if (pageType === 'entityrecord' || pageType === 'entitylist') return pageType;
    return null;
  } catch {
    return null;
  }
};

/**
 * Represents the table/entity context detected from a make.powerapps.com URL.
 */
export interface MakeTableContext {
  /** Entity metadata ID from /entities/{id} URL segments */
  metadataId?: string;
  /** Table logical name from /tables/{name} URL segments */
  logicalName?: string;
  /** Solution ID from /e/{envId}/s/{solutionId}/entity/{name} URLs */
  solutionId?: string;
}

/**
 * Detects whether a make.powerapps.com URL contains a table/entity context.
 * Returns the table context if detectable, or null if the page has no specific table.
 *
 * Supports patterns:
 *   /environments/{envId}/entities/{metadataId}/...      (table editor by metadata ID)
 *   /environments/{envId}/tables/{logicalName}/...       (table editor by logical name)
 *   /e/{envId}/s/{solutionId}/entity/{logicalName}/...   (solution-scoped editor: form, view, field, business rule)
 */
export const getTableContextFromMakeUrl = (url: string | undefined): MakeTableContext | null => {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (!parsed.hostname.endsWith('powerapps.com')) return null;
    const segments = parsed.pathname.split('/').filter(Boolean);
    // /entities/{metadataId} — table editor by metadata ID
    const entitiesIdx = segments.indexOf('entities');
    if (entitiesIdx >= 0 && segments[entitiesIdx + 1]) {
      return { metadataId: segments[entitiesIdx + 1] };
    }
    // /tables/{logicalName} — table editor by logical name
    const tablesIdx = segments.indexOf('tables');
    if (tablesIdx >= 0 && segments[tablesIdx + 1]) {
      return { logicalName: segments[tablesIdx + 1] };
    }
    // /entity/{logicalName} (singular) — solution-scoped editors (form, view, field, business rule)
    // Pattern: /e/{envId}/s/{solutionId}/entity/{logicalName}/...
    const entityIdx = segments.indexOf('entity');
    if (entityIdx >= 0 && segments[entityIdx + 1]) {
      // Extract solution ID if this is a solution-scoped URL: segments[0]='e', segments[2]='s'
      const solutionId =
        segments[0] === 'e' && segments[2] === 's' && segments[3]
          ? segments[3]
          : undefined;
      return { logicalName: segments[entityIdx + 1], solutionId };
    }
    return null;
  } catch {
    return null;
  }
};

/**
 * Extract environment id from Power Platform maker/admin/build URLs.
 * Supports:
 * - make.powerapps.com/environments/{environmentId}/...
 * - make.powerapps.com/e/{environmentId}/...
 * - admin.powerplatform.microsoft.com/environments/environment/{environmentId}/...
 * - admin.powerplatform.microsoft.com/manage/environments/{orgId}/{environmentId}/...
 */
export const getPowerPlatformEnvironmentIdFromUrl = (url: string | undefined): string | null => {
  if (!url) {
    return null;
  }

  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    const segments = parsed.pathname.split('/').filter(Boolean);

    // Power Platform admin center — two distinct path formats
    if (host === 'admin.powerplatform.microsoft.com') {
      // /environments/environment/{envId}/...
      if (
        segments[0]?.toLowerCase() === 'environments' &&
        segments[1]?.toLowerCase() === 'environment' &&
        segments[2]
      ) {
        return segments[2].toLowerCase();
      }
      // /manage/environments/{orgId}/{envId}/...
      if (
        segments[0]?.toLowerCase() === 'manage' &&
        segments[1]?.toLowerCase() === 'environments' &&
        segments[3]
      ) {
        return segments[3].toLowerCase();
      }
      return null;
    }

    // Keep the scope explicit to known maker/build hosts.
    if (!host.endsWith('powerapps.com') && !host.endsWith('powerautomate.com')) {
      return null;
    }

    if (segments.length < 2) {
      return null;
    }

    const envMarkerIndex =
      segments[0].toLowerCase() === 'environments' || segments[0].toLowerCase() === 'e' ? 0 : -1;

    if (envMarkerIndex === -1) {
      return null;
    }

    const candidate = segments[envMarkerIndex + 1];
    return candidate ? candidate.toLowerCase() : null;
  } catch {
    return null;
  }
};
