import { ContributionsView } from "./contributions";
import { KeybindingsView } from "./KeybindingsView";
import { ThemesView } from "./themes";

/** Mounted once by the app: key bindings and extension contributions live from startup. */
export function BootView() {
  return (
    <>
      <KeybindingsView />
      <ThemesView />
      <ContributionsView />
    </>
  );
}
