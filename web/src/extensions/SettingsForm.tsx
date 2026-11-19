import { useState } from "react";
import type { ExtensionSetting } from "../../../shared/extensions";
import { extConfigSet } from "./rpc";

type Draft = Record<string, unknown>;

function optionList(setting: ExtensionSetting) {
  return (setting.options ?? []).map((option) =>
    typeof option === "string" ? { value: option, label: option } : option,
  );
}

function isSecretSet(value: unknown) {
  return (
    !!value && typeof value === "object" && "set" in value && value.set === true
  );
}

function Field({
  name,
  setting,
  scopeLabel,
  value,
  stored,
  onChange,
}: {
  name: string;
  setting: ExtensionSetting;
  scopeLabel?: string;
  value: unknown;
  stored: unknown;
  onChange: (value: unknown) => void;
}) {
  const id = `ext-setting-${name}`;
  let control;
  if (setting.type === "boolean") {
    control = (
      <input
        id={id}
        type="checkbox"
        checked={value === true}
        onChange={(event) => onChange(event.target.checked)}
      />
    );
  } else if (setting.type === "select") {
    control = (
      <select
        id={id}
        value={String(value ?? "")}
        onChange={(event) => onChange(event.target.value)}
      >
        {setting.required ? null : <option value="">(none)</option>}
        {optionList(setting).map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    );
  } else if (setting.type === "number") {
    control = (
      <input
        id={id}
        type="number"
        min={setting.min}
        max={setting.max}
        value={typeof value === "number" ? value : ""}
        onChange={(event) =>
          onChange(
            event.target.value === "" ? undefined : Number(event.target.value),
          )
        }
      />
    );
  } else {
    const secret = setting.type === "secret";
    control = (
      <input
        id={id}
        type={secret ? "password" : "text"}
        autoComplete="off"
        placeholder={secret && isSecretSet(stored) ? "Set (hidden)" : undefined}
        value={typeof value === "string" ? value : ""}
        onChange={(event) => onChange(event.target.value)}
      />
    );
  }
  return (
    <div className="ext-field">
      <label htmlFor={id}>
        {setting.title}
        {setting.required ? " *" : ""}
      </label>
      {control}
      {setting.description ? (
        <span className="muted">{setting.description}</span>
      ) : null}
      {scopeLabel ? <span className="muted">{scopeLabel}</span> : null}
    </div>
  );
}

/** Form generated from the manifest `config` table; secrets are write-only. */
export function SettingsForm({
  ext,
  schema,
  values,
  connectionId,
  connectionLabel,
}: {
  ext: string;
  schema: Record<string, ExtensionSetting>;
  values: Draft;
  connectionId: string;
  connectionLabel: string;
}) {
  const names = Object.keys(schema);
  const [draft, setDraft] = useState<Draft>({});
  const [status, setStatus] = useState<{ error?: string; saved?: boolean }>({});
  if (names.length === 0)
    return <p className="muted">This extension has no settings.</p>;

  const current = (name: string) =>
    name in draft
      ? draft[name]
      : schema[name].type === "secret"
        ? ""
        : (values[name] ?? schema[name].default);
  const dirty = Object.keys(draft);
  const save = async () => {
    setStatus({});
    try {
      for (const name of dirty) {
        if (schema[name].type === "secret" && draft[name] === "") continue;
        await extConfigSet(
          ext,
          name,
          draft[name],
          schema[name].scope === "connection" ? connectionId : undefined,
        );
      }
      setDraft({});
      setStatus({ saved: true });
    } catch (error) {
      setStatus({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };
  return (
    <form
      className="ext-settings-form"
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
    >
      {names.map((name) => (
        <Field
          key={name}
          name={name}
          setting={schema[name]}
          scopeLabel={
            schema[name].scope === "connection"
              ? `Saved for ${connectionLabel}`
              : undefined
          }
          value={current(name)}
          stored={values[name]}
          onChange={(value) => {
            setStatus({});
            setDraft((previous) => ({ ...previous, [name]: value }));
          }}
        />
      ))}
      <div className="ext-actions">
        {status.error ? (
          <span className="ext-error" role="alert">
            {status.error}
          </span>
        ) : status.saved ? (
          <span className="muted" role="status">
            Saved
          </span>
        ) : null}
        <button type="submit" disabled={dirty.length === 0}>
          Save settings
        </button>
      </div>
    </form>
  );
}
