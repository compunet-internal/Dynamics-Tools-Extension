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
} from '@mui/material';
import type { SelectChangeEvent } from '@mui/material/Select';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import { ExtensionConfigService, ExtensionConfig } from '#services/ExtensionConfigService';
import { checkDynamicsViaXrm, getEnvironmentUrlFromXrm } from '#utils/dynamicsDetection';
import { DynamicsAction, ExtensionDisplayMode } from '#types/global';
import { ThemeProvider } from '#contexts/ThemeContext';
import { formActions, navigationActions, ActionConfig } from '#config/actions';

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
  const [isChecking, setIsChecking] = useState(true);
  const [inlineToast, setInlineToast] = useState<null | {
    message: string;
    severity: 'success' | 'info' | 'warning' | 'error';
  }>(null);
  const [solutions, setSolutions] = useState<SolutionOption[]>([]);
  const [selectedSolutionId, setSelectedSolutionId] = useState('');
  const [currentSolutionId, setCurrentSolutionId] = useState('');
  const [isLoadingSolutions, setIsLoadingSolutions] = useState(false);
  const [isSavingSolution, setIsSavingSolution] = useState(false);

  const normalizeSolutionId = (solutionId: string | undefined) =>
    (solutionId || '').replace(/[{}]/g, '').toLowerCase();

  const isSupportedDynamicsHost = (url: string | undefined): boolean => {
    if (!url) {
      return false;
    }

    try {
      const parsed = new URL(url);
      const host = parsed.hostname.toLowerCase();
      return host.endsWith('.crm.dynamics.com') && host !== 'crm.dynamics.com';
    } catch {
      return false;
    }
  };

  // Detect if running in Firefox
  const isFirefox =
    typeof chrome !== 'undefined' && chrome.runtime && navigator.userAgent.includes('Firefox');

  const triggerContextRecheck = () => {
    setContextCheckNonce(value => value + 1);
  };

  useEffect(() => {
    let cancelled = false;
    let periodicRecheck: number | undefined;

    const checkConnection = async () => {
      setIsChecking(true);

      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        const supportedHost = isSupportedDynamicsHost(tab?.url);

        setIsSupportedHost(supportedHost);

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

        if (!cancelled) {
          setContextMessage(
            'Dynamics is loading. We are checking for context in the background and will unlock actions automatically.'
          );
        }

        const maxAttempts = 15;
        for (let attempt = 0; attempt < maxAttempts; attempt++) {
          if (cancelled) {
            return;
          }

          const connected = await checkDynamicsViaXrm();
          const environmentUrl = await getEnvironmentUrlFromXrm();
          const ready = connected && Boolean(environmentUrl);

          if (ready) {
            if (!cancelled) {
              setIsConnected(true);
              setIsContextReady(true);
              setContextMessage('');
            }
            return;
          }

          if (!cancelled) {
            setIsConnected(false);
            setIsContextReady(false);
            setContextMessage(`Preparing Dynamics context... (${attempt + 1}/${maxAttempts}).`);
          }

          await new Promise(resolve => window.setTimeout(resolve, 900));
        }

        if (!cancelled) {
          setContextMessage(
            'Still waiting for Dynamics context. Keep this popup open or click Retry now.'
          );

          periodicRecheck = window.setInterval(async () => {
            if (cancelled) {
              if (periodicRecheck !== undefined) {
                window.clearInterval(periodicRecheck);
              }
              return;
            }

            const connected = await checkDynamicsViaXrm();
            const environmentUrl = await getEnvironmentUrlFromXrm();
            const ready = connected && Boolean(environmentUrl);

            if (ready) {
              setIsConnected(true);
              setIsContextReady(true);
              setContextMessage('');
              setIsChecking(false);
              if (periodicRecheck !== undefined) {
                window.clearInterval(periodicRecheck);
              }
            }
          }, 1200);
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
        if (!cancelled) {
          setIsChecking(false);
        }
      }
    };

    checkConnection();

    // Subscribe to config changes
    const unsubscribe = ExtensionConfigService.subscribe(setExtensionConfig);
    return () => {
      cancelled = true;
      if (periodicRecheck !== undefined) {
        window.clearInterval(periodicRecheck);
      }
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
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) {
      throw new Error('No active tab found');
    }

    return await new Promise<{ success: boolean; data?: unknown; error?: string }>(resolve => {
      chrome.tabs.sendMessage(
        tab.id!,
        {
          type: 'LEVELUP_REQUEST',
          action,
          data,
          requestId: Date.now().toString(),
        },
        response => {
          if (chrome.runtime.lastError) {
            resolve({ success: false, error: chrome.runtime.lastError.message });
            return;
          }

          resolve(response || { success: false, error: 'No response received' });
        }
      );
    });
  };

  const refreshSolutionDropdown = async () => {
    if (!isConnected) {
      setSolutions([]);
      setSelectedSolutionId('');
      setCurrentSolutionId('');
      return;
    }

    setIsLoadingSolutions(true);
    try {
      const [listResponse, currentResponse] = await Promise.all([
        sendActionToActiveTab('navigation:list-solutions'),
        sendActionToActiveTab('navigation:get-current-solution'),
      ]);

      if (!listResponse.success) {
        throw new Error(listResponse.error || 'Failed to load solutions');
      }

      const loadedSolutions = Array.isArray(listResponse.data)
        ? (listResponse.data as SolutionOption[])
        : [];

      setSolutions(loadedSolutions);

      if (currentResponse.success && currentResponse.data) {
        const current = currentResponse.data as { solutionId?: string };
        const resolvedCurrentId = current.solutionId || loadedSolutions[0]?.solutionid || '';
        setCurrentSolutionId(resolvedCurrentId);
        setSelectedSolutionId(resolvedCurrentId);
      } else {
        const fallbackSolutionId = loadedSolutions[0]?.solutionid || '';
        setCurrentSolutionId(fallbackSolutionId);
        setSelectedSolutionId(fallbackSolutionId);
      }
    } catch (error) {
      setSolutions([]);
      setSelectedSolutionId('');
      setCurrentSolutionId('');
      showInlineToast(
        `Failed to load default solution options: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'warning'
      );
    } finally {
      setIsLoadingSolutions(false);
    }
  };

  const handleDefaultSolutionChange = async (event: SelectChangeEvent<string>) => {
    const nextSolutionId = event.target.value;
    if (!nextSolutionId) {
      return;
    }

    setIsSavingSolution(true);
    setSelectedSolutionId(nextSolutionId);

    try {
      const response = await sendActionToActiveTab('navigation:set-preferred-solution', {
        solutionId: nextSolutionId,
      });

      if (!response.success) {
        throw new Error(response.error || 'Failed to set preferred solution');
      }

      setCurrentSolutionId(nextSolutionId);
      showInlineToast('Default solution updated', 'success');
      await refreshSolutionDropdown();
    } catch (error) {
      showInlineToast(
        `Failed to update preferred solution: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'error'
      );
      await refreshSolutionDropdown();
    } finally {
      setIsSavingSolution(false);
    }
  };

  const handleActionClick = async (actionId: DynamicsAction) => {
    try {
      console.log('Executing action:', actionId);

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
    if (isContextReady && isConnected && extensionConfig.showNavigationSection) {
      void refreshSolutionDropdown();
    }
  }, [isConnected, isContextReady, extensionConfig.showNavigationSection]);

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
        {/* Optimistic check spinner (small) */}
        {isChecking && (
          <Box sx={{ position: 'absolute', top: 10, right: 10, zIndex: 30 }}>
            <CircularProgress size={18} />
          </Box>
        )}

        {!isContextReady && (
          <Box
            sx={{
              mt: 0.5,
              p: 1.25,
              borderRadius: '8px',
              border: theme => `1px solid ${theme.palette.divider}`,
              backgroundColor: theme =>
                theme.palette.mode === 'dark'
                  ? theme.palette.background.paper
                  : 'rgba(255,255,255,0.88)',
              display: 'flex',
              flexDirection: 'column',
              gap: 0.75,
            }}
          >
            <Typography variant='subtitle2' sx={{ fontWeight: 700, fontSize: '0.8rem' }}>
              {isSupportedHost === false
                ? 'Open on a Dynamics Page'
                : 'Waiting for Dynamics Context'}
            </Typography>
            <Typography sx={{ fontSize: '0.72rem', color: 'text.secondary', lineHeight: 1.35 }}>
              {contextMessage}
            </Typography>
            {isSupportedHost !== false && (
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
                <CircularProgress size={14} />
                <Typography sx={{ fontSize: '0.7rem', color: 'text.secondary' }}>
                  Rechecking every second...
                </Typography>
              </Box>
            )}
            <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <Typography sx={{ fontSize: '0.67rem', color: 'text.secondary' }}>
                {isSupportedHost === false
                  ? 'Supported host: *.crm.dynamics.com'
                  : 'If this takes too long, refresh the Dynamics page.'}
              </Typography>
              <Button
                size='small'
                variant='text'
                onClick={triggerContextRecheck}
                disabled={isChecking}
                sx={{ minWidth: 0, fontSize: '0.67rem', px: 0.75, py: 0.2 }}
              >
                Retry now
              </Button>
            </Box>
          </Box>
        )}

        {isContextReady && (
          <>
            {/* Default solution selector moved to top of popup */}
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
                  Default Solution
                </Typography>
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
                    disabled={isLoadingSolutions || isSavingSolution || !isConnected}
                  >
                    <Select value={selectedSolutionId} onChange={handleDefaultSolutionChange}>
                      {solutions.length === 0 && (
                        <MenuItem value='' disabled>
                          {isLoadingSolutions ? 'Loading solutions...' : 'No solutions available'}
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
                              }}
                            >
                              <span>{solution.friendlyname}</span>
                              {isCurrent && (
                                <CheckCircleIcon sx={{ fontSize: 16, color: 'success.main' }} />
                              )}
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
            {extensionConfig.showFormSection && (
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
                  {formActions.map((action: ActionConfig) => {
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

                    return (
                      <Link
                        key={action.id}
                        component='button'
                        onClick={(e: React.MouseEvent) => {
                          e.preventDefault();
                          e.stopPropagation();
                          handleActionClick(action.id);
                        }}
                        sx={{
                          color: 'text.primary',
                          textDecoration: 'none',
                          fontSize: '0.7rem',
                          background: 'none',
                          border: 'none',
                          cursor: 'pointer',
                          padding: '6px 4px',
                          borderRadius: '6px',
                          fontWeight: 600,
                          display: 'flex',
                          flexDirection: 'column',
                          alignItems: 'center',
                          justifyContent: 'center',
                          gap: 0.25,
                          transition: 'all 0.12s ease',
                          '&:hover': {
                            backgroundColor: theme =>
                              theme.palette.mode === 'dark'
                                ? 'rgba(255,255,255,0.02)'
                                : 'rgba(0,0,0,0.04)',
                            transform: 'translateY(-2px)',
                          },
                        }}
                        title={action.tooltip || action.label}
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
                    .filter(action => action.id !== 'navigation:select-default-solution')
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
                      const IconComp2 = (action.icon || null) as React.ComponentType<any> | null;

                      return (
                        <Link
                          key={action.id}
                          component='button'
                          onClick={(e: React.MouseEvent) => {
                            e.preventDefault();
                            e.stopPropagation();
                            handleActionClick(action.id);
                          }}
                          sx={{
                            color: 'text.primary',
                            textDecoration: 'none',
                            fontSize: '0.7rem',
                            background: 'none',
                            border: 'none',
                            cursor: 'pointer',
                            padding: '6px 4px',
                            borderRadius: '6px',
                            fontWeight: 600,
                            display: 'flex',
                            flexDirection: 'column',
                            alignItems: 'center',
                            justifyContent: 'center',
                            gap: 0.25,
                            transition: 'all 0.12s ease',
                            '&:hover': {
                              backgroundColor: theme =>
                                theme.palette.mode === 'dark'
                                  ? 'rgba(255,255,255,0.02)'
                                  : 'rgba(0,0,0,0.04)',
                              transform: 'translateY(-2px)',
                            },
                          }}
                          title={action.tooltip || action.label}
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
