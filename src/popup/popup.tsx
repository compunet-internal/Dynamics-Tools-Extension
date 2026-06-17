import React, { useState, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Box,
  Typography,
  Link,
  Button,
  Alert,
  CircularProgress,
  FormControl,
  MenuItem,
  Select,
  Switch,
  FormControlLabel,
} from '@mui/material';
import type { SelectChangeEvent } from '@mui/material/Select';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import CheckCircleOutlinedIcon from '@mui/icons-material/CheckCircleOutlined';
import RefreshIcon from '@mui/icons-material/Refresh';
import ReportProblemIcon from '@mui/icons-material/ReportProblem';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import { ExtensionConfigService, ExtensionConfig } from '#services/ExtensionConfigService';
import {
  getEnvironmentUrlFromXrm,
  getPageTypeFromTab,
  getPowerPlatformEnvironmentIdFromUrl,
  getTableContextFromMakeUrl,
  MakeTableContext,
} from '#utils/dynamicsDetection';
import {
  getStoredClientUrl,
  fetchSolutionsDirectly,
  fetchPreferredSolutionDirectly,
  setPreferredSolutionDirectly,
  fetchEntityMetadataId,
} from '#services/DataverseDirectService';
import { DynamicsAction, ExtensionDisplayMode } from '#types/global';
import { ThemeProvider } from '#contexts/ThemeContext';
import { formActions, navigationActions, tableActions, ActionConfig } from '#config/actions';

interface SolutionOption {
  solutionid: string;
  friendlyname: string;
  uniquename: string;
  ismanaged: boolean;
}

const PopupApp: React.FC = () => {
  const [extensionConfig, setExtensionConfig] = useState<ExtensionConfig>(
    ExtensionConfigService.getConfig()
  );
  const [isConnected, setIsConnected] = useState(false);
  const [isContextReady, setIsContextReady] = useState(false);
  const [isSupportedHost, setIsSupportedHost] = useState<boolean | null>(null);
  const [contextMessage, setContextMessage] = useState('');
  const [contextCheckNonce, setContextCheckNonce] = useState(0);
  const [inlineToast, setInlineToast] = useState<null | {
    message: string;
    severity: 'success' | 'info' | 'warning' | 'error';
  }>(null);
  const [solutions, setSolutions] = useState<SolutionOption[]>([]);
  const [selectedSolutionId, setSelectedSolutionId] = useState('');
  const [currentSolutionId, setCurrentSolutionId] = useState('');
  const [isLoadingSolutions, setIsLoadingSolutions] = useState(false);
  const [isSavingSolution, setIsSavingSolution] = useState(false);
  const [isRefreshingSolutions, setIsRefreshingSolutions] = useState(false);
  const [isStaleSolutions, setIsStaleSolutions] = useState(false);
  const [isFormContext, setIsFormContext] = useState(false);
  const [isListContext, setIsListContext] = useState(false);
  const [isDirectDynamicsPage, setIsDirectDynamicsPage] = useState(false);
  const [currentEnvironmentId, setCurrentEnvironmentId] = useState<string | null>(null);
  const [isMakePage, setIsMakePage] = useState(false);
  const [makeTableContext, setMakeTableContext] = useState<MakeTableContext | null>(null);
  const [makeClientUrl, setMakeClientUrl] = useState<string | null>(null);
  const [userHasAccess, setUserHasAccess] = useState<boolean | null>(null);

  const normalizeSolutionId = (solutionId: string | undefined) =>
    (solutionId || '').replace(/[{}]/g, '').toLowerCase();

  const isSupportedDynamicsHost = (url: string | undefined): boolean => {
    if (!url) {
      return false;
    }

    try {
      const parsed = new URL(url);
      const host = parsed.hostname.toLowerCase();
      return /^[^.]+\.crm\d*\.dynamics\.com$/.test(host);
    } catch {
      return false;
    }
  };

  const isPowerPlatformBuildHost = (url: string | undefined): boolean => {
    if (!url) {
      return false;
    }

    const environmentId = getPowerPlatformEnvironmentIdFromUrl(url);
    return Boolean(environmentId);
  };

  const normalizeEnvironmentId = (value: string | undefined): string =>
    (value || '').replace(/[{}]/g, '').toLowerCase();

  // Detect if running in Firefox
  const isFirefox =
    typeof chrome !== 'undefined' && chrome.runtime && navigator.userAgent.includes('Firefox');

  // On mount: immediately populate from last-known hint stored in chrome.storage.local
  useEffect(() => {
    void (async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const envIdFromUrl = getPowerPlatformEnvironmentIdFromUrl(tab?.url);

      const envHintKey = envIdFromUrl ? `levelup_popup_solution_hint_${envIdFromUrl}` : null;
      const keysToRead = envHintKey
        ? ['levelup_popup_solution_hint', envHintKey]
        : ['levelup_popup_solution_hint'];

      chrome.storage.local.get(keysToRead, result => {
        const envHint = envHintKey
          ? (result?.[envHintKey] as
              | { solutions: SolutionOption[]; currentSolutionId: string }
              | undefined)
          : undefined;

        const globalHint = result?.levelup_popup_solution_hint as
          | { solutions: SolutionOption[]; currentSolutionId: string }
          | undefined;

        const hint = envHint?.solutions?.length ? envHint : globalHint;
        if (hint?.solutions?.length) {
          setSolutions(prev => {
            if (prev.length > 0) return prev; // real data already loaded
            const id = hint.currentSolutionId || hint.solutions[0]?.solutionid || '';
            setCurrentSolutionId(id);
            setSelectedSolutionId(id);
            setIsStaleSolutions(true);
            return hint.solutions;
          });
        }
      });
    })();
  }, []);

  const triggerContextRecheck = () => {
    setContextCheckNonce(value => value + 1);
  };

  const sendMessageToTab = (
    tabId: number,
    action: DynamicsAction,
    data?: unknown
  ): Promise<{ success: boolean; data?: unknown; error?: string }> =>
    new Promise(resolve => {
      let settled = false;
      const timeoutId = window.setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve({ success: false, error: 'Timed out waiting for tab response' });
      }, 5000);

      chrome.tabs.sendMessage(
        tabId,
        { type: 'LEVELUP_REQUEST', action, data, requestId: Date.now().toString() },
        response => {
          if (settled) return;
          settled = true;
          window.clearTimeout(timeoutId);
          if (chrome.runtime.lastError) {
            resolve({ success: false, error: chrome.runtime.lastError.message });
            return;
          }
          resolve(response || { success: false, error: 'No response received' });
        }
      );
    });

  const sendActionToTab = async (tabId: number, action: DynamicsAction, data?: unknown) => {
    const result = await sendMessageToTab(tabId, action, data);
    if (
      !result.success &&
      typeof result.error === 'string' &&
      result.error.toLowerCase().includes('receiving end does not exist')
    ) {
      // Content script is not running — try to inject it and retry once
      try {
        await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
        // Brief wait for the content script to initialise
        await new Promise(resolve => window.setTimeout(resolve, 500));
      } catch {
        // Injection failed — return original error
        return result;
      }
      return await sendMessageToTab(tabId, action, data);
    }
    return result;
  };

  const findDynamicsTabByEnvironmentId = async (
    environmentId: string
  ): Promise<chrome.tabs.Tab | null> => {
    const targetEnvironmentId = normalizeEnvironmentId(environmentId);
    if (!targetEnvironmentId) {
      return null;
    }

    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const preferredWindowId = activeTab?.windowId;

    const allTabs = await chrome.tabs.query({});
    const candidateTabs = allTabs
      .filter(tab => tab.id && isSupportedDynamicsHost(tab.url))
      .sort((left, right) => {
        const leftScore = left.windowId === preferredWindowId ? 0 : 1;
        const rightScore = right.windowId === preferredWindowId ? 0 : 1;
        return leftScore - rightScore;
      });

    const tabLookups = await Promise.all(
      candidateTabs.map(async tab => {
        try {
          const response = await sendActionToTab(tab.id!, 'admin:get-organization-settings');
          if (!response.success || !response.data || typeof response.data !== 'object') {
            return { tab, reachable: false, environmentId: '' };
          }

          const orgSettings = response.data as {
            bapEnvironmentId?: string;
            environmentId?: string;
          };

          return {
            tab,
            reachable: true,
            environmentId: normalizeEnvironmentId(
              orgSettings.bapEnvironmentId || orgSettings.environmentId
            ),
          };
        } catch {
          return { tab, reachable: false, environmentId: '' };
        }
      })
    );

    const exactMatch = tabLookups.find(
      lookup => lookup.reachable && lookup.environmentId === targetEnvironmentId
    );
    if (exactMatch) {
      return exactMatch.tab;
    }

    // Fallback: if no exact environment match, use any reachable Dynamics tab.
    const reachableFallback = tabLookups.find(lookup => lookup.reachable);
    return reachableFallback?.tab || null;
  };

  const resolveActionTargetTab = async (): Promise<chrome.tabs.Tab | null> => {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!activeTab) {
      return null;
    }

    if (isSupportedDynamicsHost(activeTab.url)) {
      return activeTab;
    }

    const environmentIdFromBuildUrl = getPowerPlatformEnvironmentIdFromUrl(activeTab.url);
    if (environmentIdFromBuildUrl) {
      return await findDynamicsTabByEnvironmentId(environmentIdFromBuildUrl);
    }

    return null;
  };

  useEffect(() => {
    let cancelled = false;

    const checkConnection = async () => {
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        const environmentIdFromBuildUrl = getPowerPlatformEnvironmentIdFromUrl(tab?.url);
        const supportedHost =
          isSupportedDynamicsHost(tab?.url) || isPowerPlatformBuildHost(tab?.url);

        setIsSupportedHost(supportedHost);
        setCurrentEnvironmentId(environmentIdFromBuildUrl);

        if (!supportedHost) {
          if (!cancelled) {
            setIsConnected(false);
            setIsContextReady(false);
            setContextMessage(
              'Open this popup on a Dynamics page (*.crm.dynamics.com), then click Retry now. We will enable actions automatically once context is available.'
            );
          }
          return;
        }

        if (!isSupportedDynamicsHost(tab?.url) && environmentIdFromBuildUrl) {
          const isMake = /^https:\/\/make\.powerapps\.com\//i.test(tab?.url || '');
          if (isMake) {
            const tableContext = getTableContextFromMakeUrl(tab?.url);
            // make.powerapps.com — mark as context-ready with limited (no-Xrm) actions available
            const storedClientUrl = environmentIdFromBuildUrl
              ? await getStoredClientUrl(environmentIdFromBuildUrl)
              : null;
            if (!cancelled) {
              setIsConnected(true);
              setIsContextReady(true);
              setIsMakePage(true);
              setMakeTableContext(tableContext);
              setMakeClientUrl(storedClientUrl);
              setIsFormContext(false);
              setContextMessage('');
              setUserHasAccess(null);
            }
            return;
          }
          const matchingDynamicsTab =
            await findDynamicsTabByEnvironmentId(environmentIdFromBuildUrl);
          if (!matchingDynamicsTab) {
            // Fall back to stored client URL (same limited mode as make.powerapps.com)
            const storedClientUrl = await getStoredClientUrl(environmentIdFromBuildUrl);
            if (storedClientUrl) {
              if (!cancelled) {
                setIsConnected(true);
                setIsContextReady(true);
                setIsMakePage(true);
                setMakeClientUrl(storedClientUrl);
                setIsFormContext(false);
                setContextMessage('');
                setUserHasAccess(null);
              }
              return;
            }
            if (!cancelled) {
              setIsConnected(false);
              setIsContextReady(false);
              setContextMessage(
                'This is a Power Platform build URL. Open any model-driven app tab (*.crm.dynamics.com) for the same environment, then click Retry.'
              );
            }
            return;
          }
        }

        const directDynamics = isSupportedDynamicsHost(tab?.url);
        if (!cancelled) {
          setIsMakePage(false);
          setMakeTableContext(null);
          setIsDirectDynamicsPage(directDynamics);
        }

        let pageType: 'entityrecord' | 'entitylist' | null = null;
        if (directDynamics) {
          // Only probe page context on actual Dynamics hosts.
          const [environmentUrl, detectedPageType] = await Promise.all([
            getEnvironmentUrlFromXrm(),
            getPageTypeFromTab(),
          ]);
          void environmentUrl;
          pageType = detectedPageType;
        }

        // Check whether the user has the required role before enabling all actions.
        let hasAccess = false;
        try {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          if (tab?.id) {
            const resp = await new Promise<{ success: boolean; data?: unknown }>(resolve => {
              let done = false;
              const tid = window.setTimeout(() => {
                if (!done) {
                  done = true;
                  resolve({ success: false });
                }
              }, 5000);
              chrome.tabs.sendMessage(
                tab.id!,
                {
                  type: 'LEVELUP_REQUEST',
                  action: 'admin:get-user-info',
                  requestId: Date.now().toString(),
                },
                response => {
                  if (done) return;
                  done = true;
                  window.clearTimeout(tid);
                  resolve(response || { success: false });
                }
              );
            });
            if (resp.success && resp.data) {
              hasAccess = !!(resp.data as Record<string, unknown>).hasAdminOrCustomizerRole;
            }
          }
        } catch {
          // default to no access on error
        }
        if (!cancelled) {
          setIsConnected(true);
          setIsContextReady(true);
          setIsFormContext(pageType === 'entityrecord');
          setIsListContext(pageType === 'entitylist');
          setContextMessage('');
          setUserHasAccess(hasAccess);
        }
      } catch (error) {
        if (!cancelled) {
          setIsConnected(false);
          setIsContextReady(false);
          setContextMessage(
            'We could not detect Dynamics context yet. Try refreshing the page and opening the popup again.'
          );
        }
      } finally {
        // detection complete
      }
    };

    checkConnection();

    // Subscribe to config changes
    const unsubscribe = ExtensionConfigService.subscribe(setExtensionConfig);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [contextCheckNonce]);

  const showInlineToast = (
    message: string,
    severity: 'success' | 'info' | 'warning' | 'error' = 'error'
  ) => {
    setInlineToast({ message, severity });
    window.setTimeout(() => setInlineToast(null), 4000);
  };

  const sendActionToActiveTab = async (action: DynamicsAction, data?: unknown) => {
    const targetTab = await resolveActionTargetTab();
    if (!targetTab?.id) {
      throw new Error(
        'No Dynamics tab found for the current environment. Open a Dynamics tab for this environment and try again.'
      );
    }

    return await sendActionToTab(targetTab.id, action, data);
  };

  const applySolutionState = (state: {
    solutions: SolutionOption[];
    currentSolutionId: string;
  }) => {
    const safeList = Array.isArray(state?.solutions) ? state.solutions : [];
    setSolutions(safeList);
    const id = state?.currentSolutionId || safeList[0]?.solutionid || '';
    setCurrentSolutionId(id);
    setSelectedSolutionId(id);
    // Persist as hint for next popup open
    if (safeList.length > 0) {
      chrome.storage.local.set({
        levelup_popup_solution_hint: { solutions: safeList, currentSolutionId: id },
        ...(currentEnvironmentId
          ? {
              [`levelup_popup_solution_hint_${currentEnvironmentId}`]: {
                solutions: safeList,
                currentSolutionId: id,
              },
            }
          : {}),
      });
    }
  };

  /** Load from cache instantly — no API call, no spinner */
  const loadCachedSolutionState = async () => {
    if (!isConnected) return;

    // On make pages with a stored client URL, load directly from Dataverse
    if (isMakePage && makeClientUrl) {
      return false; // signal no cache — refreshSolutionState will fetch live
    }

    // On make pages without client URL, solutions already loaded from the chrome.storage.local hint on mount
    if (isMakePage) {
      return solutions.length > 0;
    }

    const response = await sendActionToActiveTab('navigation:get-solution-state');
    if (response.success && response.data) {
      const state = response.data as { solutions: SolutionOption[]; currentSolutionId: string };
      if (state.solutions?.length) {
        applySolutionState(state);
        setIsStaleSolutions(true);
        return true;
      }
    }
    return false;
  };

  /** Fetch fresh data from API, update state and clear stale flag */
  const refreshSolutionState = async () => {
    if (!isConnected) return;

    // On make pages with a stored client URL, call Dataverse directly
    if (isMakePage && makeClientUrl) {
      setIsRefreshingSolutions(true);
      try {
        const [rawSolutions, preferred] = await Promise.all([
          fetchSolutionsDirectly(makeClientUrl),
          fetchPreferredSolutionDirectly(makeClientUrl),
        ]);
        const currentSolutionId = preferred
          ? preferred.solutionid.replace(/[{}]/g, '').toLowerCase()
          : '';
        applySolutionState({ solutions: rawSolutions as SolutionOption[], currentSolutionId });
        setIsStaleSolutions(false);
      } catch (error) {
        showInlineToast(
          `Failed to load solutions: ${error instanceof Error ? error.message : 'Unknown error'}`,
          'warning'
        );
      } finally {
        setIsRefreshingSolutions(false);
      }
      return;
    }

    if (isMakePage) return; // no client URL and no content script tab — nothing to do
    setIsRefreshingSolutions(true);
    try {
      const response = await sendActionToActiveTab('navigation:refresh-solutions');
      if (response.success && response.data) {
        const state = response.data as { solutions: SolutionOption[]; currentSolutionId: string };
        applySolutionState(state);
        setIsStaleSolutions(false);
      } else {
        throw new Error((response.error as string) || 'Failed to refresh solutions');
      }
    } catch (error) {
      showInlineToast(
        `Failed to refresh solutions: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'warning'
      );
    } finally {
      setIsRefreshingSolutions(false);
    }
  };

  /** Initial load: show cache instantly, then kick off background refresh if stale */
  const refreshSolutionDropdown = async (forceRefresh = false) => {
    if (!isConnected) {
      setSolutions([]);
      setSelectedSolutionId('');
      setCurrentSolutionId('');
      return;
    }

    if (forceRefresh) {
      await refreshSolutionState();
      return;
    }

    const hadCache = await loadCachedSolutionState();
    if (!hadCache) {
      // No cache — fetch with visible loading spinner
      setIsLoadingSolutions(true);
      try {
        await refreshSolutionState();
      } finally {
        setIsLoadingSolutions(false);
      }
    }
    // If we had cache, background refresh happens lazily via onOpen
  };

  /** Called when the dropdown is opened — silently refresh in background */
  const handleDropdownOpen = () => {
    if (isStaleSolutions && !isRefreshingSolutions && isConnected) {
      void refreshSolutionState();
    }
  };

  const handleDefaultSolutionChange = async (event: SelectChangeEvent<string>) => {
    const nextSolutionId = event.target.value;
    if (!nextSolutionId) {
      return;
    }

    setIsSavingSolution(true);
    setSelectedSolutionId(nextSolutionId);

    // On make pages, save via direct Dataverse call if we have clientUrl, else locally
    if (isMakePage) {
      if (makeClientUrl) {
        try {
          await setPreferredSolutionDirectly(makeClientUrl, nextSolutionId);
          setCurrentSolutionId(nextSolutionId);
          showInlineToast('Default solution updated', 'success');
          // Update the hint cache too
          const updatedHint = { solutions, currentSolutionId: nextSolutionId };
          const keysToWrite: Record<
            string,
            { solutions: SolutionOption[]; currentSolutionId: string }
          > = {
            levelup_popup_solution_hint: updatedHint,
          };
          if (currentEnvironmentId) {
            keysToWrite[`levelup_popup_solution_hint_${currentEnvironmentId}`] = updatedHint;
          }
          chrome.storage.local.set(keysToWrite);
        } catch (error) {
          showInlineToast(
            `Failed to update preferred solution: ${error instanceof Error ? error.message : 'Unknown error'}`,
            'error'
          );
          setSelectedSolutionId(currentSolutionId); // revert
        }
      } else {
        // No client URL — save locally only
        const updatedHint = { solutions, currentSolutionId: nextSolutionId };
        const keysToWrite: Record<
          string,
          { solutions: SolutionOption[]; currentSolutionId: string }
        > = {
          levelup_popup_solution_hint: updatedHint,
        };
        if (currentEnvironmentId) {
          keysToWrite[`levelup_popup_solution_hint_${currentEnvironmentId}`] = updatedHint;
        }
        chrome.storage.local.set(keysToWrite);
        setCurrentSolutionId(nextSolutionId);
        showInlineToast('Default solution updated (cached locally)', 'success');
      }
      setIsSavingSolution(false);
      return;
    }

    try {
      const response = await sendActionToActiveTab('navigation:set-preferred-solution', {
        solutionId: nextSolutionId,
      });

      if (!response.success) {
        throw new Error(response.error || 'Failed to set preferred solution');
      }

      setCurrentSolutionId(nextSolutionId);
      showInlineToast('Default solution updated', 'success');
      await refreshSolutionState();
    } catch (error) {
      showInlineToast(
        `Failed to update preferred solution: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'error'
      );
      await refreshSolutionState();
    } finally {
      setIsSavingSolution(false);
    }
  };

  const handleActionClick = async (actionId: DynamicsAction, shiftKey = false) => {
    try {
      console.log('Executing action:', actionId, { isConnected, isMakePage });

      // Report a Problem: inject overlay directly into the page via scripting API
      if (actionId === 'navigation:report-problem') {
        console.log('Opening Report a Problem overlay via scripting');
        try {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          if (tab?.id) {
            await chrome.scripting.executeScript({
              target: { tabId: tab.id },
              func: () => {
                const OVERLAY_ID = 'levelup-report-overlay';
                if (document.getElementById(OVERLAY_ID)) return;

                const isDark = window.matchMedia?.('(prefers-color-scheme:dark)').matches;
                const bg = isDark ? '#1e1e2e' : '#ffffff';
                const fg = isDark ? '#cdd6f4' : '#1a1a2e';
                const border = isDark ? '#45475a' : '#d0d0e0';
                const inputBg = isDark ? '#313244' : '#f8f9ff';

                const buildOverlay = (
                  logs: Array<{ level: string; message: string; timestamp: string }>
                ) => {
                  const logLines = logs.length
                    ? logs
                        .map(
                          e =>
                            `<span style="opacity:.6;font-size:11px">[${e.timestamp.substring(11, 23)}]</span> ` +
                            `<b style="color:${e.level === 'error' ? '#f38ba8' : e.level === 'warn' ? '#fab387' : '#89dceb'}">${e.level.toUpperCase()}</b> ` +
                            e.message.replace(/</g, '&lt;')
                        )
                        .join('\n')
                    : 'No console entries captured.';

                  const overlay = document.createElement('div');
                  overlay.id = OVERLAY_ID;
                  overlay.style.cssText =
                    'position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif';
                  overlay.innerHTML = `
                    <div style="background:${bg};color:${fg};border-radius:10px;box-shadow:0 8px 40px rgba(0,0,0,.45);width:min(660px,94vw);max-height:90vh;display:flex;flex-direction:column;overflow:hidden">
                      <div style="padding:18px 24px 12px;border-bottom:1px solid ${border};display:flex;align-items:center;gap:10px">
                        <span style="font-size:20px">⚠️</span>
                        <div>
                          <div style="font-size:17px;font-weight:700;line-height:1.2">Report a Problem</div>
                          <div style="font-size:12px;opacity:.6;margin-top:2px">Describe the issue and a support case will be created in this environment</div>
                        </div>
                        <button id="lup-rp-close" style="margin-left:auto;background:none;border:none;cursor:pointer;font-size:22px;color:${fg};opacity:.5;line-height:1;padding:0 4px">&times;</button>
                      </div>
                      <div style="padding:16px 24px;overflow-y:auto;flex:1;display:flex;flex-direction:column;gap:14px">
                        <div>
                          <label style="font-size:12px;font-weight:600;opacity:.65;display:block;margin-bottom:4px">Case Title *</label>
                          <input id="lup-rp-title" type="text" value="${document.title.replace(/"/g, '&quot;')}" placeholder="Brief title for the case" style="width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid ${border};border-radius:6px;background:${inputBg};color:${fg};font-size:13px;font-family:inherit" />
                        </div>
                        <div>
                          <label style="font-size:12px;font-weight:600;opacity:.65;display:block;margin-bottom:4px">Description *</label>
                          <textarea id="lup-rp-desc" rows="7" placeholder="Describe the problem you encountered…" style="width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid ${border};border-radius:6px;background:${inputBg};color:${fg};font-size:13px;font-family:inherit;resize:vertical"></textarea>
                        </div>
                        <div>
                          <label style="font-size:12px;font-weight:600;opacity:.65;display:block;margin-bottom:4px">Page URL</label>
                          <input id="lup-rp-url" type="text" value="${window.location.href.replace(/"/g, '&quot;')}" style="width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid ${border};border-radius:6px;background:${inputBg};color:${fg};font-size:12px;font-family:monospace" />
                        </div>
                        <div style="display:flex;align-items:flex-start;gap:10px">
                          <input id="lup-rp-include-logs" type="checkbox" checked style="margin-top:2px;cursor:pointer;width:15px;height:15px;flex-shrink:0" />
                          <div style="flex:1">
                            <label for="lup-rp-include-logs" style="font-size:13px;font-weight:600;cursor:pointer">Include Console Log <span style="font-weight:400;opacity:.6">(${logs.length} entries)</span></label>
                            <pre id="lup-rp-log-preview" style="margin:6px 0 0;padding:10px 12px;border:1px solid ${border};border-radius:6px;font-size:11px;font-family:monospace;overflow-y:auto;max-height:160px;white-space:pre-wrap;word-break:break-all;background:${inputBg}">${logLines || '(no console log entries)'}</pre>
                          </div>
                        </div>
                        <div id="lup-rp-status" style="display:none;padding:10px 12px;border-radius:6px;font-size:13px"></div>
                      </div>
                      <div style="padding:12px 24px 18px;border-top:1px solid ${border};display:flex;justify-content:flex-end;gap:10px">
                        <button id="lup-rp-cancel" style="padding:8px 20px;border:1px solid ${border};border-radius:6px;background:none;color:${fg};cursor:pointer;font-size:14px">Cancel</button>
                        <button id="lup-rp-submit" style="padding:8px 20px;border:none;border-radius:6px;background:#f59e0b;color:#111;cursor:pointer;font-size:14px;font-weight:600">Submit Case</button>
                      </div>
                    </div>`;

                  const close = () => overlay.remove();
                  overlay.querySelector('#lup-rp-close')!.addEventListener('click', close);
                  overlay.querySelector('#lup-rp-cancel')!.addEventListener('click', close);
                  overlay.addEventListener('click', e => {
                    if (e.target === overlay) close();
                  });

                  const submitBtn = overlay.querySelector('#lup-rp-submit') as HTMLButtonElement;
                  const statusDiv = overlay.querySelector('#lup-rp-status') as HTMLElement;
                  const includeLogsCheckbox = overlay.querySelector(
                    '#lup-rp-include-logs'
                  ) as HTMLInputElement;
                  const logPreview = overlay.querySelector('#lup-rp-log-preview') as HTMLElement;
                  includeLogsCheckbox.addEventListener('change', () => {
                    logPreview.style.opacity = includeLogsCheckbox.checked ? '1' : '0.35';
                  });

                  submitBtn.addEventListener('click', () => {
                    const title = (
                      overlay.querySelector('#lup-rp-title') as HTMLInputElement
                    ).value.trim();
                    const desc = (
                      overlay.querySelector('#lup-rp-desc') as HTMLTextAreaElement
                    ).value.trim();
                    const url = (
                      overlay.querySelector('#lup-rp-url') as HTMLInputElement
                    ).value.trim();
                    if (!title) {
                      (overlay.querySelector('#lup-rp-title') as HTMLElement).style.borderColor =
                        '#f38ba8';
                      return;
                    }
                    if (!desc) {
                      (overlay.querySelector('#lup-rp-desc') as HTMLElement).style.borderColor =
                        '#f38ba8';
                      return;
                    }
                    submitBtn.disabled = true;
                    submitBtn.textContent = 'Creating Case…';

                    const reqId = `rp_${Date.now()}`;
                    const respListener = (ev: MessageEvent) => {
                      if (
                        ev.source !== window ||
                        ev.data?.type !== 'LEVELUP_RESPONSE' ||
                        ev.data?.requestId !== reqId
                      )
                        return;
                      window.removeEventListener('message', respListener);
                      const okColor = isDark ? '#a6e3a1' : '#166534';
                      const errColor = isDark ? '#f38ba8' : '#991b1b';
                      const okBg = isDark ? '#1e3a2f' : '#f0fdf4';
                      const errBg = isDark ? '#3a1e1e' : '#fef2f2';
                      if (ev.data.success) {
                        statusDiv.style.cssText = `display:block;padding:10px 12px;border-radius:6px;font-size:13px;background:${okBg};color:${okColor}`;
                        statusDiv.textContent = 'Support case created successfully.';
                        const caseUrl = ev.data.data as string;
                        if (caseUrl?.startsWith('http')) window.open(caseUrl, '_blank');
                        window.setTimeout(close, 1500);
                      } else {
                        statusDiv.style.cssText = `display:block;padding:10px 12px;border-radius:6px;font-size:13px;background:${errBg};color:${errColor}`;
                        statusDiv.textContent = `Error: ${ev.data.error ?? 'Failed to create case'}`;
                        submitBtn.disabled = false;
                        submitBtn.textContent = 'Submit Case';
                      }
                    };
                    window.addEventListener('message', respListener);
                    const includeLogs = (
                      overlay.querySelector('#lup-rp-include-logs') as HTMLInputElement
                    ).checked;
                    window.postMessage(
                      {
                        type: 'LEVELUP_REQUEST',
                        action: 'navigation:report-problem',
                        data: {
                          title,
                          description: desc,
                          url,
                          consoleLogs: includeLogs ? logs : [],
                        },
                        requestId: reqId,
                      },
                      window.location.origin
                    );
                  });

                  document.body.appendChild(overlay);
                  window.setTimeout(
                    () => (overlay.querySelector('#lup-rp-desc') as HTMLElement)?.focus(),
                    80
                  );
                };

                // Try to get console logs from injected script, then build overlay
                const logReqId = `rplog_${Date.now()}`;
                let settled = false;
                const logListener = (ev: MessageEvent) => {
                  if (ev.source !== window || ev.data?.requestId !== logReqId) return;
                  if (ev.data?.type === 'LEVELUP_RESPONSE') {
                    settled = true;
                    window.removeEventListener('message', logListener);
                    buildOverlay(Array.isArray(ev.data.data) ? ev.data.data : []);
                  }
                };
                window.addEventListener('message', logListener);
                window.postMessage(
                  {
                    type: 'LEVELUP_REQUEST',
                    action: 'navigation:get-console-logs',
                    requestId: logReqId,
                  },
                  window.location.origin
                );
                window.setTimeout(() => {
                  if (!settled) {
                    window.removeEventListener('message', logListener);
                    buildOverlay([]);
                  }
                }, 1000);
              },
            });
          } else {
            console.warn('No active tab found for overlay injection');
          }
          window.close();
        } catch (e) {
          console.error('Failed to inject Report a Problem overlay:', e);
        }
        return;
      }

      // On make.powerapps.com, handle requiresXrm:false actions directly
      if (isMakePage) {
        const allActions = [...formActions, ...navigationActions];
        const actionConfig = allActions.find(a => a.id === actionId);
        if (
          (actionId === 'form:open-table-editor' || actionId === 'form:table-processes') &&
          currentEnvironmentId &&
          makeTableContext
        ) {
          let baseUrl: string;
          if (makeTableContext.metadataId) {
            baseUrl = `https://make.powerapps.com/environments/${currentEnvironmentId}/entities/${makeTableContext.metadataId}`;
          } else if (makeTableContext.logicalName) {
            // Resolve the Dataverse URL: (1) content script same-origin API,
            // (2) stored URL keyed to this specific env. Never use makeClientUrl
            // (stale React state) which could be from a different environment.
            let clientUrl: string | null = null;
            try {
              const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
              if (activeTab?.id) {
                const resp = await chrome.tabs.sendMessage(activeTab.id, {
                  type: 'GET_DATAVERSE_URL_FROM_PAGE',
                  envId: currentEnvironmentId,
                });
                clientUrl = (resp?.data as string | null | undefined) ?? null;
              }
            } catch {
              /* content script not responding */
            }
            if (!clientUrl) {
              clientUrl = await getStoredClientUrl(currentEnvironmentId);
            }
            const metadataId = clientUrl
              ? ((await fetchEntityMetadataId(clientUrl, makeTableContext.logicalName)) ??
                undefined)
              : undefined;
            if (metadataId) {
              baseUrl = `https://make.powerapps.com/environments/${currentEnvironmentId}/entities/${metadataId}`;
            } else if (makeTableContext.solutionId) {
              baseUrl = `https://make.powerapps.com/e/${currentEnvironmentId}/s/${makeTableContext.solutionId}/entity/${makeTableContext.logicalName}`;
            } else {
              baseUrl = `https://make.powerapps.com/environments/${currentEnvironmentId}/tables/${makeTableContext.logicalName}`;
            }
          } else {
            baseUrl = '';
          }
          if (baseUrl) {
            shiftKey ? chrome.tabs.update({ url: baseUrl }) : chrome.tabs.create({ url: baseUrl });
          }
          return;
        }

        if (actionConfig?.requiresXrm === false && currentEnvironmentId) {
          if (actionId === 'navigation:open-solutions') {
            const url = `https://make.powerapps.com/environments/${currentEnvironmentId}/solutions`;
            shiftKey ? chrome.tabs.update({ url }) : chrome.tabs.create({ url });
            return;
          }
          if (actionId === 'navigation:open-solutions-history') {
            const url = `https://make.powerapps.com/environments/${currentEnvironmentId}/solutionsHistory`;
            shiftKey ? chrome.tabs.update({ url }) : chrome.tabs.create({ url });
            return;
          }
        }
        showInlineToast(
          makeTableContext
            ? 'This action is not available from this make.powerapps.com page context'
            : 'This action requires a Dynamics 365 environment page (*.crm.dynamics.com)',
          'warning'
        );
        return;
      }

      // Handle actions that require input with simple prompts
      let actionData: unknown = undefined;

      if (actionId === 'navigation:open-record-by-id') {
        const recordId = prompt('Enter the record ID (GUID):');
        if (!recordId) return; // User cancelled
        const entityName = prompt(
          'Enter the entity logical name for the record (e.g., account, contact, opportunity):'
        );
        if (!entityName) return; // User cancelled
        actionData = { recordId: recordId.trim(), entityName: entityName.trim().toLowerCase() };
      } else if (actionId === 'navigation:new-record') {
        const entityName = prompt(
          'Enter the entity logical name (e.g., account, contact, opportunity):'
        );
        if (!entityName) return; // User cancelled
        actionData = { entityName: entityName.trim().toLowerCase() };
      } else if (actionId === 'navigation:open-list') {
        const entityName = prompt(
          'Enter the entity logical name (e.g., account, contact, opportunity):'
        );
        if (!entityName) return; // User cancelled
        actionData = { entityName: entityName.trim().toLowerCase() };
      }

      const response = await sendActionToActiveTab(actionId, actionData);
      if (response?.success) {
        console.log(`✅ Action executed successfully: ${actionId}`);
      } else {
        console.error('❌ Action failed:', response?.error || 'Unknown error');
        if (response?.error && response.error.indexOf('Form actions can only be used') !== -1) {
          showInlineToast(response.error, 'error');
        }
      }
    } catch (error) {
      console.error('Error executing action:', error);
    }
  };

  const handleHideDeprecatedToggle = async (checked: boolean) => {
    await ExtensionConfigService.updateConfig({ hideDeprecatedColumns: checked });
    setExtensionConfig(ExtensionConfigService.getConfig());
  };

  const switchDisplayModeAndOpenSidebar = async (mode: ExtensionDisplayMode) => {
    try {
      console.log('Switching to display mode:', mode);
      await ExtensionConfigService.setDisplayMode(mode);
      console.log('Display mode updated successfully');

      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.id) {
        console.log('Opening sidebar for tab:', tab.id);
        await chrome.sidePanel.open({ tabId: tab.id });
        // Only close popup when successfully opening sidebar
        window.close();
      } else {
        console.error('No active tab found for sidebar opening');
      }
    } catch (error) {
      console.error('Error switching display mode and opening sidebar:', error);
    }
  };

  useEffect(() => {
    if (isContextReady && isConnected && extensionConfig.showNavigationSection && userHasAccess !== false) {
      void refreshSolutionDropdown();
    }
  }, [isConnected, isContextReady, extensionConfig.showNavigationSection, makeClientUrl, userHasAccess]);

  // removed skeleton and early not-connected returns — always render full UI

  return (
    <Box
      sx={{
        width: '320px',
        maxWidth: '320px',
        background: theme =>
          `linear-gradient(135deg, ${theme.palette.background.default} 0%, ${theme.palette.background.paper} 100%)`,
        borderRadius: '8px',
        overflow: 'hidden',
        boxShadow: theme =>
          theme.palette.mode === 'dark'
            ? '0 4px 20px rgba(0,0,0,0.6)'
            : '0 4px 20px rgba(0,0,0,0.08)',
        display: 'flex',
      }}
    >
      {/* Vertical Express Mode Label */}
      <Box
        sx={{
          width: '36px',
          minWidth: '36px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'linear-gradient(135deg, #1976d2, #42a5f5)',
          position: 'relative',
          overflow: 'hidden',
        }}
      >
        <Typography
          sx={{
            color: 'white',
            fontSize: '0.7rem',
            fontWeight: 600,
            letterSpacing: '1px',
            writingMode: 'vertical-rl',
            textOrientation: 'mixed',
            transform: 'rotate(180deg)',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          EXPRESS MODE
        </Typography>
      </Box>

      {/* Main Content */}
      <Box
        sx={{
          flex: 1,
          minWidth: 0,
          overflow: 'hidden',
          p: 1,
          position: 'relative',
        }}
      >
        {/* Inline toast for quick feedback (overlay to avoid layout shift) */}
        {inlineToast && (
          <Box sx={{ position: 'absolute', left: 12, right: 12, top: 12, zIndex: 20 }}>
            <Alert severity={inlineToast.severity} onClose={() => setInlineToast(null)}>
              {inlineToast.message}
            </Alert>
          </Box>
        )}

        {!isContextReady && (
          <Box
            sx={{
              mt: 1,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 1.5,
              py: 2,
            }}
          >
            {isSupportedHost !== false && !contextMessage ? <CircularProgress size={28} /> : null}
            <Typography
              variant='subtitle2'
              sx={{ fontWeight: 700, fontSize: '0.85rem', textAlign: 'center' }}
            >
              {isSupportedHost === false
                ? 'Open on a Dynamics page'
                : contextMessage
                  ? 'Connection required'
                  : 'Detecting Dynamics...'}
            </Typography>
            {contextMessage ? (
              <Typography
                sx={{
                  fontSize: '0.72rem',
                  color: 'text.secondary',
                  textAlign: 'center',
                  lineHeight: 1.4,
                }}
              >
                {contextMessage}
              </Typography>
            ) : null}
            <Button
              size='small'
              variant='outlined'
              onClick={triggerContextRecheck}
              disabled={false}
              sx={{ fontSize: '0.72rem', mt: 0.5 }}
            >
              Retry
            </Button>
          </Box>
        )}

        {isContextReady && (
          <>
            {/* Default solution selector moved to top of popup */}
                {extensionConfig.showNavigationSection && (
                  <Box sx={{ mb: 1.5 }}>
                    <Box
                      sx={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        mb: 0.5,
                      }}
                    >
                      <Typography
                        variant='subtitle2'
                        sx={{
                          fontSize: '0.75rem',
                          fontWeight: 600,
                          color: 'text.primary',
                          textTransform: 'uppercase',
                          letterSpacing: '0.3px',
                          opacity: 0.8,
                        }}
                      >
                        Default Solution
                      </Typography>
                      <Tooltip
                        title={
                          isStaleSolutions
                            ? 'Refresh solutions (showing cached data)'
                            : 'Refresh solutions list'
                        }
                      >
                        <span>
                          <IconButton
                            size='small'
                            disabled={
                              isRefreshingSolutions ||
                              isSavingSolution ||
                              !isConnected ||
                              (isMakePage && !makeClientUrl)
                            }
                            onClick={() => refreshSolutionState()}
                            sx={{ p: 0.25 }}
                          >
                            <RefreshIcon
                              sx={{
                                fontSize: 14,
                                animation: isRefreshingSolutions
                                  ? 'spin 1s linear infinite'
                                  : 'none',
                                '@keyframes spin': {
                                  '0%': { transform: 'rotate(0deg)' },
                                  '100%': { transform: 'rotate(360deg)' },
                                },
                              }}
                            />
                          </IconButton>
                        </span>
                      </Tooltip>
                    </Box>
                    <Box
                      sx={{
                        p: 0.5,
                        backgroundColor: theme =>
                          theme.palette.mode === 'dark'
                            ? theme.palette.background.paper
                            : 'rgba(255,255,255,0.85)',
                        borderRadius: '6px',
                        border: theme => `1px solid ${theme.palette.divider}`,
                      }}
                    >
                      <FormControl
                        fullWidth
                        size='small'
                        disabled={
                          isLoadingSolutions ||
                          isSavingSolution ||
                          !isConnected ||
                          (isMakePage && !makeClientUrl && solutions.length === 0)
                        }
                      >
                        <Select
                          value={selectedSolutionId}
                          onChange={handleDefaultSolutionChange}
                          onOpen={handleDropdownOpen}
                          displayEmpty
                          renderValue={value => {
                            if (isLoadingSolutions) {
                              return (
                                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                                  <CircularProgress size={12} />
                                  <span style={{ fontSize: '0.8rem' }}>Loading solutions...</span>
                                </Box>
                              );
                            }
                            const sol = solutions.find(s => s.solutionid === value);
                            return sol
                              ? sol.friendlyname
                              : value
                                ? String(value)
                                : 'Select solution...';
                          }}
                          sx={{
                            '& .MuiSelect-select': {
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                              display: 'block',
                            },
                          }}
                        >
                          {solutions.length === 0 && !isLoadingSolutions && (
                            <MenuItem value='' disabled>
                              No solutions available
                            </MenuItem>
                          )}
                          {solutions.map(solution => {
                            const isCurrent =
                              normalizeSolutionId(solution.solutionid) ===
                              normalizeSolutionId(currentSolutionId);

                            return (
                              <MenuItem key={solution.solutionid} value={solution.solutionid}>
                                <Box
                                  sx={{
                                    width: '100%',
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'space-between',
                                    gap: 1,
                                    minWidth: 0,
                                  }}
                                >
                                  <span
                                    style={{
                                      overflow: 'hidden',
                                      textOverflow: 'ellipsis',
                                      whiteSpace: 'nowrap',
                                      minWidth: 0,
                                      flex: 1,
                                    }}
                                  >
                                    {solution.friendlyname}
                                  </span>
                                  {isCurrent &&
                                    (isStaleSolutions ? (
                                      <CheckCircleOutlinedIcon
                                        sx={{ fontSize: 16, color: 'success.main', flexShrink: 0 }}
                                      />
                                    ) : (
                                      <CheckCircleIcon
                                        sx={{ fontSize: 16, color: 'success.main', flexShrink: 0 }}
                                      />
                                    ))}
                                </Box>
                              </MenuItem>
                            );
                          })}
                        </Select>
                      </FormControl>
                    </Box>
                  </Box>
                )}

                {/* Form Actions */}
                {extensionConfig.showFormSection && !isMakePage && isDirectDynamicsPage && (
                  <Box sx={{ mb: 1.5 }}>
                    <Typography
                      variant='subtitle2'
                      sx={{
                        fontSize: '0.75rem',
                        fontWeight: 600,
                        mb: 0.5,
                        color: 'text.primary',
                        textTransform: 'uppercase',
                        letterSpacing: '0.3px',
                        opacity: 0.8,
                      }}
                    >
                      Form Actions
                    </Typography>
                    {!isFormContext ? (
                      <Alert severity='info' sx={{ fontSize: '0.72rem', py: 0.5 }}>
                        Open a record to use Form Actions
                      </Alert>
                    ) : (
                      <Box
                        sx={{
                          display: 'grid',
                          gridTemplateColumns: 'repeat(3, 1fr)',
                          gap: 0.5,
                          p: 0.5,
                          backgroundColor: theme =>
                            theme.palette.mode === 'dark'
                              ? theme.palette.background.paper
                              : 'rgba(255,255,255,0.85)',
                          borderRadius: '6px',
                          border: theme => `1px solid ${theme.palette.divider}`,
                          alignItems: 'stretch',
                        }}
                      >
                        {formActions.filter(a => !a.requiresAdminRole || userHasAccess !== false).map((action: ActionConfig) => {
                          const label = action.label || '';
                          const lowered = label.toLowerCase();
                          const getShort = (text: string) => {
                            if (text.indexOf('url') !== -1) return 'URL';
                            if (text.indexOf('clone') !== -1) return 'Clone';
                            if (text.indexOf('id') !== -1) return 'ID';
                            if (text.indexOf('find') !== -1) return 'Find';
                            if (text.indexOf('new') !== -1) return 'New';
                            if (text.indexOf('record') !== -1) return 'Record';
                            if (text.indexOf('solution') !== -1) return 'Solution';
                            return text.split(' ')[0].slice(0, 8);
                          };
                          const getIcon = (text: string) => {
                            if (text.indexOf('url') !== -1) return '🔗';
                            if (text.indexOf('clone') !== -1) return '📋';
                            if (text.indexOf('id') !== -1) return '🆔';
                            if (text.indexOf('find') !== -1) return '🔍';
                            if (text.indexOf('job') !== -1) return '⚙️';
                            if (text.indexOf('solution') !== -1) return '📦';
                            if (text.indexOf('record') !== -1) return '📄';
                            return '🔧';
                          };

                          const short = action.shortLabel || getShort(lowered);
                          const iconEmoji = action.shortIcon || getIcon(lowered);
                          const IconComp = (action.icon || null) as React.ComponentType<any> | null;
                          const available = isMakePage
                            ? action.requiresMakeTableContext
                              ? !!makeTableContext
                              : false
                            : action.requiresFormContext
                              ? isFormContext
                              : true;

                          return (
                            <Link
                              key={action.id}
                              component='button'
                              onClick={
                                available
                                  ? (e: React.MouseEvent) => {
                                      e.preventDefault();
                                      e.stopPropagation();
                                      handleActionClick(action.id, e.shiftKey);
                                    }
                                  : undefined
                              }
                              sx={{
                                color: 'text.primary',
                                textDecoration: 'none',
                                fontSize: '0.7rem',
                                background: 'none',
                                border: 'none',
                                cursor: available ? 'pointer' : 'not-allowed',
                                padding: '6px 4px',
                                borderRadius: '6px',
                                fontWeight: 600,
                                display: 'flex',
                                flexDirection: 'column',
                                alignItems: 'center',
                                justifyContent: 'center',
                                gap: 0.25,
                                opacity: available ? 1 : 0.4,
                                transition: 'all 0.12s ease',
                                '&:hover': available
                                  ? {
                                      backgroundColor: theme =>
                                        theme.palette.mode === 'dark'
                                          ? 'rgba(255,255,255,0.02)'
                                          : 'rgba(0,0,0,0.04)',
                                      transform: 'translateY(-2px)',
                                    }
                                  : {},
                              }}
                              title={
                                available
                                  ? action.tooltip || action.label
                                  : isMakePage
                                    ? `${action.label} — requires table context on make.powerapps.com`
                                    : `${action.label} — requires an open form`
                              }
                            >
                              {IconComp ? (
                                <IconComp sx={{ fontSize: 18 }} />
                              ) : (
                                <span style={{ fontSize: 18 }}>{iconEmoji}</span>
                              )}
                              <span style={{ fontSize: 11, marginTop: 2 }}>{short}</span>
                            </Link>
                          );
                        })}
                      </Box>
                    )}
                  </Box>
                )}

                {/* Table Actions */}
                {extensionConfig.showFormSection &&
                  (isFormContext || isListContext || (isMakePage && !!makeTableContext)) && (
                    <Box sx={{ mb: 1.5 }}>
                      <Typography
                        variant='subtitle2'
                        sx={{
                          fontSize: '0.75rem',
                          fontWeight: 600,
                          mb: 0.5,
                          color: 'text.primary',
                          textTransform: 'uppercase',
                          letterSpacing: '0.3px',
                          opacity: 0.8,
                        }}
                      >
                        Table Actions
                      </Typography>
                      <Box
                        sx={{
                          display: 'grid',
                          gridTemplateColumns: 'repeat(3, 1fr)',
                          gap: 0.5,
                          p: 0.5,
                          backgroundColor: theme =>
                            theme.palette.mode === 'dark'
                              ? theme.palette.background.paper
                              : 'rgba(255,255,255,0.85)',
                          borderRadius: '6px',
                          border: theme => `1px solid ${theme.palette.divider}`,
                          alignItems: 'stretch',
                        }}
                      >
                        {tableActions.filter(a => !a.requiresAdminRole || userHasAccess !== false).map((action: ActionConfig) => {
                          const IconComp3 = (action.icon ||
                            null) as React.ComponentType<any> | null;
                          const short = action.shortLabel || action.label.split(' ')[0].slice(0, 8);
                          const iconEmoji = action.shortIcon || '🔧';
                          const available = isMakePage ? !!makeTableContext : true;

                          return (
                            <Link
                              key={action.id}
                              component='button'
                              onClick={
                                available
                                  ? (e: React.MouseEvent) => {
                                      e.preventDefault();
                                      e.stopPropagation();
                                      handleActionClick(action.id, e.shiftKey);
                                    }
                                  : undefined
                              }
                              sx={{
                                color: 'text.primary',
                                textDecoration: 'none',
                                fontSize: '0.7rem',
                                background: 'none',
                                border: 'none',
                                cursor: available ? 'pointer' : 'not-allowed',
                                padding: '6px 4px',
                                borderRadius: '6px',
                                fontWeight: 600,
                                display: 'flex',
                                flexDirection: 'column',
                                alignItems: 'center',
                                justifyContent: 'center',
                                gap: 0.25,
                                opacity: available ? 1 : 0.4,
                                transition: 'all 0.12s ease',
                                '&:hover': available
                                  ? {
                                      backgroundColor: theme =>
                                        theme.palette.mode === 'dark'
                                          ? 'rgba(255,255,255,0.02)'
                                          : 'rgba(0,0,0,0.04)',
                                      transform: 'translateY(-2px)',
                                    }
                                  : {},
                              }}
                              title={
                                available
                                  ? action.tooltip || action.label
                                  : `${action.label} — requires table context`
                              }
                            >
                              {IconComp3 ? (
                                <IconComp3 sx={{ fontSize: 18 }} />
                              ) : (
                                <span style={{ fontSize: 18 }}>{iconEmoji}</span>
                              )}
                              <span style={{ fontSize: 11, marginTop: 2 }}>{short}</span>
                            </Link>
                          );
                        })}
                      </Box>
                    </Box>
                  )}

                {/* Navigation Actions */}
                {extensionConfig.showNavigationSection && (
                  <Box sx={{ mb: 1.5 }}>
                    <Typography
                      variant='subtitle2'
                      sx={{
                        fontSize: '0.75rem',
                        fontWeight: 600,
                        mb: 0.5,
                        color: 'text.primary',
                        textTransform: 'uppercase',
                        letterSpacing: '0.3px',
                        opacity: 0.8,
                      }}
                    >
                      Navigation
                    </Typography>
                    <Box
                      sx={{
                        display: 'grid',
                        gridTemplateColumns: 'repeat(3, 1fr)',
                        gap: 0.5,
                        p: 0.5,
                        backgroundColor: theme =>
                          theme.palette.mode === 'dark'
                            ? theme.palette.background.paper
                            : 'rgba(255,255,255,0.85)',
                        borderRadius: '6px',
                        border: theme => `1px solid ${theme.palette.divider}`,
                        alignItems: 'stretch',
                      }}
                    >
                      {navigationActions
                        .filter(
                          action =>
                            action.id !== 'navigation:select-default-solution' &&
                            action.id !== 'navigation:report-problem' &&
                            (!action.requiresAdminRole || userHasAccess !== false)
                        )
                        .map((action: ActionConfig) => {
                          const label = action.label || '';
                          const lowered = label.toLowerCase();
                          const short =
                            action.shortLabel ||
                            (lowered.indexOf('open') !== -1
                              ? 'Open'
                              : lowered.indexOf('list') !== -1
                                ? 'List'
                                : lowered.split(' ')[0].slice(0, 8));
                          const iconEmoji =
                            action.shortIcon ||
                            (lowered.indexOf('open') !== -1
                              ? '🔗'
                              : lowered.indexOf('list') !== -1
                                ? '📋'
                                : '➡️');
                          const IconComp2 = (action.icon ||
                            null) as React.ComponentType<any> | null;
                          const available = isMakePage
                            ? action.requiresXrm !== false
                              ? false
                              : true
                            : true;

                          return (
                            <Link
                              key={action.id}
                              component='button'
                              onClick={(e: React.MouseEvent) => {
                                e.preventDefault();
                                e.stopPropagation();
                                handleActionClick(action.id, e.shiftKey);
                              }}
                              sx={{
                                color: 'text.primary',
                                textDecoration: 'none',
                                fontSize: '0.7rem',
                                background: 'none',
                                border: 'none',
                                cursor: available ? 'pointer' : 'not-allowed',
                                padding: '6px 4px',
                                borderRadius: '6px',
                                fontWeight: 600,
                                display: 'flex',
                                flexDirection: 'column',
                                alignItems: 'center',
                                justifyContent: 'center',
                                gap: 0.25,
                                opacity: available ? 1 : 0.4,
                                transition: 'all 0.12s ease',
                                '&:hover': available
                                  ? {
                                      backgroundColor: theme =>
                                        theme.palette.mode === 'dark'
                                          ? 'rgba(255,255,255,0.02)'
                                          : 'rgba(0,0,0,0.04)',
                                      transform: 'translateY(-2px)',
                                    }
                                  : {},
                              }}
                              title={
                                available
                                  ? action.tooltip || action.label
                                  : `${action.label} — requires a Dynamics page`
                              }
                            >
                              {IconComp2 ? (
                                <IconComp2 sx={{ fontSize: 18 }} />
                              ) : (
                                <span style={{ fontSize: 18 }}>{iconEmoji}</span>
                              )}
                              <span style={{ fontSize: 11, marginTop: 2 }}>{short}</span>
                            </Link>
                          );
                        })}
                    </Box>
                  </Box>
                )}

            {/* Report a Problem - above hide toggle */}
            {(isConnected || isMakePage) && (
              <Box
                sx={{
                  pt: 1,
                  mt: 0.5,
                  borderTop: theme => `1px solid ${theme.palette.divider}`,
                }}
              >
                <Button
                  size='small'
                  variant='outlined'
                  color='warning'
                  fullWidth
                  startIcon={<ReportProblemIcon fontSize='small' />}
                  onClick={() => handleActionClick('navigation:report-problem' as DynamicsAction)}
                  sx={{ fontSize: '0.7rem', py: 0.25 }}
                >
                  Report a Problem
                </Button>
              </Box>
            )}

            {/* Sidebar Modes at Bottom - Only show for non-Firefox browsers */}
            {!isFirefox && (
              <Box
                sx={{
                  textAlign: 'center',
                  pt: 1,
                  mt: 0.5,
                  borderTop: theme => `1px solid ${theme.palette.divider}`,
                }}
              >
                <FormControlLabel
                  control={
                    <Switch
                      size='small'
                      checked={extensionConfig.hideDeprecatedColumns !== false}
                      onChange={e => handleHideDeprecatedToggle(e.target.checked)}
                    />
                  }
                  label={
                    <Typography sx={{ fontSize: '0.7rem', color: 'text.secondary' }}>
                      Hide deprecated (zz) columns
                    </Typography>
                  }
                  sx={{ mx: 0, mb: 0.5, justifyContent: 'center' }}
                />
                <Typography
                  variant='caption'
                  sx={{
                    color: 'text.secondary',
                    fontSize: '0.65rem',
                    display: 'block',
                    mb: 0.25,
                    textTransform: 'uppercase',
                    letterSpacing: '0.3px',
                    fontWeight: 500,
                  }}
                >
                  Sidebar Modes
                </Typography>
                <Box sx={{ display: 'flex', justifyContent: 'center', gap: 1.5 }}>
                  <Link
                    component='button'
                    onClick={() => switchDisplayModeAndOpenSidebar('default')}
                    sx={{
                      color: 'primary.main',
                      fontSize: '0.7rem',
                      textDecoration: 'none',
                      background: 'none',
                      border: 'none',
                      cursor: 'pointer',
                      padding: '2px 4px',
                      fontWeight: 500,
                      transition: 'color 0.2s ease',
                      '&:hover': {
                        color: 'primary.dark',
                        textDecoration: 'underline',
                      },
                    }}
                  >
                    Default
                  </Link>
                  <Box sx={{ color: 'text.secondary', fontSize: '0.7rem' }}>•</Box>
                  <Link
                    component='button'
                    onClick={() => switchDisplayModeAndOpenSidebar('simple')}
                    sx={{
                      color: 'primary.main',
                      fontSize: '0.7rem',
                      textDecoration: 'none',
                      background: 'none',
                      border: 'none',
                      cursor: 'pointer',
                      padding: '2px 4px',
                      fontWeight: 500,
                      transition: 'color 0.2s ease',
                      '&:hover': {
                        color: 'primary.dark',
                        textDecoration: 'underline',
                      },
                    }}
                  >
                    Simple
                  </Link>
                </Box>
              </Box>
            )}
          </>
        )}
      </Box>
    </Box>
  );
};

// Initialize popup
const container = document.getElementById('popup-root');
if (container) {
  const root = createRoot(container);
  root.render(
    <ThemeProvider>
      <PopupApp />
    </ThemeProvider>
  );
}

export default PopupApp;
