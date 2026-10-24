import React from 'react';

interface Props {
  children: React.ReactNode;
}

interface State {
  error: Error | null;
  info: string | null;
}

/**
 * App-wide crash barrier for failures outside the isolated canvas. Canvas
 * errors are handled by CanvasErrorBoundary so global navigation can remain.
 */
export default class ErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { error: null, info: null };
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // Keep the console trail for debugging; also stash the component stack.
    console.error('[alcove] Uncaught render error:', error, info.componentStack);
    this.setState({ info: info.componentStack ?? null });
  }

  private handleReload = () => window.location.reload();

  render() {
    const { error, info } = this.state;
    if (!error) return this.props.children;

    return (
      <div
        role="alert"
        style={{
          position: 'fixed',
          inset: 0,
          zIndex: 100000,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 24,
          background: 'var(--ap-bg0, #1e1e2e)',
          color: 'var(--ap-text0, #cdd6f4)',
          fontFamily: 'var(--ap-font-ui, sans-serif)',
        }}
      >
        <div
          style={{
            maxWidth: 620,
            width: '100%',
            background: 'var(--ap-bg1, #181825)',
            border: '1px solid var(--ap-bg3, #45475a)',
            borderRadius: 'var(--ap-radius-lg, 12px)',
            padding: '28px 28px 24px',
            boxShadow: 'var(--ap-shadow-lg, 0 12px 48px rgba(0,0,0,0.5))',
          }}
        >
          <div style={{ fontSize: 40, lineHeight: 1, marginBottom: 12 }}>😵</div>
          <h1 style={{ fontSize: 18, margin: '0 0 8px' }}>
            Une erreur a interrompu l'affichage
          </h1>
          <p style={{ fontSize: 13, color: 'var(--ap-text2, #a6adc8)', margin: '0 0 16px' }}>
            Recharge la page pour reprendre. Les dernières modifications peuvent
            ne pas avoir été enregistrées ; vérifie leur état après le rechargement.
          </p>

          <pre
            style={{
              background: 'var(--ap-bg0, #1e1e2e)',
              border: '1px solid var(--ap-bg2, #313244)',
              borderRadius: 'var(--ap-radius-sm, 6px)',
              padding: '10px 12px',
              fontSize: 11.5,
              fontFamily: 'var(--ap-font-mono, monospace)',
              color: 'var(--ap-red, #f38ba8)',
              maxHeight: 200,
              overflow: 'auto',
              margin: '0 0 18px',
              whiteSpace: 'pre-wrap',
            }}
          >
            {error.message}
            {info ? `\n${info.trim()}` : ''}
          </pre>

          <div style={{ display: 'flex', gap: 10 }}>
            <button
              onClick={this.handleReload}
              style={{
                background: 'var(--ap-accent, #cba6f7)',
                color: 'var(--ap-bg0, #1e1e2e)',
                border: 'none',
                borderRadius: 'var(--ap-radius-sm, 6px)',
                padding: '8px 18px',
                fontSize: 13,
                fontWeight: 600,
                cursor: 'pointer',
                fontFamily: 'inherit',
              }}
            >
              Recharger la page
            </button>
          </div>
        </div>
      </div>
    );
  }
}
