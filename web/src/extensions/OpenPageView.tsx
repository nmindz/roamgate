import { useEffect } from "react";
import { createPortal } from "react-dom";
import { ExternalLink } from "lucide-react";
import { CloseButton } from "../components/CloseButton";
import { setOpenExtensionPage, useOpenExtensionPage } from "./openPage";
import { useExtensionsState } from "./state";

/**
 * The extension page a command opened, over the workspace (full screen on
 * phones). The page is Roamgate's own proxy host page, which frames the
 * upstream app in an opaque-origin sandbox.
 */
export function OpenPageView() {
  const page = useOpenExtensionPage();
  const state = useExtensionsState();
  useEffect(() => {
    if (!page) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpenExtensionPage(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [page]);
  if (!page) return null;
  const name =
    state?.extensions.find((entry) => entry.id === page.ext)?.name ?? page.ext;
  return createPortal(
    <div className="ext-open-page" role="dialog" aria-label={name}>
      <div className="ext-open-page-bar">
        <span className="ext-open-page-title">{name}</span>
        <a
          className="ext-open-page-tab"
          href={page.url}
          target="_blank"
          rel="noopener noreferrer"
          title="Open in a new tab"
          aria-label="Open in a new tab"
          onClick={() => setOpenExtensionPage(null)}
        >
          <ExternalLink size={16} aria-hidden="true" />
        </a>
        <CloseButton
          label={`Close ${name}`}
          onClick={() => setOpenExtensionPage(null)}
        />
      </div>
      <iframe className="ext-open-page-frame" src={page.url} title={name} />
    </div>,
    document.body,
  );
}
