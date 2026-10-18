import { Autocomplete, Field, h, RadioCards, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type {
  FastmailContactsConfiguratorRpc,
  FastmailContactsConfiguratorValues,
} from "./fastmail-contacts-configurator-types";

// The binding can see every contact, or the members of one contact group. The resource URL is minted
// by the gatekeeper (`ui.resourceUrl(values)`), which validates it the same way it parses a bound URL.

export default {
  initial: { mode: "all" },

  isReady({ values }) {
    const mode = values.mode ?? "all";
    if (mode === "all") return true;
    if (mode === "group") return typeof values.groupId === "string" && values.groupId.length > 0;
    return false;
  },

  initialValuesFromResourceUrl({ resourceUrl, ui }) {
    return ui.valuesFromResourceUrl(resourceUrl);
  },

  resourceUrl({ values, ui }) {
    return ui.resourceUrl(values);
  },

  render({ values, setValues, clearFields, ui }) {
    const mode = values.mode ?? "all";
    return <Section>
      <Field label="Contacts scope" description="Choose which contacts this connection can read. Anything outside it stays invisible to the agent and its gadgets.">
        <RadioCards
          value={mode}
          options={[
            { value: "all", title: "All contacts", description: "Read, search, and (with approval) change every contact and contact group." },
            { value: "group", title: "One group", description: "Only the current members of one contact group. New contacts join the group." },
          ]}
          onChange={nextMode => {
            if (nextMode !== "all" && nextMode !== "group") return;
            clearFields("groupId");
            setValues({ mode: nextMode, groupId: null });
          }}
        />
      </Field>

      {mode === "group" && <Field label="Group" description="Contacts added to the group later become visible; removed ones disappear.">
        <Autocomplete
          name="groupId"
          value={values.groupId}
          placeholder="Search groups..."
          loadOptions={query => ui.listGroups(query)}
          onChange={groupId => setValues({ groupId })}
        />
      </Field>}
    </Section>;
  },
} satisfies ConfiguratorUISpec<FastmailContactsConfiguratorRpc, FastmailContactsConfiguratorValues>;
