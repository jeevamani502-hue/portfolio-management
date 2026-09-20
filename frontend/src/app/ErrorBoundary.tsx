import { Component, type ReactNode, type ErrorInfo } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // In a real deployment this is where an error reporter would be called.
    // eslint-disable-next-line no-console
    console.error('Unhandled UI error', error, info.componentStack);
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="flex min-h-screen items-center justify-center bg-background p-6">
        <div className="max-w-md space-y-4 text-center">
          <AlertTriangle className="mx-auto h-10 w-10 text-destructive" aria-hidden />
          <h1 className="text-lg font-semibold">Something went wrong</h1>
          <p className="text-sm text-muted-foreground">
            The interface hit an unexpected error and stopped rendering rather than showing you
            something that might be wrong.
          </p>
          <pre className="max-h-40 overflow-auto rounded-md border border-border bg-muted/40 p-3 text-left text-2xs">
            {error.message}
          </pre>
          <div className="flex justify-center gap-2">
            <Button onClick={() => this.setState({ error: null })} variant="outline">
              Try again
            </Button>
            <Button onClick={() => window.location.reload()}>Reload</Button>
          </div>
        </div>
      </div>
    );
  }
}
