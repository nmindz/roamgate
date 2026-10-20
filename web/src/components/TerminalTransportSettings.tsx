import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { ImageIcon, Info, Wifi } from "lucide-react";
import { bridge } from "../api";
import { useConnectionClient } from "../useConnectionClient";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";

const TRANSPORT_DESCRIPTION =
  "Reduces Herdr-to-Roamgate traffic when the server supports delta and reuse frames. " +
  "Saved on the Roamgate server for this connection and shared by all viewers. " +
  "Changes briefly reconnect terminal displays; running tasks are not stopped. " +
  "Older Herdr servers keep their existing transport.";

const KITTY_GRAPHICS_DESCRIPTION =
  "Streams images that terminal programs draw with the Kitty graphics protocol, " +
  "such as a herdr-browser page view. Heavy on slow connections. " +
  "When off, panes with images show a placeholder instead. " +
  "Saved on the Roamgate server for this connection and shared by all viewers; " +
  "applies without reconnecting.";

interface TerminalTransportValues {
  surface_codecs: boolean;
  kitty_graphics: boolean;
}

type SettingKey = keyof TerminalTransportValues;

interface SettingRowProps {
  idPrefix: string;
  icon: ReactNode;
  label: string;
  description: string;
  enabled: boolean | null;
  saving: boolean;
  unavailable: boolean;
  disabled: boolean;
  onToggle: () => void;
}

function SettingRow({
  idPrefix,
  icon,
  label,
  description,
  enabled,
  saving,
  unavailable,
  disabled,
  onToggle,
}: SettingRowProps) {
  const labelId = `${idPrefix}-label`;
  const descriptionId = `${idPrefix}-description`;
  const about = `About ${label.toLowerCase()}`;
  return (
    <>
      <div className="config-preference-row">
        <span className="config-item-icon">{icon}</span>
        <div className="config-item-copy">
          <div className="configuration-setting-label">
            <strong id={labelId}>{label}</strong>
            <Popover>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  className="configuration-help"
                  aria-label={about}
                  title={description}
                >
                  <Info size={14} aria-hidden="true" />
                </button>
              </PopoverTrigger>
              <PopoverContent
                className="configuration-help-content"
                aria-label={about}
                aria-describedby={descriptionId}
                collisionPadding={12}
              >
                {description}
              </PopoverContent>
            </Popover>
          </div>
          <span role="status">
            {saving
              ? "Saving..."
              : enabled === null
                ? unavailable
                  ? "Unavailable"
                  : "Loading..."
                : enabled
                  ? "Enabled"
                  : "Disabled"}
          </span>
        </div>
        <button
          type="button"
          role="switch"
          aria-labelledby={labelId}
          aria-describedby={descriptionId}
          aria-checked={enabled === true}
          aria-disabled={enabled === null || disabled}
          className={"settings-switch" + (enabled ? " is-on" : "")}
          onClick={onToggle}
        >
          <span />
        </button>
      </div>
      <p id={descriptionId} hidden>
        {description}
      </p>
    </>
  );
}

export function TerminalTransportSettings() {
  const client = useConnectionClient();
  const [settings, setSettings] = useState<TerminalTransportValues | null>(
    null,
  );
  const [saving, setSaving] = useState<SettingKey | null>(null);
  const [error, setError] = useState<{
    message: string;
    key?: SettingKey;
    value?: boolean;
  } | null>(null);
  const sequence = useRef(0);
  const mounted = useRef(false);
  const pending = useRef(false);
  const load = useCallback(async () => {
    const request = ++sequence.current;
    try {
      const result = await client.call("settings.terminal_transport.get");
      if (
        typeof result?.surface_codecs !== "boolean" ||
        typeof result?.kitty_graphics !== "boolean"
      )
        throw new Error("Invalid terminal transport settings");
      if (
        !mounted.current ||
        !client.isCurrent() ||
        request !== sequence.current
      )
        return;
      setSettings({
        surface_codecs: result.surface_codecs,
        kitty_graphics: result.kitty_graphics,
      });
      setError(null);
    } catch (e) {
      if (
        !mounted.current ||
        !client.isCurrent() ||
        request !== sequence.current
      )
        return;
      setSettings(null);
      setError({ message: (e as Error).message });
    }
  }, [client]);

  useEffect(() => {
    mounted.current = true;
    void load();
    const off = bridge.onEvent((event) => {
      if (
        event.event === "settings.terminal_transport.updated" &&
        event.connection_id === client.connectionId &&
        client.acceptsServerGeneration(event.connection_generation) &&
        client.isCurrent()
      )
        void load();
    });
    return () => {
      mounted.current = false;
      sequence.current += 1;
      off();
    };
  }, [client, load]);

  const save = async (key: SettingKey, value: boolean) => {
    if (pending.current || !client.isCurrent()) return;
    pending.current = true;
    setSaving(key);
    setError(null);
    sequence.current += 1;
    try {
      await client.call("settings.terminal_transport.update", {
        [key]: value,
      });
      if (mounted.current && client.isCurrent()) await load();
    } catch (e) {
      if (mounted.current && client.isCurrent())
        setError({ message: (e as Error).message, key, value });
    } finally {
      pending.current = false;
      if (mounted.current && client.isCurrent()) setSaving(null);
    }
  };

  const rowProps = (key: SettingKey) => ({
    enabled: settings ? settings[key] : null,
    saving: saving === key,
    unavailable: error !== null,
    disabled: saving !== null || !client.isCurrent(),
    onToggle: () => {
      if (settings) void save(key, !settings[key]);
    },
  });

  return (
    <>
      <SettingRow
        idPrefix="terminal-transport"
        icon={<Wifi size={15} />}
        label="Terminal incremental transport"
        description={TRANSPORT_DESCRIPTION}
        {...rowProps("surface_codecs")}
      />
      <SettingRow
        idPrefix="kitty-graphics"
        icon={<ImageIcon size={15} />}
        label="Kitty graphics"
        description={KITTY_GRAPHICS_DESCRIPTION}
        {...rowProps("kitty_graphics")}
      />
      {error ? (
        <div className="configuration-error" role="alert">
          <span>{error.message}</span>
          <button
            type="button"
            disabled={saving !== null}
            onClick={() =>
              void (error.key === undefined || error.value === undefined
                ? load()
                : save(error.key, error.value))
            }
          >
            Retry
          </button>
        </div>
      ) : null}
    </>
  );
}
