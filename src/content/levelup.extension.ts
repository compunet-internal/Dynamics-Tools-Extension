/// <reference types="xrm" />

declare global {
  interface Window {
    levelUpExtension: LevelUpExtension;
    __levelUpRuntimeVersion?: number;
  }
}

interface Solution {
  uniquename: string;
  friendlyname: string;
  solutionid: string;
  version: string;
  ismanaged: boolean;
  isvisible?: boolean;
}

interface StoredSolutionOverride {
  solutionId: string;
}

interface CurrentSolutionInfo {
  solutionId: string;
  friendlyname: string;
  uniquename: string;
  source: 'preferred' | 'default';
}

import {
  FormActionName,
  EntityMetadata,
  EntityMetadataCache,
  ActionMessage,
  DynamicsAction,
  AdminActionName,
  DebuggingActionName,
  NavigationActionName,
} from '#types/global';
import { CustomCommand } from '#types/custom-commands';
import { FormActions } from './modules/form-actions';
import { NavigationActions } from './modules/navigation-actions';
import { AdminActions } from './modules/admin-actions';
import { DebuggingActions } from './modules/debugging-actions';
import { CustomCommandsExecutor } from './modules/custom-commands';
import { WebApiClient } from './modules/webapi-client';
import { DynamicsUtils } from './modules/utils';

/**
 * Configuration for action method mapping
 */
interface ActionMethodConfig {
  actionName: string;
  method: string;
  dataTransformer?: (data: unknown) => unknown;
}

export class LevelUpExtension {
  private readonly CACHE_DURATION_MS = 5 * 60 * 1000; // 5 minutes
  private readonly SOLUTIONS_CACHE_DURATION_MS = 60 * 60 * 1000; // 1 hour
  private readonly MAX_CONSOLE_ENTRIES = 50;
  private readonly runtimeVersion: number;
  private cacheKey: string = 'levelup_entity_metadata_cache'; // Default, will be updated in init
  private solutionsCacheKey: string = 'levelup_solutions_cache'; // Default, will be updated in init
  private formActions: FormActions;
  private debuggingActions: DebuggingActions;
  private consoleLogBuffer: Array<{ level: string; message: string; timestamp: string }> = [];

  constructor() {
    this.runtimeVersion = (window.__levelUpRuntimeVersion || 0) + 1;
    window.__levelUpRuntimeVersion = this.runtimeVersion;
    this.formActions = new FormActions(this);
    this.debuggingActions = new DebuggingActions();
    this.setupConsoleCapture();
    this.init();
  }

  /**
   * Intercept console methods to capture a rolling buffer of recent log entries.
   * Captured logs are included when the user reports a problem.
   */
  private setupConsoleCapture(): void {
    const self = this;
    const levels = ['log', 'warn', 'error', 'info'] as const;
    for (const level of levels) {
      const original = console[level].bind(console);
      (console as Record<string, unknown>)[level] = (...args: unknown[]) => {
        original(...args);
        const message = args
          .map(a => {
            try {
              return typeof a === 'object' ? JSON.stringify(a) : String(a);
            } catch {
              return String(a);
            }
          })
          .join(' ')
          .substring(0, 500);
        self.consoleLogBuffer.push({ level, message, timestamp: new Date().toISOString() });
        if (self.consoleLogBuffer.length > self.MAX_CONSOLE_ENTRIES) {
          self.consoleLogBuffer.shift();
        }
      };
    }
  }

  /**
   * Return a snapshot of recent console log entries.
   */
  getConsoleLogs(): Array<{ level: string; message: string; timestamp: string }> {
    return [...this.consoleLogBuffer];
  }

  /**
   * Action method mappings for different action groups
   */
  private getFormActionMappings(): ActionMethodConfig[] {
    return [
      { actionName: 'show-logical-names', method: 'showLogicalNames' },
      { actionName: 'clear-logical-names', method: 'clearLogicalNames' },
      { actionName: 'god-mode', method: 'enableGodMode' },
      { actionName: 'changed-fields', method: 'highlightChangedFields' },
      { actionName: 'record-url', method: 'getRecordUrl' },
      { actionName: 'record-id', method: 'getRecordId' },
      { actionName: 'open-web-api', method: 'openWebApiRecord' },
      { actionName: 'refresh-subgrids', method: 'refreshAllSubgrids' },
      { actionName: 'show-optionset-values', method: 'showOptionSetValues' },
      { actionName: 'clone-record', method: 'cloneRecord' },
      { actionName: 'refresh-autosave-off', method: 'refreshWithoutSave' },
      { actionName: 'all-fields', method: 'showAllFields' },
      { actionName: 'open-editor', method: 'openFormEditor' },
      { actionName: 'open-table-editor', method: 'openTableEditor' },
      { actionName: 'table-processes', method: 'showTableProcesses' },
    ];
  }

  private getNavigationActionMappings(): ActionMethodConfig[] {
    return [
      {
        actionName: 'open-record-by-id',
        method: 'openRecordById',
        dataTransformer: data => data as { entityName: string; recordId: string },
      },
      {
        actionName: 'new-record',
        method: 'createNewRecord',
        dataTransformer: data => data as { entityName: string },
      },
      {
        actionName: 'open-list',
        method: 'openEntityList',
        dataTransformer: data => data as { entityName: string },
      },
      { actionName: 'open-security', method: 'openSecurity' },
      { actionName: 'open-system-jobs', method: 'openSystemJobs' },
      { actionName: 'open-solutions', method: 'openSolutions' },
      { actionName: 'select-default-solution', method: 'selectDefaultSolution' },
      { actionName: 'get-current-solution', method: 'getCurrentSolutionInfo' },
      { actionName: 'list-solutions', method: 'listSolutionsForPicker' },
      { actionName: 'get-solution-state', method: 'getCombinedSolutionState' },
      { actionName: 'refresh-solutions', method: 'refreshSolutionsForPicker' },
      {
        actionName: 'set-preferred-solution',
        method: 'setPreferredSolution',
        dataTransformer: data => data as { solutionId: string },
      },
      { actionName: 'open-processes', method: 'openProcesses' },
      { actionName: 'open-mailboxes', method: 'openMailboxes' },
      { actionName: 'open-main', method: 'openMain' },
      { actionName: 'open-advanced-find', method: 'openAdvancedFind' },
      { actionName: 'open-mobile-client', method: 'openMobileClient' },
      { actionName: 'open-power-platform-admin', method: 'openPowerPlatformAdmin' },
      { actionName: 'open-solutions-history', method: 'openSolutionsHistory' },
      { actionName: 'pin-to-side-panel', method: 'pinToSidePanel' },
      {
        actionName: 'report-problem',
        method: 'reportProblem',
        dataTransformer: data =>
          data as {
            description: string;
            url: string;
            consoleLogs: Array<{ level: string; message: string; timestamp: string }>;
          },
      },
    ];
  }

  private getAdminActionMappings(): ActionMethodConfig[] {
    return [
      { actionName: 'get-user-info', method: 'getCurrentUserInfo' },
      { actionName: 'get-organization-settings', method: 'getOrganizationSettings' },
      { actionName: 'get-client-info', method: 'getClientInfo' },
    ];
  }

  private getDebuggingActionMappings(): ActionMethodConfig[] {
    return [
      { actionName: 'forms-monitor', method: 'enableFormsMonitor' },
      { actionName: 'ribbon-debugger', method: 'enableRibbonDebugger' },
      { actionName: 'perf-center', method: 'enablePerfCenter' },
      { actionName: 'disable-form-handlers', method: 'disableFormHandlers' },
      { actionName: 'disable-business-rules', method: 'disableBusinessRules' },
      { actionName: 'disable-form-libraries', method: 'disableFormLibraries' },
      { actionName: 'enable-dark-mode', method: 'enableDarkMode' },
      { actionName: 'clear-flags', method: 'clearFlags' },
    ];
  }

  private init(): void {
    // Wait for Xrm to be available
    this.waitForXrm().then(async () => {
      // Set environment-specific cache key
      this.initializeCacheKey();

      this.setupMessageListener();

      // Proactively populate entity metadata cache on first load
      try {
        const cached = this.getCachedEntityMetadata();
        if (!cached) {
          // eslint-disable-next-line no-console
          console.log(
            'CompuNet Dynamics Tools: No cached entity metadata found, populating cache...'
          );
          await this.getEntityMetadata();
        } else {
          // eslint-disable-next-line no-console
          console.log('CompuNet Dynamics Tools: Using existing cached entity metadata');
        }
      } catch (error) {
        // eslint-disable-next-line no-console
        console.warn(
          'CompuNet Dynamics Tools: Failed to populate entity metadata cache on init:',
          error
        );
      }

      // Proactively populate solutions cache on first load
      if (!this.getCachedSolutionState()) {
        this.refreshSolutionsForPicker().catch(() => {
          /* non-critical */
        });
      }

      // eslint-disable-next-line no-console
      console.log('CompuNet Dynamics Tools: Dynamics 365 Client API integration ready');
    });
  }

  /**
   * Initialize cache key based on the current Dynamics 365 environment URL
   */
  private initializeCacheKey(): void {
    try {
      const globalContext = Xrm.Utility.getGlobalContext();
      const clientUrl = globalContext.getClientUrl();

      // Create a clean cache key from the environment URL
      const url = new URL(clientUrl);
      const hostname = url.hostname.toLowerCase();

      // Use hostname as part of cache key for environment isolation
      this.cacheKey = `levelup_entity_metadata_${hostname}`;
      this.solutionsCacheKey = `levelup_solutions_${hostname}`;

      console.log(`CompuNet Dynamics Tools: Cache key set for environment: ${hostname}`);

      // Store clientUrl keyed by bapEnvironmentId so make.powerapps.com can call the API directly
      try {
        const bapEnvId = globalContext.organizationSettings?.bapEnvironmentId;
        if (bapEnvId) {
          const normalized = bapEnvId.replace(/[{}]/g, '').toLowerCase();
          chrome.storage.local.set({ [`levelup_env_client_url_${normalized}`]: clientUrl });
        }
      } catch {
        // Non-critical — ignore
      }
    } catch (error) {
      console.warn(
        'CompuNet Dynamics Tools: Failed to get environment URL, using default cache key:',
        error
      );
      this.cacheKey = 'levelup_entity_metadata_cache';
    }
  }

  private waitForXrm(): Promise<void> {
    return new Promise(resolve => {
      const checkXrm = () => {
        try {
          if (
            typeof Xrm !== 'undefined' &&
            Xrm.Utility &&
            typeof Xrm.Utility.getGlobalContext === 'function'
          ) {
            // Test if we can actually call the function
            Xrm.Utility.getGlobalContext();
            resolve();
          } else {
            setTimeout(checkXrm, 100);
          }
        } catch (error) {
          setTimeout(checkXrm, 100);
        }
      };
      checkXrm();
    });
  }

  private isValidActionMessage(data: unknown): data is ActionMessage {
    if (!data || typeof data !== 'object') {
      return false;
    }

    const obj = data as Record<string, unknown>;
    return (
      obj.type === 'LEVELUP_REQUEST' &&
      typeof obj.action === 'string' &&
      typeof obj.requestId === 'string'
    );
  }

  private setupMessageListener(): void {
    window.addEventListener('message', async event => {
      if (event.source !== window) {
        return;
      }

      // Ignore requests on stale script instances after reinjection.
      if (window.__levelUpRuntimeVersion !== this.runtimeVersion) {
        return;
      }

      if (this.isValidActionMessage(event.data)) {
        await this.handleAction(event.data);
      } else if (
        event.data &&
        event.data.type === 'GET_ENTITY_METADATA_REQUEST' &&
        event.data.requestId
      ) {
        await this.handleGetEntities(event.data.requestId);
      } else if (
        event.data &&
        event.data.type === 'GET_PAGE_CONTEXT_REQUEST' &&
        event.data.requestId
      ) {
        this.handleGetPageContext(event.data.requestId);
      }
    });
  }

  /**
   * Get cached entity metadata from localStorage
   */
  private getCachedEntityMetadata(): EntityMetadataCache | null {
    try {
      const cached = localStorage.getItem(this.cacheKey);
      if (!cached) {
        return null;
      }

      const parsed = JSON.parse(cached) as EntityMetadataCache;
      if (parsed && parsed.entities && parsed.timestamp) {
        return parsed;
      }
    } catch (error) {
      console.warn('CompuNet Dynamics Tools: Failed to parse cached entity metadata:', error);
      localStorage.removeItem(this.cacheKey);
    }
    return null;
  }

  /**
   * Save entity metadata to localStorage
   */
  private setCachedEntityMetadata(entities: EntityMetadata[]): void {
    try {
      const cacheData: EntityMetadataCache = {
        entities: entities,
        timestamp: Date.now(),
      };
      localStorage.setItem(this.cacheKey, JSON.stringify(cacheData));
    } catch (error) {
      console.warn('CompuNet Dynamics Tools: Failed to cache entity metadata:', error);
    }
  }

  private async handleGetEntities(requestId: string): Promise<void> {
    try {
      // Use the Dynamics 365 Web API to get entity metadata
      const entities = await this.getEntityMetadata();

      // Send response back to content script
      window.postMessage(
        {
          type: 'GET_ENTITY_METADATA_RESPONSE',
          requestId: requestId,
          success: true,
          entities: entities,
        },
        window.location.origin
      );
    } catch (error) {
      console.error('Failed to get entities');
    }
  }

  private async getEntityMetadata(): Promise<EntityMetadata[] | undefined> {
    try {
      // Check if we have cached data that's still valid
      const cached = this.getCachedEntityMetadata();
      const now = Date.now();

      if (cached && now - cached.timestamp < this.CACHE_DURATION_MS) {
        console.log('CompuNet Dynamics Tools: Using cached entity metadata from localStorage');
        return cached.entities;
      }

      console.log('CompuNet Dynamics Tools: Fetching fresh entity metadata from API');

      // Use the existing WebApiClient to get entity metadata
      const webApiClient = WebApiClient.getInstance();

      // Make a Web API request to get entity metadata using the WebApiClient
      const response = (await webApiClient.retrieveMultiple('EntityDefinitions', {
        select: [
          'LogicalName',
          'DisplayName',
          'LogicalCollectionName',
          'IconSmallName',
          'IconMediumName',
          'IconLargeName',
          'ObjectTypeCode',
        ],
        filter: 'IsValidForAdvancedFind eq true',
      })) as { value: EntityMetadata[] };

      const entities = response.value || [];

      // Cache the results in localStorage
      this.setCachedEntityMetadata(entities);

      console.log(`CompuNet Dynamics Tools: Cached ${entities.length} entities in localStorage`);
      return entities;
    } catch (error) {
      console.error('Error fetching entity metadata:', error);

      // If we have cached data, return it even if it's expired
      const cached = this.getCachedEntityMetadata();
      if (cached) {
        console.log(
          'CompuNet Dynamics Tools: API failed, using expired cached entity metadata from localStorage'
        );
        return cached.entities;
      }
    }
  }

  private async handleAction(message: ActionMessage): Promise<void> {
    const { action, data, requestId } = message;

    try {
      let result: unknown = null;

      // Parse action into group and actionName (format: "group:actionName")
      const [group, actionName] = action.split(':', 2) as [string, DynamicsAction];

      switch (group) {
        case 'form':
          result = await this.handleFormAction(actionName as FormActionName, data);
          break;
        case 'navigation':
          result = await this.handleNavigationAction(actionName as NavigationActionName, data);
          break;
        case 'admin':
          result = await this.handleAdminAction(actionName as AdminActionName, data);
          break;
        case 'debugging':
          result = await this.handleDebuggingAction(actionName as DebuggingActionName, data);
          break;
        case 'custom':
          result = await this.handleCustomCommandAction(actionName, data);
          break;
      }

      // Check if result has error information (for form actions context errors)
      if (
        result &&
        typeof result === 'object' &&
        'error' in result &&
        'success' in result &&
        !(result as { success: boolean }).success
      ) {
        this.sendResponse(requestId, result);
      } else {
        this.sendResponse(requestId, { success: true, data: result });
      }
    } catch (error) {
      this.sendResponse(requestId, {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * Generic method executor for action mappings
   */
  private async executeActionMethod(
    target: unknown,
    mappings: ActionMethodConfig[],
    actionName: string,
    data: unknown
  ): Promise<unknown> {
    const config = mappings.find(m => m.actionName === actionName);
    if (!config) {
      throw new Error(`Unknown action: ${actionName}`);
    }

    const method = (target as Record<string, Function>)[config.method];
    if (typeof method !== 'function') {
      throw new Error(`Method ${config.method} not found on target object`);
    }

    const transformedData = config.dataTransformer ? config.dataTransformer(data) : undefined;
    return await method.call(target, transformedData);
  }

  private async handleFormAction(actionName: FormActionName, data: unknown): Promise<unknown> {
    const isFormCtx = DynamicsUtils.isFormContext();
    const isListCtx = DynamicsUtils.isListContext();

    // Some actions only need an entity name and work fine from list views too
    const listCompatibleActions: string[] = ['open-table-editor', 'table-processes'];

    if (isFormCtx || (isListCtx && listCompatibleActions.includes(actionName as string))) {
      return this.executeActionMethod(
        this.formActions,
        this.getFormActionMappings(),
        actionName,
        data
      );
    } else {
      return {
        error:
          'Form actions can only be used in the context of a form. You are currently on a different page type.',
        success: false,
      };
    }
  }

  private async handleNavigationAction(
    actionName: NavigationActionName,
    data: unknown
  ): Promise<unknown> {
    if (actionName === 'get-console-logs') {
      return this.getConsoleLogs();
    }
    return this.executeActionMethod(
      NavigationActions,
      this.getNavigationActionMappings(),
      actionName,
      data
    );
  }

  private async handleDebuggingAction(
    actionName: DebuggingActionName,
    data: unknown
  ): Promise<unknown> {
    return this.executeActionMethod(
      this.debuggingActions,
      this.getDebuggingActionMappings(),
      actionName,
      data
    );
  }

  private async handleAdminAction(actionName: AdminActionName, data: unknown): Promise<unknown> {
    // Handle special cases that don't fit the standard pattern
    switch (actionName) {
      case 'check-user-privilege':
        if (data && typeof data === 'object' && 'privilegeName' in data) {
          const privilegeData = data as { privilegeName: string };
          return await AdminActions.checkUserPrivilege(privilegeData.privilegeName);
        } else {
          throw new Error(
            'Invalid data for check-user-privilege action: privilegeName is required'
          );
        }
      case 'search-users':
        if (data && typeof data === 'object' && 'query' in data) {
          const searchData = data as { query: string };
          const result = await AdminActions.searchUsers(searchData.query);
          console.log('[levelup.extension] AdminActions.searchUsers returned:', result);
          return result;
        } else {
          throw new Error('Invalid data for search-users action: query is required');
        }
      case 'start-impersonation':
      case 'stop-impersonation':
      case 'get-impersonation-status':
        throw new Error('Impersonation actions should be handled by background script');
      default:
        // Handle standard admin actions using the mapping
        return this.executeActionMethod(
          AdminActions,
          this.getAdminActionMappings(),
          actionName,
          data
        );
    }
  }

  private async handleCustomCommandAction(actionName: string, data: unknown): Promise<unknown> {
    if (actionName === 'execute') {
      if (data && typeof data === 'object' && 'command' in data) {
        const executionData = data as { command: CustomCommand };
        return await CustomCommandsExecutor.executeCommand(executionData.command);
      } else {
        throw new Error('Invalid data for custom command execution: command is required');
      }
    } else {
      throw new Error(`Unknown custom command action: ${actionName}`);
    }
  }

  /**
   * Get current record information from Xrm context or URL
   */
  private getCurrentRecordInfo(): {
    entityType: string;
    entityId: string;
    entityLogicalName: string;
  } | null {
    try {
      // Method 1: Try to get from Xrm.Page (deprecated but still works)
      if (typeof Xrm !== 'undefined' && Xrm.Page?.data?.entity) {
        const entity = Xrm.Page.data.entity;
        return {
          entityType: entity.getEntityName(),
          entityId: entity.getId().replace(/[{}]/g, ''),
          entityLogicalName: entity.getEntityName(),
        };
      }

      // Method 2: Try to get from modern Xrm.Utility
      if (typeof Xrm !== 'undefined' && Xrm.Utility?.getGlobalContext) {
        const globalContext = Xrm.Utility.getGlobalContext();
        const pageContext = globalContext.getCurrentAppUrl
          ? globalContext.getCurrentAppUrl()
          : window.location.href;

        const urlParams = new URLSearchParams(new URL(pageContext).search);
        const entityType = urlParams.get('etn');
        const entityId = urlParams.get('id');

        if (entityType && entityId) {
          return {
            entityType: entityType,
            entityId: entityId.replace(/[{}]/g, ''),
            entityLogicalName: entityType,
          };
        }
      }

      // Method 3: Parse from URL parameters
      const urlParams = new URLSearchParams(window.location.search);
      const entityType = urlParams.get('etn');
      const entityId = urlParams.get('id');

      if (entityType && entityId) {
        return {
          entityType: entityType,
          entityId: entityId.replace(/[{}]/g, ''),
          entityLogicalName: entityType,
        };
      }

      return null;
    } catch (error) {
      console.error('Error getting current record info:', error);
      return null;
    }
  }

  /**
   * Get user's preferred solution using WebAPI client.
   * Uses the solutions cache to avoid a live network call when possible.
   */
  public async getPreferredSolution(): Promise<Solution | null> {
    // Fast path: use the solutions cache (populated on page load)
    const cached = this.getCachedSolutionState();
    if (cached?.currentSolutionId && cached.solutions.length > 0) {
      const found = cached.solutions.find(
        s =>
          this.normalizeSolutionId(s.solutionid) ===
          this.normalizeSolutionId(cached.currentSolutionId)
      );
      if (found) return found;
    }

    // Slow path: live API call
    try {
      return await this.getDataversePreferredSolution();
    } catch (error) {
      return null;
    }
  }

  private async getDataversePreferredSolution(): Promise<Solution | null> {
    try {
      const webApiClient = WebApiClient.getInstance();

      // Use the WebAPI client to call the GetPreferredSolution function
      const response = await webApiClient.executeFunction('GetPreferredSolution');

      if (response && typeof response === 'object') {
        const solutionResponse = response as Record<string, unknown>;
        return {
          uniquename: solutionResponse.uniquename as string,
          friendlyname: solutionResponse.friendlyname as string,
          solutionid: solutionResponse.solutionid as string,
          version: solutionResponse.version as string,
          ismanaged: solutionResponse.ismanaged as boolean,
        };
      }

      return null;
    } catch (error) {
      return null;
    }
  }

  private normalizeSolutionId(solutionId: string): string {
    return solutionId.replace(/[{}]/g, '').toLowerCase();
  }

  private canBePreferredSolution(solution: Solution): boolean {
    if (!solution.solutionid || !solution.uniquename) {
      return false;
    }

    if (solution.isvisible === false) {
      return false;
    }

    if (this.isReservedSystemSolution(solution.uniquename)) {
      return false;
    }

    return !this.isLikelySystemSolution(solution);
  }

  private isReservedSystemSolution(uniqueName: string): boolean {
    const reservedSystemSolutions = new Set(['active', 'default']);
    return reservedSystemSolutions.has(uniqueName.toLowerCase());
  }

  private isLikelySystemSolution(solution: Solution): boolean {
    const normalizedUniqueName = solution.uniquename.toLowerCase();
    const normalizedFriendlyName = solution.friendlyname.toLowerCase();

    const systemUniqueNamePrefixes = ['msdyn_', 'mspp_', 'adx_', 'microsoft'];

    const systemFriendlyNamePrefixes = ['dynamics ', 'microsoft ', 'default ', 'active '];

    return (
      systemUniqueNamePrefixes.some(prefix => normalizedUniqueName.startsWith(prefix)) ||
      systemFriendlyNamePrefixes.some(prefix => normalizedFriendlyName.startsWith(prefix))
    );
  }

  private escapeHtml(value: string): string {
    const div = document.createElement('div');
    div.textContent = value;
    return div.innerHTML;
  }

  private async setPreferredSolutionOnServer(solutionId: string): Promise<void> {
    const webApiClient = WebApiClient.getInstance();
    await webApiClient.executeAction('SetPreferredSolution', {
      SolutionId: this.normalizeSolutionId(solutionId),
    });
  }

  /**
   * Get solution by name using WebAPI client
   */
  private async getSolutionByName(solutionName: string): Promise<Solution | null> {
    try {
      const webApiClient = WebApiClient.getInstance();

      // Use the WebAPI client to query solutions
      const solutions = await webApiClient.retrieveMultiple('solutions', {
        filter: `uniquename eq '${encodeURIComponent(solutionName)}'`,
        select: ['solutionid', 'uniquename', 'friendlyname', 'version', 'ismanaged'],
      });

      if (solutions && solutions.value && solutions.value.length > 0) {
        const solution = solutions.value[0] as Record<string, unknown>;
        return {
          uniquename: solution.uniquename as string,
          friendlyname: solution.friendlyname as string,
          solutionid: solution.solutionid as string,
          version: solution.version as string,
          ismanaged: solution.ismanaged as boolean,
        };
      }

      return null;
    } catch (error) {
      return null;
    }
  }

  private async getSolutionById(solutionId: string): Promise<Solution | null> {
    try {
      const webApiClient = WebApiClient.getInstance();
      const normalizedSolutionId = this.normalizeSolutionId(solutionId);
      const solution = (await webApiClient.retrieveRecord('solutions', normalizedSolutionId, [
        'solutionid',
        'uniquename',
        'friendlyname',
        'version',
        'ismanaged',
        'isvisible',
      ])) as Record<string, unknown>;

      if (!solution?.solutionid) {
        return null;
      }

      return {
        uniquename: solution.uniquename as string,
        friendlyname:
          (solution.friendlyname as string) ||
          (solution.uniquename as string) ||
          'Unnamed Solution',
        solutionid: solution.solutionid as string,
        version: (solution.version as string) || '',
        ismanaged: Boolean(solution.ismanaged),
        isvisible: solution.isvisible as boolean,
      };
    } catch (error) {
      return null;
    }
  }

  private async getSolutionsForPicker(): Promise<Solution[]> {
    const webApiClient = WebApiClient.getInstance();
    const response = await webApiClient.retrieveMultiple('solutions', {
      select: ['solutionid', 'uniquename', 'friendlyname', 'version', 'ismanaged', 'isvisible'],
      orderBy: ['friendlyname asc', 'uniquename asc'],
    });

    const rawSolutions = Array.isArray(response?.value) ? response.value : [];
    const mappedSolutions = rawSolutions
      .map((solution: Record<string, unknown>) => ({
        uniquename: (solution.uniquename as string) || '',
        friendlyname:
          (solution.friendlyname as string) ||
          (solution.uniquename as string) ||
          'Unnamed Solution',
        solutionid: (solution.solutionid as string) || '',
        version: (solution.version as string) || '',
        ismanaged: Boolean(solution.ismanaged),
        isvisible: solution.isvisible as boolean,
      }))
      .sort((left, right) => left.friendlyname.localeCompare(right.friendlyname));

    const strictCandidates = mappedSolutions.filter(
      solution => this.canBePreferredSolution(solution) && !solution.ismanaged
    );
    if (strictCandidates.length > 0) {
      return strictCandidates;
    }

    const relaxedCandidates = mappedSolutions.filter(solution =>
      this.canBePreferredSolution(solution)
    );
    if (relaxedCandidates.length > 0) {
      return relaxedCandidates;
    }

    // Safety fallback: still exclude the hard system defaults, even if no better options exist.
    return mappedSolutions.filter(
      solution =>
        Boolean(solution.solutionid && solution.uniquename) &&
        !this.isReservedSystemSolution(solution.uniquename)
    );
  }

  public async selectDefaultSolution(): Promise<string> {
    try {
      const [solutions, currentSolution] = await Promise.all([
        this.listSolutionsForPicker(),
        this.getPreferredSolution(),
      ]);

      if (solutions.length === 0) {
        throw new Error('No solutions were found in the current environment.');
      }

      this.renderDefaultSolutionPicker(solutions, currentSolution);
      return 'Default solution picker opened';
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      DynamicsUtils.showToast(`Failed to load solutions: ${message}`, 'error');
      throw new Error(`Failed to load solutions: ${message}`);
    }
  }

  public async getCurrentSolutionInfo(): Promise<CurrentSolutionInfo | null> {
    const preferredSolution = await this.getDataversePreferredSolution();
    if (preferredSolution) {
      return {
        solutionId: this.normalizeSolutionId(preferredSolution.solutionid),
        friendlyname: preferredSolution.friendlyname,
        uniquename: preferredSolution.uniquename,
        source: 'preferred',
      };
    }

    const defaultSolution = await this.getDefaultSolution();
    if (defaultSolution) {
      return {
        solutionId: this.normalizeSolutionId(defaultSolution.solutionid),
        friendlyname: defaultSolution.friendlyname,
        uniquename: defaultSolution.uniquename,
        source: 'default',
      };
    }

    return null;
  }

  private getCachedSolutionState(): { solutions: Solution[]; currentSolutionId: string } | null {
    try {
      const cached = localStorage.getItem(this.solutionsCacheKey);
      if (!cached) return null;
      const parsed = JSON.parse(cached) as {
        solutions: Solution[];
        currentSolutionId: string;
        timestamp: number;
      };
      if (
        parsed?.solutions &&
        parsed.timestamp &&
        Date.now() - parsed.timestamp < this.SOLUTIONS_CACHE_DURATION_MS
      ) {
        return { solutions: parsed.solutions, currentSolutionId: parsed.currentSolutionId || '' };
      }
    } catch {
      localStorage.removeItem(this.solutionsCacheKey);
    }
    return null;
  }

  private setCachedSolutionState(solutions: Solution[], currentSolutionId: string): void {
    try {
      localStorage.setItem(
        this.solutionsCacheKey,
        JSON.stringify({ solutions, currentSolutionId, timestamp: Date.now() })
      );
    } catch {
      // localStorage write failed — ignore
    }
  }

  /** Returns the cached solution state immediately (no API calls). Returns null if cache is empty or expired. */
  public getCombinedSolutionState(): { solutions: Solution[]; currentSolutionId: string } | null {
    return this.getCachedSolutionState();
  }

  /** Fetches fresh solutions + current from the API, updates cache, returns result. */
  public async refreshSolutionsForPicker(): Promise<{
    solutions: Solution[];
    currentSolutionId: string;
  }> {
    const [freshSolutions, currentInfo] = await Promise.all([
      this.getSolutionsForPicker(),
      this.getDataversePreferredSolution().catch(() => null),
    ]);
    const currentSolutionId = currentInfo ? this.normalizeSolutionId(currentInfo.solutionid) : '';
    this.setCachedSolutionState(freshSolutions, currentSolutionId);
    return { solutions: freshSolutions, currentSolutionId };
  }

  public async listSolutionsForPicker(forceRefresh = false): Promise<Solution[]> {
    if (!forceRefresh) {
      const cached = this.getCachedSolutionState();
      if (cached) return cached.solutions;
    }
    const result = await this.refreshSolutionsForPicker();
    return result.solutions;
  }

  public clearSolutionsCache(): void {
    localStorage.removeItem(this.solutionsCacheKey);
  }

  public async setPreferredSolution(data: { solutionId: string }): Promise<string> {
    if (!data?.solutionId) {
      throw new Error('solutionId is required');
    }

    const selectedSolution = await this.getSolutionById(data.solutionId);
    if (!selectedSolution) {
      throw new Error('Selected solution was not found');
    }

    if (!this.canBePreferredSolution(selectedSolution)) {
      throw new Error('Selected solution cannot be used as the preferred default solution');
    }

    await this.setPreferredSolutionOnServer(selectedSolution.solutionid);

    // Update the cached currentSolutionId so the popup reflects the change immediately
    const cached = this.getCachedSolutionState();
    if (cached) {
      this.setCachedSolutionState(
        cached.solutions,
        this.normalizeSolutionId(selectedSolution.solutionid)
      );
    }

    return `Default solution set to ${selectedSolution.friendlyname} for this environment.`;
  }

  private renderDefaultSolutionPicker(
    solutions: Solution[],
    currentSolution: Solution | null
  ): void {
    const dialogId = 'levelup-default-solution-picker';
    document.getElementById(`${dialogId}-backdrop`)?.remove();

    const currentSolutionId = currentSolution
      ? this.normalizeSolutionId(currentSolution.solutionid)
      : undefined;
    const selectedSolutionId = currentSolutionId || solutions[0].solutionid;

    const optionsHtml = solutions
      .map(solution => {
        const normalizedSolutionId = this.normalizeSolutionId(solution.solutionid);
        const isSelected = normalizedSolutionId === this.normalizeSolutionId(selectedSolutionId);
        const solutionType = solution.ismanaged ? 'Managed' : 'Unmanaged';
        const preferredMarker =
          currentSolutionId && normalizedSolutionId === currentSolutionId ? ' (current)' : '';

        return `<option value="${this.escapeHtml(normalizedSolutionId)}"${isSelected ? ' selected' : ''}>${this.escapeHtml(solution.friendlyname)} [${solutionType}]${preferredMarker}</option>`;
      })
      .join('');

    const dialogHTML = `
      <div class="levelup-dialog-backdrop" id="${dialogId}-backdrop" style="
        position: fixed;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        background: rgba(0, 0, 0, 0.5);
        backdrop-filter: blur(2px);
        z-index: 10000;
        display: flex;
        align-items: center;
        justify-content: center;
      ">
        <div style="
          background: white;
          border-radius: 10px;
          box-shadow: 0 20px 40px rgba(0, 0, 0, 0.3);
          width: min(520px, 92vw);
          font-family: 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
          overflow: hidden;
        ">
          <div style="
            background: linear-gradient(135deg, #2563eb, #1d4ed8);
            color: white;
            padding: 16px 20px;
            display: flex;
            justify-content: space-between;
            align-items: center;
          ">
            <div>
              <div style="font-size: 18px; font-weight: 600;">Default Solution</div>
              <div style="font-size: 12px; opacity: 0.9; margin-top: 4px;">Choose the solution CompuNet Dynamics Tools should use in this environment.</div>
            </div>
            <button class="levelup-dialog-close" aria-label="Close dialog" style="background:none;border:none;color:white;font-size:24px;cursor:pointer;line-height:1;">×</button>
          </div>
          <div style="padding: 20px; display: grid; gap: 16px;">
            <label for="${dialogId}-select" style="font-size: 13px; font-weight: 600; color: #374151;">Solution</label>
            <select id="${dialogId}-select" style="padding: 12px 14px; border: 1px solid #d1d5db; border-radius: 8px; font-size: 14px; color: #111827; background: #ffffff;">
              ${optionsHtml}
            </select>
            <div id="${dialogId}-details" style="padding: 12px 14px; border-radius: 8px; background: #f8fafc; color: #475569; font-size: 13px;"></div>
            <div style="display: flex; justify-content: flex-end; gap: 10px; flex-wrap: wrap;">
              <button id="${dialogId}-clear" style="padding: 10px 14px; border: 1px solid #cbd5e1; background: white; color: #334155; border-radius: 8px; cursor: pointer;">Close</button>
            </div>
          </div>
        </div>
      </div>
    `;

    const dialogElement = document.createElement('div');
    dialogElement.innerHTML = dialogHTML;
    document.body.appendChild(dialogElement.firstElementChild!);

    const backdrop = document.getElementById(`${dialogId}-backdrop`);
    const closeButton = backdrop?.querySelector(
      '.levelup-dialog-close'
    ) as HTMLButtonElement | null;
    const selectElement = document.getElementById(`${dialogId}-select`) as HTMLSelectElement | null;
    const detailsElement = document.getElementById(`${dialogId}-details`) as HTMLDivElement | null;
    const clearButton = document.getElementById(`${dialogId}-clear`) as HTMLButtonElement | null;

    const updateDetails = () => {
      if (!selectElement || !detailsElement) {
        return;
      }

      const selectedSolution = solutions.find(
        solution => this.normalizeSolutionId(solution.solutionid) === selectElement.value
      );

      if (!selectedSolution) {
        detailsElement.textContent = 'Select a solution to see more detail.';
        return;
      }

      const detailParts = [
        `Unique name: ${selectedSolution.uniquename}`,
        `Type: ${selectedSolution.ismanaged ? 'Managed' : 'Unmanaged'}`,
      ];

      if (selectedSolution.version) {
        detailParts.push(`Version: ${selectedSolution.version}`);
      }

      detailsElement.textContent = detailParts.join(' | ');
    };

    const closeDialog = () => backdrop?.remove();

    selectElement?.addEventListener('change', () => {
      updateDetails();

      if (!selectElement) {
        return;
      }

      const selectedSolution = solutions.find(
        solution => this.normalizeSolutionId(solution.solutionid) === selectElement.value
      );
      if (!selectedSolution) {
        return;
      }

      void this.setPreferredSolutionOnServer(selectedSolution.solutionid)
        .then(() => {
          DynamicsUtils.showToast(
            `Default solution set to ${selectedSolution.friendlyname} for this environment.`,
            'success'
          );
          closeDialog();
        })
        .catch(error => {
          const message = error instanceof Error ? error.message : 'Unknown error';
          DynamicsUtils.showToast(`Failed to update preferred solution: ${message}`, 'error');
        });
    });
    clearButton?.addEventListener('click', () => {
      closeDialog();
    });
    closeButton?.addEventListener('click', closeDialog);
    backdrop?.addEventListener('click', event => {
      if (event.target === backdrop) {
        closeDialog();
      }
    });

    updateDetails();
    selectElement?.focus();
  }

  /**
   * Get the Default solution as fallback when no preferred solution is available
   */
  public async getDefaultSolution(): Promise<Solution | null> {
    try {
      const webApiClient = WebApiClient.getInstance();

      // Query for the Default solution specifically
      const solutions = await webApiClient.retrieveMultiple('solutions', {
        filter: "uniquename eq 'Default'",
        select: ['solutionid', 'uniquename', 'friendlyname', 'version', 'ismanaged'],
      });

      if (solutions && solutions.value && solutions.value.length > 0) {
        const solution = solutions.value[0] as Record<string, unknown>;
        return {
          uniquename: solution.uniquename as string,
          friendlyname: (solution.friendlyname as string) || 'Default Solution',
          solutionid: solution.solutionid as string,
          version: solution.version as string,
          ismanaged: solution.ismanaged as boolean,
        };
      }

      // If Default solution not found, try to get any unmanaged solution
      const unmangedSolutions = await webApiClient.retrieveMultiple('solutions', {
        filter: 'ismanaged eq false',
        select: ['solutionid', 'uniquename', 'friendlyname', 'version', 'ismanaged'],
        orderBy: ['createdon'],
        top: 1,
      });

      if (unmangedSolutions && unmangedSolutions.value && unmangedSolutions.value.length > 0) {
        const solution = unmangedSolutions.value[0] as Record<string, unknown>;
        return {
          uniquename: solution.uniquename as string,
          friendlyname: (solution.friendlyname as string) || (solution.uniquename as string),
          solutionid: solution.solutionid as string,
          version: solution.version as string,
          ismanaged: solution.ismanaged as boolean,
        };
      }

      return null;
    } catch (error) {
      return null;
    }
  }

  /**
   * Get entity metadata from existing cache
   */
  private async getEntityMetadataFromCache(
    logicalName: string
  ): Promise<{ entityId: string; logicalName: string; displayName: string } | null> {
    try {
      console.log('Getting entity metadata from existing cache for:', logicalName);

      // Use the existing getCachedEntityMetadata method
      const cached = this.getCachedEntityMetadata();

      if (cached && cached.entities) {
        // Find the entity in the cached entities
        const entityMetadata = cached.entities.find(
          entity => entity.LogicalName.toLowerCase() === logicalName.toLowerCase()
        );

        if (entityMetadata) {
          return {
            entityId:
              (entityMetadata as any).MetadataId ||
              `entity-${(entityMetadata as any).ObjectTypeCode || entityMetadata.LogicalName}`,
            logicalName: entityMetadata.LogicalName,
            displayName:
              entityMetadata.DisplayName?.UserLocalizedLabel?.Label || entityMetadata.LogicalName,
          };
        }

        console.log(
          'Entity not found in cache, available entities:',
          cached.entities.map(e => e.LogicalName).join(', ')
        );
      }

      // Fallback: refresh cache and try again
      console.log('Entity not in cache, refreshing cache');
      const entities = await this.getEntityMetadata();

      if (entities) {
        const entityMetadata = entities.find(
          entity => entity.LogicalName.toLowerCase() === logicalName.toLowerCase()
        );

        if (entityMetadata) {
          return {
            entityId:
              (entityMetadata as any).MetadataId ||
              `entity-${(entityMetadata as any).ObjectTypeCode || entityMetadata.LogicalName}`,
            logicalName: entityMetadata.LogicalName,
            displayName:
              entityMetadata.DisplayName?.UserLocalizedLabel?.Label || entityMetadata.LogicalName,
          };
        }
      }

      return null;
    } catch (error) {
      console.error('Error getting entity metadata from cache:', error);
      return null;
    }
  }

  /**
   * Construct Power Platform maker portal form editor URL
   */
  private constructPowerPlatformFormEditorUrl(
    environmentInfo: { environmentId: string },
    solutionInfo: { solutionid: string },
    entityMetadata: { entityId: string },
    formId?: string
  ): string {
    // Power Platform maker portal URL format:
    // https://make.powerapps.com/environments/{environmentId}/solutions/{solutionId}/entities/{entityId}/forms
    const baseUrl = 'https://make.powerapps.com';

    let url = `${baseUrl}/environments/${environmentInfo.environmentId}/solutions/${solutionInfo.solutionid}/entities/${entityMetadata.entityId}/forms`;

    // If a specific form ID is provided, append it
    if (formId) {
      url += `/${formId}`;
    }

    return url;
  }

  private sendResponse(requestId: string | undefined, response: unknown): void {
    const responseData =
      typeof response === 'object' && response !== null ? response : { data: response };

    console.log('[levelup.extension] responseData:', responseData);

    const messageData = {
      type: 'LEVELUP_RESPONSE',
      requestId,
      ...responseData,
    };

    console.log('[levelup.extension] Sending message:', messageData);

    window.postMessage(messageData, window.location.origin);

    console.log('[levelup.extension] Message posted to window');
  }

  /**
   * Handle request for page context from sidebar
   */
  private handleGetPageContext(requestId: string): void {
    try {
      let pageContext = null;

      // Check if Xrm is available and get page context
      if (typeof Xrm !== 'undefined' && Xrm.Utility?.getPageContext) {
        pageContext = Xrm.Utility.getPageContext().input;
      }

      // Send response back to content script
      window.postMessage(
        {
          type: 'GET_PAGE_CONTEXT_RESPONSE',
          requestId: requestId,
          pageContext: pageContext,
        },
        window.location.origin
      );
    } catch (error) {
      // Send error response
      window.postMessage(
        {
          type: 'GET_PAGE_CONTEXT_RESPONSE',
          requestId: requestId,
          pageContext: null,
        },
        window.location.origin
      );
    }
  }
}

// Create the extension instance
const levelUpExtension = new LevelUpExtension();

// Add to window object for access from extension code
window.levelUpExtension = levelUpExtension;
