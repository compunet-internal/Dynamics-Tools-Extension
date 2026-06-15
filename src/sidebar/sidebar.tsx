import React, { useState, useEffect, useMemo } from 'react';
import { createRoot } from 'react-dom/client';
import { Box, Button, IconButton, Tooltip } from '@mui/material';
import { GitHub, Forum, ReportProblem as ReportProblemIcon } from '@mui/icons-material';
import { DynamicsAction, ExtensionDisplayMode } from '#types/global';
import { messageService } from '#services/MessageService';
import { ExtensionConfigService, ExtensionConfig } from '#services/ExtensionConfigService';
import { getStoredClientUrl, fetchEntityMetadataId } from '#services/DataverseDirectService';
import { ThemeProvider } from '#contexts/ThemeContext';
import {
  checkDynamicsViaXrm,
  checkIsMakePage,
  getEnvironmentUrlFromXrm,
  getPageTypeFromTab,
  getPowerPlatformEnvironmentIdFromUrl,
  getTableContextFromMakeUrl,
  MakeTableContext,
} from '#utils/dynamicsDetection';
import { formActions, tableActions, navigationActions, debuggingActions } from '#config/actions';
import ThemeSwitchButtons from '#components/ThemeSwitchButtons';
import ExtendedDisplayModeSelector from '#components/ExtendedDisplayModeSelector';
import StatusIndicator from '#components/StatusIndicator';
import ActionSection from '#components/ActionSection';
import Favorites from '#components/Favorites';
import Impersonation from '#components/Impersonation';
import InputDialog from '#components/InputDialog';
import LoadingOverlay from '#components/LoadingOverlay';
import Toast from '#components/Toast';
import InlineAlert from '#components/InlineAlert';
import MyCommands from '#components/MyCommands';
import RecentlyUsed from '#components/RecentlyUsed';
import InformationButton from '#components/InformationButton';
import ReportProblemDialog from '#components/ReportProblemDialog';

interface SidebarCurrentSolutionInfo {
  solutionId: string;
  friendlyname: string;
  uniquename: string;
  source: 'preferred' | 'default';
}

const App: React.FC = () => {
  const [loadingOpen, setLoadingOpen] = useState(false);
  const [toastOpen, setToastOpen] = useState(false);
  const [toastMessage, setToastMessage] = useState('');
  const [toastSeverity, setToastSeverity] = useState<'success' | 'info' | 'warning' | 'error'>(
    'success'
  );
  const [inlineAlertOpen, setInlineAlertOpen] = useState(false);
  const [inlineAlertMessage, setInlineAlertMessage] = useState('');
  const [inlineAlertSeverity, setInlineAlertSeverity] = useState<
    'success' | 'info' | 'warning' | 'error'
  >('warning');
  const [inputDialogOpen, setInputDialogOpen] = useState(false);
  const [dialogType, setDialogType] = useState<'open-by-id' | 'new-record' | 'open-list'>(
    'open-by-id'
  );
  const [reportProblemDialogOpen, setReportProblemDialogOpen] = useState(false);
  const [entityName, setEntityName] = useState('');
  const [recordId, setRecordId] = useState('');
  const [isConnected, setIsConnected] = useState(false);
  const [isChecking, setIsChecking] = useState(true);
  const [isFormContext, setIsFormContext] = useState(false);
  const [isListContext, setIsListContext] = useState(false);
  const [isMakePage, setIsMakePage] = useState(false);
  const [makeTableContext, setMakeTableContext] = useState<MakeTableContext | null>(null);
  const [makeClientUrl, setMakeClientUrl] = useState<string | null>(null);
  const [extensionConfig, setExtensionConfig] = useState<ExtensionConfig>(
    ExtensionConfigService.getConfig()
  );
  const [favoriteIds, setFavoriteIds] = useState<DynamicsAction[]>([]);
  const [environmentUrl, setEnvironmentUrl] = useState<string>('');
  const [currentSolutionTooltip, setCurrentSolutionTooltip] = useState(
    'Choose the default solution CompuNet Dynamics Tools should use in this environment'
  );

  // Function to show inline alert for critical messages
  const showInlineAlert = (
    message: string,
    severity: 'success' | 'info' | 'warning' | 'error' = 'warning'
  ) => {
    setInlineAlertMessage(message);
    setInlineAlertSeverity(severity);
    setInlineAlertOpen(true);
    // Auto-hide after 10 seconds for warnings/errors, 6 seconds for others
    setTimeout(
      () => {
        setInlineAlertOpen(false);
      },
      severity === 'warning' || severity === 'error' ? 10000 : 6000
    );
  };

  // Memoize action arrays for better performance
  const memoizedFormActions = useMemo(() => formActions, []);
  const memoizedTableActions = useMemo(() => tableActions, []);
  const memoizedDebuggingActions = useMemo(() => debuggingActions, []);

  const refreshCurrentSolutionTooltip = async () => {
    if (!isConnected) {
      setCurrentSolutionTooltip(
        'Choose the default solution CompuNet Dynamics Tools should use in this environment'
      );
      return;
    }

    try {
      const solutionInfo = await messageService.sendMessageTyped<SidebarCurrentSolutionInfo | null>(
        'navigation:get-current-solution'
      );

      if (!solutionInfo) {
        setCurrentSolutionTooltip(
          'Choose the default solution CompuNet Dynamics Tools should use in this environment'
        );
        return;
      }

      const sourceLabel =
        solutionInfo.source === 'preferred' ? 'Dataverse preferred' : 'Dataverse default';

      setCurrentSolutionTooltip(`Current: ${solutionInfo.friendlyname} (${sourceLabel})`);
    } catch {
      setCurrentSolutionTooltip(
        'Choose the default solution CompuNet Dynamics Tools should use in this environment'
      );
    }
  };

  const memoizedNavigationActions = useMemo(
    () =>
      navigationActions.map(action =>
        action.id === 'navigation:select-default-solution'
          ? {
              ...action,
              tooltip: currentSolutionTooltip,
              onTooltipOpen: refreshCurrentSolutionTooltip,
            }
          : action
      ),
    [currentSolutionTooltip, isConnected]
  );

  useEffect(() => {
    // Use shared helpers for detection and environment URL extraction

    const updateConnectionState = async (tab: chrome.tabs.Tab) => {
      const connected = await checkDynamicsViaXrm();
      const makePage = await checkIsMakePage();
      setIsConnected(connected);
      setIsMakePage(makePage);

      if (connected && !makePage) {
        const env = await getEnvironmentUrlFromXrm();
        setEnvironmentUrl(env ? new URL(env).hostname : '');
        const pageType = await getPageTypeFromTab();
        setIsFormContext(pageType === 'entityrecord');
        setIsListContext(pageType === 'entitylist');
        setMakeTableContext(null);
      } else if (makePage) {
        // Extract environment display name from URL — covers both make.powerapps.com and admin.powerplatform.microsoft.com
        const envId = getPowerPlatformEnvironmentIdFromUrl(tab.url);
        const isAdminPage = /^https:\/\/admin\.powerplatform\.microsoft\.com\//i.test(
          tab.url || ''
        );
        const hostLabel = isAdminPage ? 'admin.powerplatform.microsoft.com' : 'make.powerapps.com';
        setEnvironmentUrl(envId ? `${hostLabel} (${envId.substring(0, 8)}…)` : hostLabel);
        setIsFormContext(false);
        setIsListContext(false);
        setMakeTableContext(getTableContextFromMakeUrl(tab.url));
        const storedClientUrl = envId ? await getStoredClientUrl(envId) : null;
        setMakeClientUrl(storedClientUrl);
      } else {
        setEnvironmentUrl('');
        setIsFormContext(false);
        setIsListContext(false);
        setMakeClientUrl(null);
      }
    };

    const checkDynamicsConnection = async () => {
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab) {
          await updateConnectionState(tab);
        } else {
          setIsConnected(false);
          setEnvironmentUrl('');
        }
      } catch (err) {
        console.error('Error checking connection:', err);
        setIsConnected(false);
        setEnvironmentUrl('');
      } finally {
        setIsChecking(false);
      }
    };

    checkDynamicsConnection();

    const handleTabUpdate = async (
      tabId: number,
      changeInfo: chrome.tabs.TabChangeInfo,
      tab: chrome.tabs.Tab
    ) => {
      if (tab.active && (changeInfo.url || changeInfo.status === 'complete')) {
        await updateConnectionState(tab);
      }
    };

    const handleTabActivated = async (activeInfo: chrome.tabs.TabActiveInfo) => {
      try {
        const tab = await chrome.tabs.get(activeInfo.tabId);
        if (tab) {
          await updateConnectionState(tab);
        }
      } catch (error) {
        console.error('Error handling tab activation:', error);
        setIsConnected(false);
        setEnvironmentUrl('');
      }
    };

    chrome.tabs.onUpdated.addListener(handleTabUpdate);
    chrome.tabs.onActivated.addListener(handleTabActivated);

    return () => {
      chrome.tabs.onUpdated.removeListener(handleTabUpdate);
      chrome.tabs.onActivated.removeListener(handleTabActivated);
    };
  }, []);

  // Load favorites
  useEffect(() => {
    const saved = localStorage.getItem('levelup-favorites');
    if (saved) {
      try {
        setFavoriteIds(JSON.parse(saved));
      } catch {}
    }
  }, []);

  // Listen for unsolicited toast notifications from MessageService
  useEffect(() => {
    const handleToastEvent = (
      event: CustomEvent<{ message: string; severity: 'success' | 'info' | 'warning' | 'error' }>
    ) => {
      setToastMessage(event.detail.message);
      setToastSeverity(event.detail.severity);
      setToastOpen(true);
    };

    window.addEventListener('levelup-toast', handleToastEvent as EventListener);

    return () => {
      window.removeEventListener('levelup-toast', handleToastEvent as EventListener);
    };
  }, []);

  const handleDisplayModeChange = async (mode: ExtensionDisplayMode) => {
    await ExtensionConfigService.setDisplayMode(mode);
  };

  const handleFavoriteToggle = (buttonId: DynamicsAction) => {
    const newFavorites = favoriteIds.includes(buttonId)
      ? favoriteIds.filter(id => id !== buttonId)
      : [...favoriteIds, buttonId];
    setFavoriteIds(newFavorites);
    localStorage.setItem('levelup-favorites', JSON.stringify(newFavorites));
  };

  /**
   * Handle actions that can run directly on make.powerapps.com pages.
   * Returns true if the action was handled, false if it requires Xrm.
   */
  const handleMakePageAction = async (id: DynamicsAction, shiftKey: boolean): Promise<boolean> => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const envId = getPowerPlatformEnvironmentIdFromUrl(tab?.url);

    /** Resolve the Dataverse org URL for MetadataId lookups.
     * Priority: (1) content script same-origin API, (2) stored URL keyed by
     * the CURRENT envId (set when visiting that env's crm page).
     * Never falls back to stale React state from a different environment.
     */
    const resolveClientUrl = async (): Promise<string | null> => {
      if (!envId) return null;
      // 1. Content script same-origin API — always returns for the correct env
      if (tab?.id) {
        try {
          const response = await chrome.tabs.sendMessage(tab.id, {
            type: 'GET_DATAVERSE_URL_FROM_PAGE',
            envId,
          });
          const found = response?.data as string | null | undefined;
          if (found) return found;
        } catch {
          // Content script not responding — fall through
        }
      }
      // 2. Stored URL keyed to this specific envId (written by crm.dynamics.com page)
      return getStoredClientUrl(envId);
    };

    if (id === 'navigation:open-solutions') {
      const url = envId
        ? `https://make.powerapps.com/environments/${envId}/solutions`
        : 'https://make.powerapps.com';
      shiftKey ? chrome.tabs.update({ url }) : chrome.tabs.create({ url });
      return true;
    }

    if (id === 'navigation:open-solutions-history') {
      const url = envId
        ? `https://make.powerapps.com/environments/${envId}/solutionsHistory`
        : 'https://make.powerapps.com';
      shiftKey ? chrome.tabs.update({ url }) : chrome.tabs.create({ url });
      return true;
    }

    if (id === 'form:open-table-editor') {
      const tableCtx = getTableContextFromMakeUrl(tab?.url);
      if (tableCtx && envId) {
        let url: string;
        if (tableCtx.metadataId) {
          // Already have the GUID — use it directly
          url = `https://make.powerapps.com/environments/${envId}/entities/${tableCtx.metadataId}`;
        } else if (tableCtx.logicalName) {
          // Try to resolve the MetadataId via stored or page-scanned Dataverse URL
          const clientUrl = await resolveClientUrl();
          const metadataId = clientUrl
            ? ((await fetchEntityMetadataId(clientUrl, tableCtx.logicalName)) ?? undefined)
            : undefined;
          if (metadataId) {
            url = `https://make.powerapps.com/environments/${envId}/entities/${metadataId}`;
          } else if (tableCtx.solutionId) {
            // Best effort: solution-scoped entity view
            url = `https://make.powerapps.com/e/${envId}/s/${tableCtx.solutionId}/entity/${tableCtx.logicalName}`;
          } else {
            url = `https://make.powerapps.com/environments/${envId}/tables/${tableCtx.logicalName}`;
          }
        } else {
          return false;
        }
        shiftKey ? chrome.tabs.update({ url }) : chrome.tabs.create({ url });
        return true;
      }
      return false;
    }

    if (id === 'form:table-processes') {
      const tableCtx = getTableContextFromMakeUrl(tab?.url);
      if (tableCtx && envId) {
        const base = tableCtx.logicalName
          ? `https://make.powerapps.com/environments/${envId}/tables/${tableCtx.logicalName}`
          : `https://make.powerapps.com/environments/${envId}/entities/${tableCtx.metadataId}`;
        shiftKey ? chrome.tabs.update({ url: base }) : chrome.tabs.create({ url: base });
        return true;
      }
      return false;
    }

    return false;
  };

  const favoriteButtons = useMemo(() => {
    const all = [
      ...memoizedFormActions,
      ...memoizedTableActions,
      ...memoizedNavigationActions,
      ...memoizedDebuggingActions,
    ];
    return all.filter(a => favoriteIds.includes(a.id));
  }, [
    memoizedFormActions,
    memoizedTableActions,
    memoizedNavigationActions,
    memoizedDebuggingActions,
    favoriteIds,
  ]);

  // All actions for recently used component
  const allActions = useMemo(() => {
    return [
      ...memoizedFormActions,
      ...memoizedTableActions,
      ...memoizedNavigationActions,
      ...memoizedDebuggingActions,
    ];
  }, [
    memoizedFormActions,
    memoizedTableActions,
    memoizedNavigationActions,
    memoizedDebuggingActions,
  ]);

  const filteredFormActions = useMemo(
    () => memoizedFormActions.filter(a => !favoriteIds.includes(a.id)),
    [memoizedFormActions, favoriteIds]
  );
  const filteredTableActions = useMemo(
    () => memoizedTableActions.filter(a => !favoriteIds.includes(a.id)),
    [memoizedTableActions, favoriteIds]
  );
  const filteredNavigationActions = useMemo(
    () =>
      memoizedNavigationActions.filter(
        a => !favoriteIds.includes(a.id) && a.id !== 'navigation:report-problem'
      ),
    [memoizedNavigationActions, favoriteIds]
  );
  const filteredDebuggingActions = useMemo(
    () => memoizedDebuggingActions.filter(a => !favoriteIds.includes(a.id)),
    [memoizedDebuggingActions, favoriteIds]
  );

  const handleActionClick = async (id: DynamicsAction, shiftKey = false) => {
    // Report a Problem is available on any connected page (Dynamics or make/admin)
    if (id === 'navigation:report-problem') {
      if (isConnected || isMakePage) {
        setReportProblemDialogOpen(true);
        return;
      }
    }

    if (!isConnected) {
      setToastMessage('Please navigate to a Dynamics 365/Power Apps page to use this feature');
      setToastSeverity('warning');
      setToastOpen(true);
      return;
    }

    // Handle make page actions directly without content script
    if (isMakePage) {
      const handled = await handleMakePageAction(id, shiftKey);
      if (handled) return;
      setToastMessage('This action requires a Dynamics 365 environment page (*.crm.dynamics.com)');
      setToastSeverity('warning');
      setToastOpen(true);
      return;
    }

    // Dispatch custom event for recently used tracking
    window.dispatchEvent(
      new CustomEvent('levelup-action-used', {
        detail: { actionId: id },
      })
    );

    if (id === 'navigation:open-record-by-id') {
      setDialogType('open-by-id');
      setInputDialogOpen(true);
      return;
    }
    if (id === 'navigation:new-record') {
      setDialogType('new-record');
      setInputDialogOpen(true);
      return;
    }
    if (id === 'navigation:open-list') {
      setDialogType('open-list');
      setInputDialogOpen(true);
      return;
    }

    setLoadingOpen(true);
    try {
      const response = await messageService.sendMessage(id);
      if (!response.success) {
        setToastMessage(`Action failed: ${response.error || 'Unknown error'}`);
        setToastSeverity('error');
        setToastOpen(true);
      }
    } catch (error) {
      setToastMessage(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
      setToastSeverity('error');
      setToastOpen(true);
    } finally {
      setLoadingOpen(false);
    }
  };

  const handleDialogSubmit = async () => {
    if (dialogType === 'open-by-id') {
      if (!entityName.trim() || !recordId.trim()) {
        setToastMessage('Entity name and record ID are required');
        setToastSeverity('error');
        setToastOpen(true);
        return;
      }
    } else if (dialogType === 'new-record' || dialogType === 'open-list') {
      if (!entityName.trim()) {
        setToastMessage('Entity name is required');
        setToastSeverity('error');
        setToastOpen(true);
        return;
      }
    }

    setInputDialogOpen(false);
    setLoadingOpen(true);
    try {
      let action = '';
      let data: Record<string, string> = {};
      switch (dialogType) {
        case 'open-by-id':
          action = 'navigation:open-record-by-id';
          data = { entityName: entityName.trim(), recordId: recordId.trim() };
          break;
        case 'new-record':
          action = 'navigation:new-record';
          data = { entityName: entityName.trim() };
          break;
        case 'open-list':
          action = 'navigation:open-list';
          data = { entityName: entityName.trim() };
          break;
      }

      const response = await messageService.sendMessage(action as DynamicsAction, data);
      if (response.success) {
        let successMessage = '';
        switch (dialogType) {
          case 'open-by-id':
            successMessage = `Record opened: ${entityName} (${recordId})`;
            break;
          case 'new-record':
            successMessage = `New ${entityName} record created`;
            break;
          case 'open-list':
            successMessage = `${entityName} list opened`;
            break;
        }
        setToastMessage(successMessage);
        setToastSeverity('success');
        setToastOpen(true);
        setEntityName('');
        setRecordId('');
      } else {
        setToastMessage(`Action failed: ${response.error || 'Unknown error'}`);
        setToastSeverity('error');
        setToastOpen(true);
      }
    } catch (error) {
      setToastMessage(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
      setToastSeverity('error');
      setToastOpen(true);
    } finally {
      setLoadingOpen(false);
    }
  };

  const handleDialogCancel = () => {
    setInputDialogOpen(false);
    setEntityName('');
    setRecordId('');
  };

  const openAdminCenter = async () => {
    if (!isConnected) {
      setToastMessage('Please navigate to a Dynamics 365/Power Apps page to use this feature');
      setToastSeverity('warning');
      setToastOpen(true);
      return;
    }

    // Use the same action as the "Open Power Platform Admin Center" button
    await handleActionClick('navigation:open-power-platform-admin');
  };

  const openGitHubIssues = () => {
    chrome.tabs.create({ url: 'https://github.com/rajyraman/Levelup-for-Dynamics-CRM/' });
  };

  const openDiscord = () => {
    chrome.tabs.create({ url: 'https://discord.com/invite/MwdEqfeZXD' });
  };

  return (
    <Box
      sx={{
        height: '100vh',
        display: 'flex',
        flexDirection: 'column',
        boxSizing: 'border-box',
        bgcolor: 'background.default',
        color: 'text.primary',
      }}
    >
      <Box
        sx={{
          position: 'sticky',
          top: 0,
          bgcolor: 'background.default',
          zIndex: 1000,
          padding: '6px 6px 6px 6px',
          borderBottom: 1,
          borderColor: 'divider',
        }}
      >
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 1,
            minWidth: 0,
          }}
        >
          {/* header left / actions could go here */}
        </Box>
        {isConnected && !isMakePage && extensionConfig.showImpersonation && <Impersonation />}
      </Box>

      <Box sx={{ flex: 1, overflowY: 'auto', padding: '6px' }}>
        {isConnected ? (
          <>
            {extensionConfig.showRecentlyUsed && (
              <RecentlyUsed
                allActions={allActions}
                onActionClick={handleActionClick}
                onActionUsed={() => {}} // This is handled by the custom event
              />
            )}
            {extensionConfig.showFavorites && favoriteButtons.length > 0 && (
              <Favorites
                favoriteButtons={favoriteButtons}
                onActionClick={handleActionClick}
                onFavoriteToggle={handleFavoriteToggle}
              />
            )}
            {extensionConfig.showCustomCommands && (
              <MyCommands
                onToast={(message, severity) => {
                  setToastMessage(message);
                  setToastSeverity(severity);
                  setToastOpen(true);
                }}
              />
            )}
            {extensionConfig.showActionSections && (
              <>
                {extensionConfig.showFormSection !== false && filteredFormActions.length > 0 && (
                  <ActionSection
                    title='Form'
                    buttons={filteredFormActions}
                    onActionClick={handleActionClick}
                    onFavoriteToggle={handleFavoriteToggle}
                    favoriteIds={favoriteIds}
                    isFormContext={isFormContext}
                    isMakePage={isMakePage}
                    makeTableContext={makeTableContext}
                    unavailableMessage={
                      !isFormContext && !isMakePage
                        ? 'Open a record to use Form Actions'
                        : undefined
                    }
                  />
                )}
                {extensionConfig.showFormSection !== false &&
                  filteredTableActions.length > 0 &&
                  (isFormContext || isListContext || (isMakePage && !!makeTableContext)) && (
                    <ActionSection
                      title='Table'
                      buttons={filteredTableActions}
                      onActionClick={handleActionClick}
                      onFavoriteToggle={handleFavoriteToggle}
                      favoriteIds={favoriteIds}
                      isFormContext={isFormContext}
                      isMakePage={isMakePage}
                      makeTableContext={makeTableContext}
                    />
                  )}
                {extensionConfig.showNavigationSection !== false &&
                  filteredNavigationActions.length > 0 && (
                    <ActionSection
                      title='Navigation'
                      buttons={filteredNavigationActions}
                      onActionClick={handleActionClick}
                      onFavoriteToggle={handleFavoriteToggle}
                      favoriteIds={favoriteIds}
                      isMakePage={isMakePage}
                      makeTableContext={makeTableContext}
                    />
                  )}
                {extensionConfig.showDebuggingSection !== false &&
                  filteredDebuggingActions.length > 0 && (
                    <ActionSection
                      title='Debugging'
                      buttons={filteredDebuggingActions}
                      onActionClick={handleActionClick}
                      onFavoriteToggle={handleFavoriteToggle}
                      favoriteIds={favoriteIds}
                      isMakePage={isMakePage}
                    />
                  )}
              </>
            )}
          </>
        ) : (
          <Box
            sx={{
              padding: '24px 16px',
              textAlign: 'center',
              color: 'text.secondary',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 1.5,
              height: '100%',
            }}
          >
            <Box component='p' sx={{ margin: 0, fontWeight: 500 }}>
              Navigate to a Dynamics 365 / Power Platform site to use this extension.
            </Box>
            <Box component='p' sx={{ fontSize: '0.875rem', margin: 0 }}>
              Supported: *.crm.dynamics.com and make.powerapps.com pages.
            </Box>
          </Box>
        )}
      </Box>

      <InputDialog
        open={inputDialogOpen}
        onClose={handleDialogCancel}
        onSubmit={handleDialogSubmit}
        title={
          dialogType === 'open-by-id'
            ? 'Open Record by ID'
            : dialogType === 'new-record'
              ? 'Create New Record'
              : dialogType === 'open-list'
                ? 'Open Entity List'
                : ''
        }
        type={dialogType}
        entityName={entityName}
        recordId={recordId}
        onEntityNameChange={setEntityName}
        onRecordIdChange={setRecordId}
      />
      <LoadingOverlay open={loadingOpen} />
      <Toast
        open={toastOpen}
        onClose={() => setToastOpen(false)}
        message={toastMessage}
        severity={toastSeverity}
      />
      <ReportProblemDialog
        open={reportProblemDialogOpen}
        onClose={() => setReportProblemDialogOpen(false)}
        onSuccess={caseUrl => {
          setReportProblemDialogOpen(false);
          setToastMessage(
            caseUrl.startsWith('http')
              ? 'Case created — opening record…'
              : 'Support case created successfully'
          );
          setToastSeverity('success');
          setToastOpen(true);
          if (caseUrl.startsWith('http')) {
            chrome.tabs.create({ url: caseUrl });
          }
        }}
        onError={message => {
          setReportProblemDialogOpen(false);
          setToastMessage(`Failed to create case: ${message}`);
          setToastSeverity('error');
          setToastOpen(true);
        }}
      />

      {(isConnected || isMakePage) && (
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            px: 1,
            py: 0.5,
            borderTop: 1,
            borderColor: 'divider',
            bgcolor: 'background.paper',
          }}
        >
          <Button
            size='small'
            variant='outlined'
            color='warning'
            startIcon={<ReportProblemIcon fontSize='small' />}
            onClick={() => setReportProblemDialogOpen(true)}
            sx={{ fontSize: '0.75rem', py: 0.25, width: '100%' }}
          >
            Report a Problem
          </Button>
        </Box>
      )}

      <Box
        className='sidebar-status-bar'
        sx={{
          justifyContent: 'space-between',
          bgcolor: 'background.paper',
          borderColor: 'divider',
        }}
      >
        <Box sx={{ display: 'flex', alignItems: 'center', flex: 1, minWidth: 0 }}>
          <StatusIndicator
            loading={isChecking}
            connected={isConnected}
            environmentUrl={environmentUrl}
            onOpenAdmin={openAdminCenter}
          />
        </Box>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <Tooltip title='Join Power Platform Discord Community' placement='top'>
            <IconButton
              size='small'
              onClick={openDiscord}
              sx={{
                color: 'text.secondary',
                '&:hover': {
                  color: 'primary.main',
                  bgcolor: 'action.hover',
                },
              }}
            >
              <Forum fontSize='small' />
            </IconButton>
          </Tooltip>
          <Tooltip title='Report an issue on GitHub' placement='top'>
            <IconButton
              size='small'
              onClick={openGitHubIssues}
              sx={{
                color: 'text.secondary',
                '&:hover': {
                  color: 'primary.main',
                  bgcolor: 'action.hover',
                },
              }}
            >
              <GitHub fontSize='small' />
            </IconButton>
          </Tooltip>
          <InformationButton />
          <ExtendedDisplayModeSelector
            currentMode={extensionConfig.displayMode}
            onModeChange={handleDisplayModeChange}
          />
          <ThemeSwitchButtons />
        </Box>
      </Box>

      {/* Floating overlay alerts - no layout shift */}
      <InlineAlert
        open={inlineAlertOpen}
        onClose={() => setInlineAlertOpen(false)}
        message={inlineAlertMessage}
        severity={inlineAlertSeverity}
      />
    </Box>
  );
};

const container = document.getElementById('root');
if (container) {
  const root = createRoot(container);
  root.render(
    <ThemeProvider>
      <App />
    </ThemeProvider>
  );
}

export default App;

