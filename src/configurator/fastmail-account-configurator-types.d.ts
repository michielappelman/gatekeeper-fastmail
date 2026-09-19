export type FastmailAccountConfiguratorValues = {
  /**
   * No user-selectable values: connecting the account grants whole-mailbox access. A placeholder
   * field gives `isReady` something to check.
   */
  confirmed?: string | null;
};

export interface FastmailAccountConfiguratorRpc {
  /** Returns the canonical resource URL for the connected account. */
  resourceUrl(): Promise<string>;
}
