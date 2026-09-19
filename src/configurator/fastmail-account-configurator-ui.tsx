import { Field, h, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type {
  FastmailAccountConfiguratorRpc,
  FastmailAccountConfiguratorValues,
} from "./fastmail-account-configurator-types";

// The whole-mailbox resource has no user-selectable inputs — once an account is connected, the
// resource URL is fully determined. The configurator confirms what is being connected and signals
// readiness immediately. The sandboxed runtime has no effect hooks, so we render static text and
// rely on `resourceUrl` (via the `ui` capability) to produce the canonical URL.

export default {
  initial: { confirmed: "yes" },

  isReady() {
    return true;
  },

  resourceUrl({ ui }) {
    return ui.resourceUrl();
  },

  render() {
    return <Section>
      <Field
        label="Whole mailbox access"
        description="This binding grants access to the connected Fastmail account's whole mailbox: reading, searching, organizing, and sending email, subject to what the connected API token was granted.">
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<FastmailAccountConfiguratorRpc, FastmailAccountConfiguratorValues>;
