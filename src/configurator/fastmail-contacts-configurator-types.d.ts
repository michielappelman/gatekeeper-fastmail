import type { ConfiguratorOption } from "./fastmail-account-configurator-types";

export type FastmailContactsConfiguratorValues = {
  /** What the binding may see: every contact (the default), or one contact group. */
  mode?: "all" | "group" | null;
  /** The group (its group ContactCard id) of a group binding. */
  groupId?: string | null;
};

export interface FastmailContactsConfiguratorRpc {
  /** Returns the canonical, validated resource URL for these values; without values, all contacts. */
  resourceUrl(values?: FastmailContactsConfiguratorValues): Promise<string>;
  /** Lists the connected account's contact groups whose name contains `query`. */
  listGroups(query: string): Promise<ConfiguratorOption[]>;
  /** The form values a resource URL stands for, so a requested connection opens pre-filled. */
  valuesFromResourceUrl(resourceUrl: string): Promise<FastmailContactsConfiguratorValues>;
}
