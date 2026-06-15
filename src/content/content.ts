// Content script that runs on Dynamics 365 pages
/// <reference types="xrm" />

import { ActionMessage, DynamicsResponse } from '#types/global';

// Message types used by the content script and injected script
interface SessionMessage {
  type: 'SET_SESSION_KEY' | 'GET_SESSION_KEY' | 'CLEAR_SESSION_KEY';
  sessionKey?: string;
}

interface MetadataMessage {
  type: 'GET_ENTITY_METADATA_REQUEST';
}

interface UserSearchMessage {
  type: 'SEARCH_USERS_REQUEST';
  query?: string;
}

interface PageContextMessage {
  type: 'GET_PAGE_CONTEXT';
}

interface GetDataverseUrlMessage {
  type: 'GET_DATAVERSE_URL_FROM_PAGE';
  envId?: string;
}

interface OpenReportFormMessage {
  type: 'OPEN_REPORT_FORM';
}

type ContentScriptMessage =
  | ActionMessage
  | SessionMessage
  | MetadataMessage
  | UserSearchMessage
  | PageContextMessage
  | GetDataverseUrlMessage
  | OpenReportFormMessage;

interface ContentScriptResponse extends DynamicsResponse {
  sessionKey?: string;
  pageContext?: unknown;
}

/** Actions that open a new tab/window — deduplicated at the content-script level. */
const TAB_OPENING_ACTIONS = new Set([
  'form:open-editor',
  'form:open-table-editor',
  'form:open-web-api',
]);

class ContentScript {
  private injectedScript: HTMLScriptElement | null = null;
  private sessionKey: string | null = null;
  /** Timestamps of last dispatch for tab-opening actions, keyed by action name. */
  private lastDispatchTime: Map<string, number> = new Map();

  constructor() {
    // debug: print hostname so we can see where the content script runs
    // eslint-disable-next-line no-console
    console.debug('Level Up: content script starting on host', window.location.hostname);
    this.init().catch(error => {
      // eslint-disable-next-line no-console
      console.error('Level Up: Failed to initialize content script:', error);
    });
  }

  private async init(): Promise<void> {
    // Always setup message listener so sidebar can communicate
    this.setupMessageListener();
    this.loadSessionKey();

    // Check if we're on a Dynamics 365 page
    const isDynamicsPage = this.isDynamics365Page();

    if (isDynamicsPage) {
      // Only inject script and activate features if we're on a Dynamics page
      this.injectScript();
      this.setupColumnPickerFilter();
      this.setupSignInDialogDetector();
    } else {
      // eslint-disable-next-line no-console
      console.debug(
        'Level Up: Not a Dynamics 365 page, content script available for sidebar communication only'
      );
    }
  }

  private loadSessionKey(): void {
    // Try to restore session key from sessionStorage
    const storedSessionKey = sessionStorage.getItem('levelup_session_key');
    if (storedSessionKey) {
      this.sessionKey = storedSessionKey;
    }
  }

  private saveSessionKey(sessionKey: string): void {
    this.sessionKey = sessionKey;
    sessionStorage.setItem('levelup_session_key', sessionKey);
  }

  private isDynamics365Page(): boolean {
    return /\.crm\d*\.dynamics\.com$/i.test(window.location.hostname);
  }

  private injectScript(): void {
    // Wait for page to be fully loaded before injecting the script
    const injectWhenReady = () => {
      const script = document.createElement('script');
      script.id = 'levelup-extension-script';
      script.src = chrome.runtime.getURL('levelup-extension.js');
      script.async = true;
      script.defer = true;

      script.onload = () => {
        // eslint-disable-next-line no-console
        console.log('Level Up: Extension script loaded successfully');
        script.remove();
      };

      script.onerror = error => {
        // eslint-disable-next-line no-console
        console.error('Level Up: Failed to load extension script', error);
      };

      (document.head || document.documentElement).appendChild(script);
      this.injectedScript = script;
    };

    // Ensure DOM is ready before injecting
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', injectWhenReady, { once: true });
    } else {
      // If DOM is already ready, inject immediately
      injectWhenReady();
    }
  }

  private shouldRetryAfterReinject(response: DynamicsResponse): boolean {
    if (response.success || !response.error) {
      return false;
    }

    const normalizedError = response.error.toLowerCase();
    return (
      (normalizedError.indexOf('window.levelupextension') !== -1 &&
        normalizedError.indexOf('is not a function') !== -1) ||
      (normalizedError.indexOf('method') !== -1 &&
        normalizedError.indexOf('not found on target object') !== -1) ||
      normalizedError.indexOf('unknown action') !== -1
      // NOTE: plain timeouts ('no response from injected script') must NOT retry —
      // the action may have already executed (e.g. openFormEditor opened a tab)
      // and retrying would fire it a second time.
    );
  }

  private async forwardActionToInjectedScript(
    message: ActionMessage,
    timeoutMs: number = 8000
  ): Promise<DynamicsResponse> {
    return await new Promise<DynamicsResponse>(resolve => {
      const requestId = Date.now().toString();
      let pendingError: DynamicsResponse | null = null;
      let settleErrorTimer: number | null = null;

      const finish = (response: DynamicsResponse) => {
        window.clearTimeout(timeoutId);
        if (settleErrorTimer !== null) {
          window.clearTimeout(settleErrorTimer);
        }
        window.removeEventListener('message', responseListener);
        resolve(response);
      };

      const responseListener = (event: MessageEvent) => {
        if (event.source !== window) {
          return;
        }

        if (event.data.type === 'LEVELUP_RESPONSE' && event.data.requestId === requestId) {
          const response = event.data as DynamicsResponse;

          // In case multiple injected listeners respond, always prefer a successful response.
          if (response.success) {
            finish(response);
            return;
          }

          pendingError = response;
          if (settleErrorTimer !== null) {
            window.clearTimeout(settleErrorTimer);
          }

          const normalizedError = (response.error || '').toLowerCase();
          const settleDelayMs =
            normalizedError.indexOf('unknown action') !== -1 ||
            (normalizedError.indexOf('method') !== -1 &&
              normalizedError.indexOf('not found on target object') !== -1)
              ? 1200
              : 120;

          // Give parallel listeners a short chance to return success before failing.
          settleErrorTimer = window.setTimeout(() => {
            finish(pendingError || { success: false, error: 'Unknown injected script error' });
          }, settleDelayMs);
        }
      };

      const timeoutId = window.setTimeout(() => {
        finish(pendingError || { success: false, error: 'No response from injected script' });
      }, timeoutMs);

      window.addEventListener('message', responseListener);
      window.postMessage(
        {
          type: 'LEVELUP_REQUEST',
          action: message.action,
          data: message.data,
          requestId,
        },
        window.location.origin
      );
    });
  }

  private async wait(ms: number): Promise<void> {
    await new Promise(resolve => {
      window.setTimeout(resolve, ms);
    });
  }

  private setupMessageListener(): void {
    // Listen for messages from the extension - unified message handler
    chrome.runtime.onMessage.addListener(
      (
        message: ContentScriptMessage,
        sender: chrome.runtime.MessageSender,
        sendResponse: (response: ContentScriptResponse) => void
      ) => {
        // Guard against extension context invalidated (e.g. after reload)
        if (!chrome.runtime?.id) return false;
        const safeSend = (response: ContentScriptResponse) => {
          try {
            if (chrome.runtime?.id) sendResponse(response);
          } catch {
            // Extension context invalidated — nothing we can do
          }
        };
        // Unified message routing based on type
        const isAsync = this.routeMessage(message, safeSend);
        return isAsync; // Keep the message channel open for async responses
      }
    );

    // Listen for messages from the injected script
    window.addEventListener('message', event => {
      if (event.source !== window) {
        return;
      }

      if (event.data.type === 'LEVELUP_RESPONSE') {
        // Forward to background (best-effort). Background may be asleep in MV3 — suppress the rejection.
        chrome.runtime.sendMessage(event.data).catch(() => {});
      }
    });
  }

  private handleDynamicsAction(
    message: ActionMessage,
    sendResponse: (response: DynamicsResponse) => void
  ): void {
    // Prevent duplicate tab-opening actions within a short window.
    // Use 15 000 ms — longer than the 8 000 ms forwardActionToInjectedScript timeout —
    // so a timed-out first call cannot race with a user re-click before it finishes.
    if (TAB_OPENING_ACTIONS.has(message.action)) {
      const now = Date.now();
      const last = this.lastDispatchTime.get(message.action) ?? 0;
      if (now - last < 15_000) {
        sendResponse({ success: true, data: 'Duplicate action suppressed' });
        return;
      }
      this.lastDispatchTime.set(message.action, now);
    }

    void (async () => {
      let response = await this.forwardActionToInjectedScript(message);

      if (this.shouldRetryAfterReinject(response)) {
        // eslint-disable-next-line no-console
        console.warn(
          'Level Up: Retrying action after reinjecting page script',
          message.action,
          response.error
        );
        this.injectScript();

        const retryDelaysMs = [350, 900, 1600];
        for (let attempt = 0; attempt < retryDelaysMs.length; attempt++) {
          await this.wait(retryDelaysMs[attempt]);
          response = await this.forwardActionToInjectedScript(message, 3500);

          if (!this.shouldRetryAfterReinject(response)) {
            break;
          }
        }
      }

      // On success, clear the dedup timer so the action can be used again promptly.
      if (response.success && TAB_OPENING_ACTIONS.has(message.action)) {
        this.lastDispatchTime.delete(message.action);
      }

      sendResponse(response);
    })().catch(error => {
      if (TAB_OPENING_ACTIONS.has(message.action)) {
        this.lastDispatchTime.delete(message.action);
      }
      sendResponse({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    });
  }

  private routeMessage(
    message: ContentScriptMessage,
    sendResponse: (response: ContentScriptResponse) => void
  ): boolean {
    // Route message based on type
    switch (message.type) {
      case 'LEVELUP_REQUEST':
        this.handleDynamicsAction(message as ActionMessage, sendResponse);
        return true;

      case 'GET_ENTITY_METADATA_REQUEST':
        this.handleMetadataRequest(sendResponse);
        return true;

      case 'SEARCH_USERS_REQUEST':
        this.handleSearchUsers(message as UserSearchMessage, sendResponse);
        return true;

      case 'SET_SESSION_KEY': {
        const sessionKey = (message as SessionMessage).sessionKey;
        if (sessionKey) {
          this.saveSessionKey(sessionKey);
        }
        sendResponse({ success: true });
        return false;
      }

      case 'GET_SESSION_KEY':
        sendResponse({ success: true, sessionKey: this.sessionKey || undefined });
        return false;

      case 'CLEAR_SESSION_KEY':
        this.sessionKey = null;
        sessionStorage.removeItem('levelup_session_key');
        sendResponse({ success: true });
        return false;

      case 'GET_PAGE_CONTEXT':
        this.handleGetPageContext(sendResponse).catch(() => {
          sendResponse({ success: false, pageContext: null });
        });
        return true;

      case 'GET_DATAVERSE_URL_FROM_PAGE': {
        const getMsg = message as GetDataverseUrlMessage;
        this.fetchDataverseUrlForEnvironment(getMsg.envId)
          .then(url => {
            sendResponse({ success: true, data: url });
          })
          .catch(() => {
            sendResponse({ success: true, data: null });
          });
        return true;
      }

      case 'OPEN_REPORT_FORM':
        this.openReportOverlay();
        sendResponse({ success: true });
        return false;

      default:
        return false;
    }
  }

  private openReportOverlay(): void {
    const OVERLAY_ID = 'levelup-report-overlay';
    if (document.getElementById(OVERLAY_ID)) return;

    // Fetch console logs from injected script first
    const requestId = `rp_${Date.now()}`;
    let consoleLogs: Array<{ level: string; message: string; timestamp: string }> = [];

    const buildOverlay = () => {
      const overlay = document.createElement('div');
      overlay.id = OVERLAY_ID;
      overlay.style.cssText = [
        'position:fixed',
        'inset:0',
        'z-index:2147483647',
        'background:rgba(0,0,0,0.55)',
        'display:flex',
        'align-items:center',
        'justify-content:center',
        'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
      ].join(';');

      const isDark = window.matchMedia?.('(prefers-color-scheme:dark)').matches;
      const bg = isDark ? '#1e1e2e' : '#ffffff';
      const fg = isDark ? '#cdd6f4' : '#1a1a2e';
      const border = isDark ? '#45475a' : '#e0e0e0';
      const inputBg = isDark ? '#313244' : '#f8f8ff';

      const logLines = consoleLogs.length
        ? consoleLogs
            .map(
              e =>
                `<span style="opacity:.6;font-size:11px">[${e.timestamp.substring(11, 23)}]</span> ` +
                `<b style="color:${e.level === 'error' ? '#f38ba8' : e.level === 'warn' ? '#fab387' : '#89dceb'}">${e.level.toUpperCase()}</b> ` +
                `${e.message.replace(/</g, '&lt;')}`
            )
            .join('\n')
        : 'No console entries captured.';

      overlay.innerHTML = `
        <div style="background:${bg};color:${fg};border-radius:10px;box-shadow:0 8px 40px rgba(0,0,0,.4);
          width:min(660px,94vw);max-height:90vh;display:flex;flex-direction:column;overflow:hidden">
          <div style="padding:20px 24px 12px;border-bottom:1px solid ${border};display:flex;align-items:center;gap:10px">
            <span style="font-size:22px">⚠️</span>
            <span style="font-size:18px;font-weight:700">Report a Problem</span>
            <button id="lup-rp-close" style="margin-left:auto;background:none;border:none;cursor:pointer;
              font-size:20px;color:${fg};opacity:.6;padding:2px 6px;border-radius:4px">&times;</button>
          </div>
          <div style="padding:16px 24px;overflow-y:auto;flex:1;display:flex;flex-direction:column;gap:14px">
            <div>
              <label style="font-size:12px;font-weight:600;opacity:.7;display:block;margin-bottom:4px">Page URL</label>
              <textarea id="lup-rp-url" rows="2" style="width:100%;box-sizing:border-box;padding:8px 10px;
                border:1px solid ${border};border-radius:6px;background:${inputBg};color:${fg};
                font-size:13px;font-family:inherit;resize:vertical">${window.location.href}</textarea>
            </div>
            <div>
              <label style="font-size:12px;font-weight:600;opacity:.7;display:block;margin-bottom:4px">Description *</label>
              <textarea id="lup-rp-desc" rows="6" placeholder="Describe the problem you encountered…"
                style="width:100%;box-sizing:border-box;padding:8px 10px;
                border:1px solid ${border};border-radius:6px;background:${inputBg};color:${fg};
                font-size:13px;font-family:inherit;resize:vertical"></textarea>
            </div>
            <details style="border:1px solid ${border};border-radius:6px;overflow:hidden">
              <summary style="padding:10px 14px;cursor:pointer;font-size:13px;font-weight:600;
                background:${inputBg};user-select:none">
                Console Log (${consoleLogs.length})
              </summary>
              <pre style="margin:0;padding:12px 14px;font-size:11px;font-family:monospace;
                overflow-y:auto;max-height:180px;white-space:pre-wrap;word-break:break-all;
                background:${inputBg}">${logLines}</pre>
            </details>
            <div id="lup-rp-status" style="display:none;padding:10px 12px;border-radius:6px;font-size:13px"></div>
          </div>
          <div style="padding:12px 24px 20px;border-top:1px solid ${border};display:flex;justify-content:flex-end;gap:10px">
            <button id="lup-rp-cancel" style="padding:8px 20px;border:1px solid ${border};border-radius:6px;
              background:none;color:${fg};cursor:pointer;font-size:14px">Cancel</button>
            <button id="lup-rp-submit" style="padding:8px 20px;border:none;border-radius:6px;
              background:#f59e0b;color:#1a1a1a;cursor:pointer;font-size:14px;font-weight:600">Submit Case</button>
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

      submitBtn.addEventListener('click', () => {
        const desc = (overlay.querySelector('#lup-rp-desc') as HTMLTextAreaElement).value.trim();
        const url = (overlay.querySelector('#lup-rp-url') as HTMLTextAreaElement).value.trim();
        if (!desc) {
          (overlay.querySelector('#lup-rp-desc') as HTMLElement).style.borderColor = '#f38ba8';
          return;
        }
        submitBtn.disabled = true;
        submitBtn.textContent = 'Creating Case…';

        window.postMessage(
          {
            type: 'LEVELUP_REQUEST',
            action: 'navigation:report-problem',
            data: { description: desc, url, consoleLogs },
            requestId: `rp_submit_${Date.now()}`,
          },
          window.location.origin
        );

        const respListener = (ev: MessageEvent) => {
          if (ev.source !== window) return;
          if (ev.data?.type !== 'LEVELUP_RESPONSE' || !ev.data?.requestId?.startsWith('rp_submit_'))
            return;
          window.removeEventListener('message', respListener);

          const statusOk = isDark ? '#a6e3a1' : '#166534';
          const statusErr = isDark ? '#f38ba8' : '#991b1b';
          const statusBgOk = isDark ? '#1e3a2f' : '#f0fdf4';
          const statusBgErr = isDark ? '#3a1e1e' : '#fef2f2';

          if (ev.data.success) {
            statusDiv.style.cssText = `display:block;padding:10px 12px;border-radius:6px;font-size:13px;background:${statusBgOk};color:${statusOk}`;
            statusDiv.textContent = 'Support case created successfully.';
            const caseUrl = ev.data.data as string;
            if (caseUrl?.startsWith('http')) {
              window.open(caseUrl, '_blank');
            }
            window.setTimeout(close, 1500);
          } else {
            statusDiv.style.cssText = `display:block;padding:10px 12px;border-radius:6px;font-size:13px;background:${statusBgErr};color:${statusErr}`;
            statusDiv.textContent = `Error: ${ev.data.error ?? 'Failed to create case'}`;
            submitBtn.disabled = false;
            submitBtn.textContent = 'Submit Case';
          }
        };
        window.addEventListener('message', respListener);
      });

      document.body.appendChild(overlay);
      window.setTimeout(() => (overlay.querySelector('#lup-rp-desc') as HTMLElement)?.focus(), 50);
    };

    // Get console logs then build the overlay
    const logListener = (ev: MessageEvent) => {
      if (ev.source !== window) return;
      if (ev.data?.type === 'LEVELUP_RESPONSE' && ev.data?.requestId === requestId) {
        window.removeEventListener('message', logListener);
        if (ev.data.success && Array.isArray(ev.data.data)) {
          consoleLogs = ev.data.data;
        }
        buildOverlay();
      }
    };
    window.addEventListener('message', logListener);
    window.postMessage(
      {
        type: 'LEVELUP_REQUEST',
        action: 'navigation:get-console-logs',
        requestId,
      },
      window.location.origin
    );
    // Fallback: build overlay after 1.5s even if logs don't arrive
    window.setTimeout(() => {
      window.removeEventListener('message', logListener);
      if (!document.getElementById(OVERLAY_ID)) buildOverlay();
    }, 1500);
  }

  private handleMetadataRequest(sendResponse: (response: ContentScriptResponse) => void): void {
    // Forward the request to the injected script to get entities from Dynamics 365
    const requestId = Date.now().toString();
    window.postMessage(
      {
        type: 'GET_ENTITY_METADATA_REQUEST',
        requestId: requestId,
      },
      window.location.origin
    );

    console.log(
      'Content script: Posted GET_ENTITY_METADATA_REQUEST to injected script with requestId:',
      requestId
    );

    // Set up a one-time listener for the response
    const responseListener = (event: MessageEvent) => {
      if (event.source !== window) {
        return;
      }

      console.log('Content script: Received message from injected script:', event.data);

      if (
        event.data.type === 'GET_ENTITY_METADATA_RESPONSE' &&
        event.data.requestId === requestId
      ) {
        console.log(
          'Content script: Matched GET_ENTITY_METADATA_RESPONSE, sending back to background'
        );
        window.removeEventListener('message', responseListener);
        sendResponse(event.data);
      }
    };

    window.addEventListener('message', responseListener);
  }

  private handleSearchUsers(
    message: UserSearchMessage,
    sendResponse: (response: ContentScriptResponse) => void
  ): void {
    // Starting SEARCH_USERS_REQUEST handling

    // Forward the request to the injected script to search users in Dynamics 365
    const requestId = Date.now().toString();
    window.postMessage(
      {
        type: 'LEVELUP_REQUEST',
        action: 'admin:search-users',
        data: { query: message.query },
        requestId: requestId,
      },
      window.location.origin
    );

    console.log(
      'Content script: Posted SEARCH_USERS_REQUEST to injected script with requestId:',
      requestId
    );

    // Set up a one-time listener for the response
    const responseListener = (event: MessageEvent) => {
      if (event.source !== window) {
        return;
      }

      console.log('Content script: Received message from injected script:', event.data);

      if (event.data.type === 'LEVELUP_RESPONSE' && event.data.requestId === requestId) {
        console.log('Content script: Matched SEARCH_USERS_RESPONSE, sending back to background');
        window.removeEventListener('message', responseListener);
        sendResponse(event.data);
      }
    };

    window.addEventListener('message', responseListener);
  }

  /**
   * Detects the Dynamics "session about to expire" warning dialog and reloads
   * the page to perform a clean re-auth instead of letting Dynamics navigate to
   * the Azure AD logout URL.
   *
   * Dynamics renders this dialog via React so the container node is added first
   * and text is populated in a subsequent render pass. We therefore scan the
   * full document on every mutation rather than only inspecting the added node,
   * and we also observe characterData changes so a text-only update triggers a
   * scan too.
   */
  private setupSignInDialogDetector(): void {
    const SESSION_EXPIRY_PHRASES = ['session is about to expire', 'sign in again'];
    let triggered = false;

    const scanDocument = (): void => {
      if (triggered) return;
      const bodyText = (document.body?.textContent ?? '').toLowerCase();
      if (SESSION_EXPIRY_PHRASES.some(phrase => bodyText.includes(phrase))) {
        triggered = true;
        // eslint-disable-next-line no-console
        console.log(
          'Level Up: Detected Dynamics session expiry dialog — reloading for clean re-auth'
        );
        window.location.reload();
      }
    };

    const observer = new MutationObserver(() => {
      scanDocument();
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  }

  private setupColumnPickerFilter(): void {
    const STORAGE_KEY = 'levelup_extension_config';
    let hideEnabled = true;

    /** Returns the display label for a .ms-List-cell, regardless of tab (Opportunity or Related). */
    const getCellLabel = (cell: Element): string => {
      // Opportunity tab: label.ms-Label
      const msLabel = cell.querySelector('label.ms-Label');
      if (msLabel) return (msLabel.textContent ?? '').trim();
      // Related tab: [role="treeitem"] carries the label in its title / aria-label
      const treeItem = cell.querySelector('[role="treeitem"]');
      if (treeItem)
        return (treeItem.getAttribute('title') ?? treeItem.getAttribute('aria-label') ?? '').trim();
      return '';
    };

    const isZzCell = (cell: Element): boolean => /^zz/i.test(getCellLabel(cell));

    /** Returns the visible label text of a filter dropdown option, stripping leading icon glyphs. */
    const getOptionLabel = (el: Element): string => {
      // Prefer a dedicated label span (Fluent Dropdown / ComboBox option text)
      const labelSpan = el.querySelector(
        '[class*="optionText"], [class*="itemText"], [class*="OptionText"], [class*="ItemText"], span'
      );
      const raw = labelSpan ? (labelSpan.textContent ?? '') : (el.textContent ?? '');
      // Strip any leading non-letter characters (icon glyphs, whitespace, etc.)
      return raw.trim().replace(/^[^a-zA-Z]+/, '');
    };

    /** Returns whether a filter dropdown option element has a zz-prefixed label. */
    const isZzOption = (el: Element): boolean => /^zz/i.test(getOptionLabel(el));

    /** Selector covering all Fluent option elements used by Dynamics filter dropdowns. */
    const OPTION_SELECTOR = '[role="option"], [role="menuitemcheckbox"], [role="menuitem"]';

    const applyVisibility = (enabled: boolean) => {
      document.querySelectorAll('.ms-List-cell').forEach(cell => {
        if (isZzCell(cell)) {
          (cell as HTMLElement).style.display = enabled ? 'none' : '';
        }
      });
      document.querySelectorAll(OPTION_SELECTOR).forEach(option => {
        if (isZzOption(option)) {
          (option as HTMLElement).style.display = enabled ? 'none' : '';
        }
      });
    };

    const hideZzCells = (root: Document | Element) => {
      if (!hideEnabled) return;
      root.querySelectorAll('.ms-List-cell').forEach(cell => {
        if (isZzCell(cell)) {
          (cell as HTMLElement).style.display = 'none';
        }
      });
      root.querySelectorAll(OPTION_SELECTOR).forEach(option => {
        if (isZzOption(option)) {
          (option as HTMLElement).style.display = 'none';
        }
      });
    };

    // Read initial config
    chrome.storage.local.get([STORAGE_KEY], result => {
      const config = result[STORAGE_KEY] as { hideDeprecatedColumns?: boolean } | undefined;
      hideEnabled = config?.hideDeprecatedColumns !== false;
      applyVisibility(hideEnabled);
    });

    // React to config changes (e.g. toggle in popup)
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes[STORAGE_KEY]) {
        const newConfig = changes[STORAGE_KEY].newValue as
          | { hideDeprecatedColumns?: boolean }
          | undefined;
        hideEnabled = newConfig?.hideDeprecatedColumns !== false;
        applyVisibility(hideEnabled);
      }
    });

    const observer = new MutationObserver(mutations => {
      for (const mutation of mutations) {
        if (mutation.type === 'childList') {
          for (const node of mutation.addedNodes) {
            if (node.nodeType === Node.ELEMENT_NODE) {
              const el = node as Element;
              if (el.classList?.contains('ms-List-cell')) {
                if (hideEnabled && isZzCell(el)) {
                  (el as HTMLElement).style.display = 'none';
                }
              } else if (el.getAttribute?.('role') === 'option') {
                if (hideEnabled && isZzOption(el)) {
                  (el as HTMLElement).style.display = 'none';
                }
              } else if (
                el.getAttribute?.('role') === 'menuitemcheckbox' ||
                el.getAttribute?.('role') === 'menuitem'
              ) {
                if (hideEnabled && isZzOption(el)) {
                  (el as HTMLElement).style.display = 'none';
                }
              } else if (el.querySelector?.('.ms-List-cell, [role="option"]')) {
                hideZzCells(el);
              }
            }
          }
        }
      }
    });

    observer.observe(document.body, { childList: true, subtree: true });
  }

  /**
   * Fetches the Dataverse instance URL for the given Power Platform environment
   * by calling the make.powerapps.com internal API (same-origin, uses the page's
   * existing auth session — no extra tokens or storage scanning needed).
   * Returns the org URL (without trailing slash) or null if unavailable.
   */
  private async fetchDataverseUrlForEnvironment(envId: string | undefined): Promise<string | null> {
    if (!envId) return null;
    const normalized = envId.replace(/[{}]/g, '').toLowerCase();
    const crmPattern = /^https:\/\/[a-z0-9][a-z0-9-]*\.crm\d*\.dynamics\.com/i;

    // Try the known make.powerapps.com internal environment API paths.
    // The proxy forwards to BAP API using the page's existing auth session.
    const paths = [
      `/api/v1/environments/${normalized}`,
      `/providers/Microsoft.BusinessAppPlatform/environments/${normalized}?api-version=2019-05-01`,
    ];

    for (const path of paths) {
      try {
        const response = await fetch(path, {
          credentials: 'include',
          headers: { Accept: 'application/json' },
        });
        if (!response.ok) continue;
        const data = await response.json();

        // Try all known field paths for the Dataverse instance URL
        const candidate: string | undefined =
          data?.properties?.linkedEnvironmentMetadata?.instanceApiUrl ??
          data?.properties?.linkedEnvironmentMetadata?.instanceUrl ??
          data?.properties?.linkedEnvironmentMetadata?.webapiUrl ??
          data?.instanceApiUrl ??
          data?.instanceUrl;

        if (!candidate) continue;
        const clean = candidate.replace(/\/$/, '');

        // Validate it looks like a Dataverse org URL
        if (!crmPattern.test(clean)) continue;

        return clean.toLowerCase();
      } catch {
        continue;
      }
    }
    return null;
  }

  private async handleGetPageContext(
    sendResponse: (response: ContentScriptResponse) => void
  ): Promise<void> {
    const isDynamicsPage = this.isDynamics365Page();
    if (!isDynamicsPage) {
      sendResponse({ success: false, pageContext: null });
      return;
    }

    // Quick check if Xrm is already available
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const win = window as any;
      if (win.Xrm?.Utility?.getGlobalContext && win.Xrm?.Utility?.getPageContext) {
        try {
          const pageContext = win.Xrm.Utility.getPageContext().input;
          sendResponse({ success: true, pageContext: pageContext || null });
          return;
        } catch (error) {
          // Xrm is loaded but can't get page context
          sendResponse({ success: true, pageContext: null });
          return;
        }
      }
    } catch (error) {
      // Continue with timeout approach
    }

    // If Xrm isn't immediately available, wait with a shorter timeout
    const waitForXrmWithTimeout = (timeout: number = 1000): Promise<boolean> => {
      return new Promise(resolve => {
        const startTime = Date.now();
        const checkXrm = () => {
          try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const win = window as any;
            if (win.Xrm?.Utility?.getGlobalContext && win.Xrm?.Utility?.getPageContext) {
              resolve(true);
              return;
            }
          } catch (error) {
            // Continue checking
          }

          if (Date.now() - startTime > timeout) {
            resolve(false);
            return;
          }

          setTimeout(checkXrm, 50); // Check more frequently
        };
        checkXrm();
      });
    };

    try {
      const xrmReady = await waitForXrmWithTimeout();
      if (xrmReady) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const win = window as any;
        try {
          const pageContext = win.Xrm.Utility.getPageContext().input;
          sendResponse({ success: true, pageContext: pageContext || null });
        } catch (error) {
          // Xrm is loaded but can't get page context
          sendResponse({ success: true, pageContext: null });
        }
      } else {
        // Xrm didn't load within timeout - still a Dynamics page but context not available
        sendResponse({ success: true, pageContext: null });
      }
    } catch (error) {
      sendResponse({ success: true, pageContext: null });
    }
  }
}

// Prevent multiple instantiations
if (!window.__levelUpContentScriptLoaded) {
  window.__levelUpContentScriptLoaded = true;

  // Initialize the content script
  new ContentScript();
}
