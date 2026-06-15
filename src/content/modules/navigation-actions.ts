// Navigation actions module for Dynamics 365

/// <reference types="xrm" />

import { DynamicsUtils } from './utils';
import { EntityMetadata, EntityMetadataCache } from '#types/global';
import { WebApiClient } from './webapi-client';

export class NavigationActions {
  /**
   * Get entity metadata from cache for icon determination
   */
  private static getEntityMetadata(entityLogicalName: string): EntityMetadata | null {
    try {
      const globalContext = Xrm.Utility.getGlobalContext();
      const clientUrl = globalContext.getClientUrl();
      const url = new URL(clientUrl);
      const hostname = url.hostname.toLowerCase();
      const cacheKey = `levelup_entity_metadata_${hostname}`;

      const cached = localStorage.getItem(cacheKey);
      if (!cached) {
        return null;
      }

      const parsed = JSON.parse(cached) as EntityMetadataCache;
      if (parsed && parsed.entities && parsed.timestamp) {
        return (
          parsed.entities.find(
            entity => entity.LogicalName?.toLowerCase() === entityLogicalName?.toLowerCase()
          ) || null
        );
      }
    } catch (error) {
      // Silently handle cache errors to avoid breaking navigation actions
    }
    return null;
  }

  /**
   * Get appropriate icon URL for entity
   */
  private static getEntityIconUrl(entityLogicalName: string): string | null {
    const entityMetadata = this.getEntityMetadata(entityLogicalName);

    if (entityMetadata) {
      const globalContext = Xrm.Utility.getGlobalContext();
      const clientUrl = globalContext.getClientUrl();

      // If IconSmallName is not null, use it
      if (entityMetadata.IconSmallName) {
        return `${clientUrl}/Webresources/${entityMetadata.IconSmallName}`;
      }
      // If IconSmallName is null, use ObjectTypeCode
      if (entityMetadata.ObjectTypeCode) {
        return `${clientUrl}/_imgs/svg_${entityMetadata.ObjectTypeCode}.svg`;
      }
    }

    // Fallback to default icon
    return null;
  }

  /**
   * Open a record by entity name and ID
   */
  static openRecordById(data: { entityName: string; recordId: string }): string {
    const { entityName, recordId } = data;
    if (!entityName || !recordId) {
      throw new Error('Entity name and record ID are required');
    }

    return DynamicsUtils.openPage(
      {
        entityName,
        pageType: 'entityrecord',
        parameters: { id: recordId },
      },
      `Record opened: ${entityName} (${recordId})`
    );
  }

  /**
   * Create a new record for specified entity
   */
  static createNewRecord(data: { entityName: string }): string {
    const { entityName } = data;
    if (!entityName) {
      throw new Error('Entity name is required');
    }

    return DynamicsUtils.openPage(
      {
        entityName,
        pageType: 'entityrecord',
      },
      `New ${entityName} record window opened`
    );
  }

  /**
   * Open entity list view
   */
  static openEntityList(data: { entityName: string }): string {
    const { entityName } = data;
    if (!entityName) {
      throw new Error('Entity name is required');
    }

    return DynamicsUtils.openPage(
      {
        entityName,
        pageType: 'entitylist',
      },
      `${entityName} list opened`
    );
  }

  /**
   * Open Security area
   */
  static openSecurity(): string {
    const orgSettings = Xrm.Utility.getGlobalContext().organizationSettings;
    return DynamicsUtils.openPage(
      {
        url: `https://admin.powerplatform.microsoft.com/manage/environments/${orgSettings.organizationId}/${orgSettings.bapEnvironmentId}/users`,
      },
      'Security area opened'
    );
  }

  /**
   * Open System Jobs
   */
  static openSystemJobs(): string {
    return DynamicsUtils.openPage(
      {
        entityName: 'asyncoperation',
        pageType: 'entitylist',
      },
      'System jobs opened'
    );
  }

  /**
   * Open Solutions
   */
  static openSolutions(): string {
    return DynamicsUtils.openPage(
      {
        url: `https://make.powerapps.com/environments/${Xrm.Utility.getGlobalContext().organizationSettings.bapEnvironmentId}/solutions`,
      },
      'Solutions opened'
    );
  }

  /**
   * Open the in-page picker to choose the default solution for this environment
   */
  static async selectDefaultSolution(): Promise<string> {
    return await window.levelUpExtension.selectDefaultSolution();
  }

  /**
   * Get the current effective solution Level Up will use in this environment
   */
  static async getCurrentSolutionInfo(): Promise<unknown> {
    return await window.levelUpExtension.getCurrentSolutionInfo();
  }

  /**
   * List solutions available for inline picker rendering
   */
  static async listSolutionsForPicker(): Promise<unknown> {
    return await window.levelUpExtension.listSolutionsForPicker();
  }

  /**
   * Return cached solution state (solutions + currentSolutionId) without any API call
   */
  static getCombinedSolutionState(): unknown {
    return window.levelUpExtension.getCombinedSolutionState();
  }

  /**
   * Force-refresh solutions cache and return combined state { solutions, currentSolutionId }
   */
  static async refreshSolutionsForPicker(): Promise<unknown> {
    return await window.levelUpExtension.refreshSolutionsForPicker();
  }

  /**
   * Set preferred solution for current user/environment
   */
  static async setPreferredSolution(data: { solutionId: string }): Promise<unknown> {
    return await window.levelUpExtension.setPreferredSolution(data);
  }

  /**
   * Open Processes
   */
  static openProcesses(): string {
    return DynamicsUtils.openPage(
      {
        entityName: 'workflow',
        pageType: 'entitylist',
      },
      'Processes opened'
    );
  }

  /**
   * Open Mailboxes
   */
  static openMailboxes(): string {
    return DynamicsUtils.openPage(
      {
        entityName: 'mailbox',
        pageType: 'entitylist',
      },
      'Mailboxes opened'
    );
  }

  /**
   * Open main Dynamics 365 page
   */
  static openMain(): string {
    return DynamicsUtils.openPage({}, 'Main page opened');
  }

  /**
   * Open Advanced Find
   */
  static openAdvancedFind(): string {
    return DynamicsUtils.openPage(
      {
        pageType: 'advancedfind',
      },
      'Advanced Find opened'
    );
  }

  /**
   * Open Mobile Client (MoCA)
   */
  static openMobileClient(): string {
    const orgUrl = DynamicsUtils.getOrganizationUrl();
    const globalContext = Xrm.Utility.getGlobalContext();
    return DynamicsUtils.openPage(
      {
        url: `${orgUrl}/nga/main.htm?org=${globalContext.organizationSettings.uniqueName}&server=${globalContext.getClientUrl()}`,
      },
      'Mobile client opened'
    );
  }

  /**
   * Open Power Platform Admin Center for current environment
   */
  static openPowerPlatformAdmin(): string {
    try {
      const orgSettings = Xrm.Utility.getGlobalContext().organizationSettings;

      // Use bapEnvironmentId if available, otherwise fall back to generic admin center
      if (orgSettings && orgSettings.bapEnvironmentId) {
        return DynamicsUtils.openPage(
          {
            url: `https://admin.powerplatform.microsoft.com/environments/environment/${orgSettings.bapEnvironmentId}/hub`,
          },
          'Power Platform Admin center opened for current environment'
        );
      } else {
        return DynamicsUtils.openPage(
          {
            url: 'https://admin.powerplatform.microsoft.com',
          },
          'Power Platform Admin center opened'
        );
      }
    } catch (error) {
      return DynamicsUtils.openPage(
        {
          url: 'https://admin.powerplatform.microsoft.com',
        },
        'Power Platform Admin center opened'
      );
    }
  }

  /**
   * Pin current view or record to side panel
   */
  static async pinToSidePanel(): Promise<string> {
    try {
      const pageInput = Xrm.Utility.getPageContext().input;
      const entityName = pageInput.entityName;

      // Get appropriate icon for the entity
      const iconUrl = this.getEntityIconUrl(entityName);
      const paneSettings: { canClose: boolean; imageSrc?: string } = {
        canClose: true,
        ...(iconUrl && { imageSrc: iconUrl }),
      };

      const pane = await Xrm.App.sidePanes.createPane(paneSettings);
      if (pageInput.pageType === 'entityrecord') {
        pane.navigate({
          pageType: pageInput.pageType,
          entityName: pageInput.entityName,
          entityId: pageInput.entityId,
        });
      } else {
        pane.navigate({
          pageType: pageInput.pageType,
          entityName: pageInput.entityName,
        });
      }

      return 'Current page pinned to side panel';
    } catch (error) {
      throw new Error(
        `Failed to pin to side panel: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Open Solutions History
   */
  static openSolutionsHistory(): string {
    return DynamicsUtils.openPage(
      {
        url: `https://make.powerapps.com/environments/${Xrm.Utility.getGlobalContext().organizationSettings.bapEnvironmentId}/solutionsHistory`,
      },
      'Solutions history opened'
    );
  }

  /**
   * Create a support case (incident) in the current Dynamics environment.
   * Called after the user fills in the Report a Problem dialog in the sidebar.
   */
  static async reportProblem(data: {
    title?: string;
    description: string;
    url: string;
    consoleLogs: Array<{ level: string; message: string; timestamp: string }>;
  }): Promise<string> {
    const { title, description, url, consoleLogs } = data;

    let consoleSection = '';
    if (consoleLogs.length > 0) {
      let logText = consoleLogs
        .map(e => `[${e.timestamp}] [${e.level.toUpperCase()}] ${e.message}`)
        .join('\n');
      if (logText.length > 5000) {
        logText = '...(truncated to last 5000 chars)\n' + logText.slice(-5000);
      }
      consoleSection = '\n\n--- Console Log ---\n' + logText;
    }

    const fullDescription = `${description}\n\n--- Page URL ---\n${url}${consoleSection}`;

    const client = WebApiClient.getInstance();
    const globalContext = Xrm.Utility.getGlobalContext();
    const userId = globalContext.getUserId().replace(/[{}]/g, '');

    // Find or create a contact record matching the current systemuser
    let contactId: string | undefined;
    try {
      const userRecord = await client.retrieveRecord('systemusers', userId, [
        'internalemailaddress',
        'firstname',
        'lastname',
      ]);
      const email: string = userRecord?.internalemailaddress ?? '';
      if (email) {
        const contacts = await client.retrieveMultiple('contacts', {
          filter: `emailaddress1 eq '${email}'`,
          select: ['contactid'],
          top: 1,
        });
        contactId = (contacts?.value?.[0] as Record<string, unknown>)?.contactid as
          | string
          | undefined;

        if (!contactId) {
          // Contact doesn't exist — create one from the systemuser profile
          const newContact = await client.createRecord('contacts', {
            firstname: userRecord?.firstname ?? '',
            lastname: userRecord?.lastname ?? email,
            emailaddress1: email,
          });
          contactId =
            ((newContact as Record<string, unknown>)?.id as string) ||
            ((newContact as Record<string, unknown>)?.contactid as string) ||
            undefined;
        }
      }
    } catch {
      // Non-fatal — create case without a contact if lookup/create fails
    }

    const incidentPayload: Record<string, unknown> = {
      title: (title || description).substring(0, 200),
      description: fullDescription,
      casetypecode: 2, // Problem
      caseorigincode: 3, // Web
    };
    if (contactId) {
      incidentPayload['customerid_contact@odata.bind'] = `/contacts(${contactId})`;
    }

    const result = await client.createRecord('incidents', incidentPayload);

    const caseId: string =
      ((result as Record<string, unknown>)?.id as string) ||
      ((result as Record<string, unknown>)?.incidentid as string) ||
      '';

    if (caseId) {
      const clientUrl = globalContext.getClientUrl();
      const caseUrl = `${clientUrl}/main.aspx?etn=incident&id=${caseId}&pagetype=entityrecord`;
      return caseUrl;
    }

    return 'Case created successfully';
  }
}
