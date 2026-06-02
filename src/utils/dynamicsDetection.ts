// Dynamics detection: URL/hostname-based only.
// The extension only supports *.crm.dynamics.com environments.
export const checkDynamicsViaXrm = async (): Promise<boolean> => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url) return false;
    return /\.crm\d*\.dynamics\.com\//i.test(tab.url);
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
 * Extract environment id from Power Platform maker/build URLs.
 * Supports both:
 * - /environments/{environmentId}/...
 * - /e/{environmentId}/...
 */
export const getPowerPlatformEnvironmentIdFromUrl = (
  url: string | undefined
): string | null => {
  if (!url) {
    return null;
  }

  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();

    // Keep the scope explicit to known maker/build hosts.
    if (!host.endsWith('powerapps.com') && !host.endsWith('powerautomate.com')) {
      return null;
    }

    const segments = parsed.pathname.split('/').filter(Boolean);
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
