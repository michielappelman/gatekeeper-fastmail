/**
 * Autocomplete row the configurator RPC returns. Local so server code can import configurator types
 * without pulling `@gadgets/configurator-ui`'s global `JSX`.
 */
export type ConfiguratorOption = {
  value: string;
  title: string;
  subtitle?: string;
  meta?: string;
};

export type FastmailAccountConfiguratorValues = {
  /** What the binding may see: the whole mailbox (the default), one folder, or a saved search. */
  mode?: "all" | "folder" | "search" | null;
  /** The folder (JMAP Mailbox id) of a folder binding. */
  folderId?: string | null;
  /** A saved search's conditions; at least one must be set. */
  from?: string | null;
  to?: string | null;
  subject?: string | null;
  text?: string | null;
  /** Optionally, the folder a saved search is confined to. */
  searchFolderId?: string | null;
};

export interface FastmailAccountConfiguratorRpc {
  /**
   * Returns the canonical resource URL for these values, validated by the gatekeeper. Without
   * values, the whole-mailbox URL.
   */
  resourceUrl(values?: FastmailAccountConfiguratorValues): Promise<string>;
  /** Lists the connected account's folders whose name contains `query`. */
  listFolders(query: string): Promise<ConfiguratorOption[]>;
  /** The form values a resource URL stands for, so a requested connection opens pre-filled. */
  valuesFromResourceUrl(resourceUrl: string): Promise<FastmailAccountConfiguratorValues>;
}
