import { useMemo } from "react";
import { FrameHost } from "./FrameHost";

/** Renders one file in an extension's previewer frame via `preview.file`. */
export function PreviewFrame({
  ext,
  frame,
  path,
  name,
  content,
  truncated,
}: {
  ext: string;
  frame: string;
  path: string;
  name: string;
  content: string;
  truncated: boolean;
}) {
  const payload = useMemo(
    () => ({
      name: "preview.file",
      data: { path, name, content, truncated },
    }),
    [path, name, content, truncated],
  );
  return (
    <div className="ext-preview">
      <FrameHost ext={ext} frame={frame} payload={payload} height={480} />
    </div>
  );
}
