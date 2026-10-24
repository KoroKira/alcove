import React from 'react';

interface Props {
  children: React.ReactNode;
  onOpenLibrary: () => void;
}

interface State {
  error: Error | null;
  componentStack: string | null;
  mountKey: number;
}

/** Keep canvas render failures local so the app navigation remains available. */
export default class CanvasErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null, componentStack: null, mountKey: 0 };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[alcove] Canvas render error:', error, info.componentStack);
    this.setState({ componentStack: info.componentStack ?? null });
  }

  private retryCanvas = () => {
    this.setState(state => ({
      error: null,
      componentStack: null,
      mountKey: state.mountKey + 1,
    }));
  };

  render() {
    const { error, componentStack, mountKey } = this.state;
    if (error) {
      return (
        <section className="canvas-error" role="alert" aria-labelledby="canvas-error-title">
          <div className="canvas-error__card">
            <div className="canvas-error__mark" aria-hidden="true">😵</div>
            <h1 id="canvas-error-title">Le canevas ne peut pas s’afficher</h1>
            <p>
              La navigation reste disponible. Réessaie de charger ce canevas ou
              ouvre l’accueil pour continuer avec un autre pad. Les dernières
              modifications peuvent ne pas avoir été enregistrées.
            </p>
            <details>
              <summary>Détail technique</summary>
              <pre>{error.message}{componentStack ? `\n${componentStack.trim()}` : ''}</pre>
            </details>
            <div className="canvas-error__actions">
              <button type="button" onClick={this.retryCanvas}>Réessayer le canevas</button>
              <button type="button" onClick={this.props.onOpenLibrary}>Ouvrir l’accueil</button>
            </div>
          </div>
        </section>
      );
    }

    return <React.Fragment key={mountKey}>{this.props.children}</React.Fragment>;
  }
}
