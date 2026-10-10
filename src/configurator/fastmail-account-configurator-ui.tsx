import { Autocomplete, Field, h, RadioCards, Section, TextInput, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type {
  FastmailAccountConfiguratorRpc,
  FastmailAccountConfiguratorValues,
} from "./fastmail-account-configurator-types";

// The binding can see the whole mailbox, one folder, or one saved search. The resource URL is
// minted by the gatekeeper (`ui.resourceUrl(values)`), which validates the values the same way it
// parses a bound URL, so this sandboxed module never has to duplicate that encoding.

const SEARCH_FIELDS = ["from", "to", "subject", "text"] as const;

function hasSearchCondition(values: FastmailAccountConfiguratorValues): boolean {
  return SEARCH_FIELDS.some(field => typeof values[field] === "string" && values[field]!.trim().length > 0);
}

export default {
  initial: { mode: "all" },

  isReady({ values }) {
    const mode = values.mode ?? "all";
    if (mode === "all") return true;
    if (mode === "folder") return typeof values.folderId === "string" && values.folderId.length > 0;
    if (mode === "search") return hasSearchCondition(values);
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
      <Field label="Mailbox scope" description="Choose what this connection can see. Anything outside it stays invisible to the agent and its gadgets.">
        <RadioCards
          value={mode}
          options={[
            { value: "all", title: "Whole mailbox", description: "Read, organize, and send email across the whole mailbox." },
            { value: "folder", title: "One folder", description: "Only messages in one folder. Can reply to them, but not write new mail." },
            { value: "search", title: "Saved search", description: "Only messages matching a search. Can reply to them, but not write new mail." },
          ]}
          onChange={nextMode => {
            if (nextMode !== "all" && nextMode !== "folder" && nextMode !== "search") return;
            clearFields("folderId", "from", "to", "subject", "text", "searchFolderId");
            setValues({
              mode: nextMode, folderId: null, from: null, to: null, subject: null, text: null, searchFolderId: null,
            });
          }}
        />
      </Field>

      {mode === "folder" && <Field label="Folder" description="Messages in this folder only, not its subfolders.">
        <Autocomplete
          name="folderId"
          value={values.folderId}
          placeholder="Search folders..."
          loadOptions={query => ui.listFolders(query)}
          onChange={folderId => setValues({ folderId })}
        />
      </Field>}

      {mode === "search" && <Field label="From" description="Sender address or name contains." optional>
        <TextInput name="from" value={values.from} placeholder="alerts@example.com" optional onChange={from => setValues({ from })} />
      </Field>}
      {mode === "search" && <Field label="To" description="Recipient address or name contains." optional>
        <TextInput name="to" value={values.to} placeholder="me+receipts@example.com" optional onChange={to => setValues({ to })} />
      </Field>}
      {mode === "search" && <Field label="Subject" description="Subject contains." optional>
        <TextInput name="subject" value={values.subject} placeholder="Invoice" optional onChange={subject => setValues({ subject })} />
      </Field>}
      {mode === "search" && <Field label="Text" description="Full-text search over headers and body." optional>
        <TextInput name="text" value={values.text} placeholder="order confirmation" optional onChange={text => setValues({ text })} />
      </Field>}
      {mode === "search" && <Field label="In folder" description="Optionally, only matches in this folder." optional>
        <Autocomplete
          name="searchFolderId"
          value={values.searchFolderId}
          placeholder="Any folder"
          optional
          loadOptions={query => ui.listFolders(query)}
          onChange={searchFolderId => setValues({ searchFolderId })}
          onClear={() => setValues({ searchFolderId: null })}
        />
      </Field>}
    </Section>;
  },
} satisfies ConfiguratorUISpec<FastmailAccountConfiguratorRpc, FastmailAccountConfiguratorValues>;
