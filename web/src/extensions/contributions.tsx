import { useEffect } from "react";
import type { ExtensionStateResult } from "../../../shared/extensions";
import {
  type FilePreviewer,
  type LinkPattern,
  setExtensionContributions,
} from "../extensionsBootstrap";
import { useExtensionsState } from "./state";
import type { ComposerItem } from "./types";

const MAX_PATTERN_LENGTH = 200;

function enabled(state: ExtensionStateResult | null) {
  return state && !state.safe_mode
    ? state.extensions.filter((entry) => entry.enabled)
    : [];
}

/** `link_patterns` with a compilable regex; a bad one is skipped, not fatal. */
export function linkPatternsFromState(
  state: ExtensionStateResult | null,
): LinkPattern[] {
  return enabled(state).flatMap((extension) =>
    (extension.contributions.link_patterns ?? []).flatMap((item) => {
      if (item.pattern.length > MAX_PATTERN_LENGTH) return [];
      try {
        return [
          {
            ext: extension.id,
            regex: new RegExp(item.pattern, "g"),
            url: item.url,
          },
        ];
      } catch {
        return [];
      }
    }),
  );
}

export function previewersFromState(
  state: ExtensionStateResult | null,
): FilePreviewer[] {
  return enabled(state).flatMap((extension) =>
    (extension.contributions.previewers ?? []).flatMap((item) =>
      item.extensions?.length
        ? [
            {
              ext: extension.id,
              frame: item.frame,
              extensions: item.extensions.map((value) => value.toLowerCase()),
            },
          ]
        : [],
    ),
  );
}

/** Manifest `composer_commands` that apply to `agent`; `expand` replaces the typed name. */
export function composerCommandsFromState(
  state: ExtensionStateResult | null,
  agent?: string,
): ComposerItem[] {
  return enabled(state).flatMap((extension) =>
    (extension.contributions.composer_commands ?? []).flatMap((item) =>
      item.agents?.length && (!agent || !item.agents.includes(agent))
        ? []
        : [
            {
              name: item.name,
              description: item.description ?? extension.name,
              arguments: item.arguments,
              expand: item.expand,
            },
          ],
    ),
  );
}

/** Publishes the code-free contributions to the app. Renders nothing. */
export function ContributionsView() {
  const state = useExtensionsState();
  useEffect(() => {
    setExtensionContributions({
      linkPatterns: linkPatternsFromState(state),
      previewers: previewersFromState(state),
    });
    return () =>
      setExtensionContributions({ linkPatterns: [], previewers: [] });
  }, [state]);
  return null;
}
