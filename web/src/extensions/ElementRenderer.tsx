import { Suspense, useMemo, useState } from "react";
import type { El } from "../../../shared/extensions";
import { lazyWithReload } from "../lazyWithReload";
import { FrameHost } from "./FrameHost";
import { ExtIcon } from "./icons";
import { isSafeHref, isSafeImageSrc, sanitizeTree } from "./sanitize";
import { type RunContext, runUiAction, runCommand } from "./run";

// The minimap import is not used: it gives this chunk the same importer set as
// the chat chunks, so the bundler keeps markdown in their shared asset.
const MarkdownPreview = lazyWithReload("ext-markdown", () =>
  Promise.all([
    import("../components/markdown"),
    import("../components/ConversationMinimap"),
  ]).then(([module]) => ({ default: module.MarkdownPreview })),
);

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

/** Runs a handler with a pending state, and shows its error under the control. */
function usePending() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const run = (work: () => Promise<unknown>) => {
    setPending(true);
    setError("");
    work().then(
      () => setPending(false),
      (e) => {
        setPending(false);
        setError(errorText(e));
      },
    );
  };
  return { pending, error, run };
}

function ActionButton({
  el,
  ctx,
}: {
  el: Extract<El, { t: "Button" }>;
  ctx: RunContext;
}) {
  const { pending, error, run } = usePending();
  return (
    <span className="ext-action">
      <button
        type="button"
        className={`ext-button ext-tone-${el.tone ?? "neutral"}`}
        disabled={el.disabled || pending}
        aria-busy={pending || undefined}
        onClick={() =>
          run(() =>
            el.command
              ? runCommand(ctx, el.command)
              : runUiAction(ctx, el.id, true),
          )
        }
      >
        {el.icon ? <ExtIcon name={el.icon} /> : null}
        {pending ? "Working..." : el.label}
      </button>
      {error ? (
        <span className="ext-error" role="alert">
          {error}
        </span>
      ) : null}
    </span>
  );
}

function TextField({
  el,
  ctx,
}: {
  el: Extract<El, { t: "Input" | "TextArea" }>;
  ctx: RunContext;
}) {
  const [draft, setDraft] = useState(el.value);
  const { error, run } = usePending();
  const commit = () => {
    if (draft !== el.value) run(() => runUiAction(ctx, el.id, draft));
  };
  const common = {
    value: draft,
    placeholder: el.placeholder,
    "aria-label": el.placeholder ?? el.id,
    onChange: (event: { target: { value: string } }) =>
      setDraft(event.target.value),
    onBlur: commit,
  };
  return (
    <span className="ext-action">
      {el.t === "Input" ? (
        <input
          {...common}
          onKeyDown={(event) => {
            if (event.key === "Enter") commit();
          }}
        />
      ) : (
        <textarea {...common} />
      )}
      {error ? (
        <span className="ext-error" role="alert">
          {error}
        </span>
      ) : null}
    </span>
  );
}

function Node({ el, ctx }: { el: El; ctx: RunContext }) {
  const child = (item: El, index: number) => (
    <Node key={index} el={item} ctx={ctx} />
  );
  switch (el.t) {
    case "Stack":
    case "Row":
      return (
        <div className={`ext-el-${el.t.toLowerCase()} ext-gap-${el.gap ?? 1}`}>
          {el.children.map(child)}
        </div>
      );
    case "Text":
      return (
        <span
          className={`ext-text ext-tone-${el.tone ?? "neutral"}${
            el.weight === "strong" ? " ext-strong" : ""
          }${el.mono ? " ext-mono" : ""}`}
        >
          {el.text}
        </span>
      );
    case "Markdown":
      return (
        <Suspense fallback={<span className="ext-spinner" role="status" />}>
          <MarkdownPreview
            text={el.md}
            className="ext-markdown"
            imageUrlResolver={() => null}
          />
        </Suspense>
      );
    case "Code":
      return (
        <pre className="ext-code" data-lang={el.lang}>
          <code>{el.code}</code>
        </pre>
      );
    case "Badge":
      return (
        <span className={`badge ext-tone-${el.tone ?? "neutral"}`}>
          {el.text}
        </span>
      );
    case "Icon":
      return <ExtIcon name={el.name} />;
    case "Button":
      return <ActionButton el={el} ctx={ctx} />;
    case "Link":
      return isSafeHref(el.href) ? (
        <a href={el.href} target="_blank" rel="noopener noreferrer">
          {el.label || el.href}
        </a>
      ) : (
        <span className="ext-text">{el.label}</span>
      );
    case "Input":
    case "TextArea":
      return <TextField el={el} ctx={ctx} />;
    case "Select":
      return (
        <select
          aria-label={el.id}
          value={el.value}
          onChange={(event) =>
            void runUiAction(ctx, el.id, event.target.value).catch(() => {})
          }
        >
          {el.options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      );
    case "Toggle":
      return (
        <label className="ext-toggle">
          <input
            type="checkbox"
            checked={el.value}
            onChange={(event) =>
              void runUiAction(ctx, el.id, event.target.checked).catch(() => {})
            }
          />
          {el.label}
        </label>
      );
    case "Progress":
      return <progress value={el.value} max={1} />;
    case "Spinner":
      return (
        <span className="ext-spinner" role="status" aria-label="Loading" />
      );
    case "List":
      return (
        <ul className="ext-list">
          {el.items.map((item, index) => (
            <li key={index}>{child(item, index)}</li>
          ))}
        </ul>
      );
    case "Table":
      return (
        <table className="ext-table">
          <thead>
            <tr>
              {el.columns.map((column, index) => (
                <th key={index}>{column}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {el.rows.map((row, index) => (
              <tr key={index}>
                {row.map((cell, cellIndex) => (
                  <td key={cellIndex}>{child(cell, cellIndex)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      );
    case "KeyValue":
      return (
        <dl className="ext-keyvalue">
          {el.items.map((item, index) => (
            <div key={index}>
              <dt>{item.k}</dt>
              <dd>{child(item.v, 0)}</dd>
            </div>
          ))}
        </dl>
      );
    case "Divider":
      return <hr className="ext-divider" />;
    case "Image":
      return isSafeImageSrc(el.src, ctx.ext) ? (
        <img className="ext-image" src={el.src} alt={el.alt} />
      ) : (
        <span className="ext-text">{el.alt}</span>
      );
    case "Empty":
      return (
        <div className="ext-empty">
          <strong>{el.title}</strong>
          {el.body ? <span>{el.body}</span> : null}
        </div>
      );
    case "Frame":
      return <FrameHost ext={ctx.ext} frame={el.frame} height={el.height} />;
    default:
      return null;
  }
}

/** Renders one validated element tree; an invalid tree throws to the boundary. */
export function ElementRenderer({
  tree,
  ctx,
}: {
  tree: unknown;
  ctx: RunContext;
}) {
  const { tree: safe } = useMemo(() => sanitizeTree(tree), [tree]);
  return <Node el={safe} ctx={ctx} />;
}
