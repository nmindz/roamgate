import { Component, type ReactNode } from "react";

export class ExtensionErrorBoundary extends Component<
  { ext: string; children: ReactNode },
  { error: string | null }
> {
  state = { error: null as string | null };

  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error.message : String(error) };
  }

  render() {
    if (this.state.error === null) return this.props.children;
    return (
      <p className="ext-error" role="alert">
        {this.props.ext} failed to render: {this.state.error}
      </p>
    );
  }
}
