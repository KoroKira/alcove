import React, { useMemo, useEffect, useState } from "react";

import { Dialog } from "@atyrode/excalidraw";

import { capture } from "../lib/posthog";
import { useAppConfig } from "../hooks/useAppConfig";
import "./AuthDialog.scss";


interface AuthDialogProps {
  description?: React.ReactNode;
  warningText?: React.ReactNode;
  children?: React.ReactNode;
}

export const AuthDialog = ({
  description = <>Welcome to your <strong className="highlight">whiteboard IDE</strong>. <br /><br /> Open <strong className="highlight">terminals</strong>, <strong className="highlight">VSCode</strong>, or <strong className="highlight">Cursor</strong> in your pad, and start coding right away.</>,
  warningText = <>This is an open-source project in beta.<br /> Back up your work!</>,
  children,
}: AuthDialogProps) => {
  const { config } = useAppConfig();
  const [authError, setAuthError] = useState(false);
  const logoMessages = [
    "Hello there!",
    "Welcome to Alcove!",
    "Ready to code?",
    "Let's build something cool!",
    "Code, collaborate, create!",
    "Happy coding!",
    "Ideas become reality here!",
    "Let's get productive!",
    "Let's turn ideas into code!"
  ];

  const randomMessage = useMemo(() =>
    logoMessages[Math.floor(Math.random() * logoMessages.length)],
    []
  );

  useEffect(() => {
    capture("auth_modal_shown");
    
    // Load GitHub buttons script
    const script = document.createElement('script');
    script.src = 'https://buttons.github.io/buttons.js';
    script.async = true;
    script.defer = true;
    document.body.appendChild(script);
    
    return () => {
      // Clean up script when component unmounts
      if (document.body.contains(script)) {
        document.body.removeChild(script);
      }
    };
  }, []);

  useEffect(() => {
    const url = new URL(window.location.href);
    if (url.searchParams.get("auth_error") !== "state") return;

    setAuthError(true);
    url.searchParams.delete("auth_error");
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  }, []);

  const dialogContent = (
    <div className="auth-modal__content">
      <p className="auth-modal__description">{description}</p>

      <div className="auth-modal__buttons">
        {authError && (
          <p role="alert">
            La connexion a expiré ou a déjà été utilisée. Relancez-la avec le bouton ci-dessous.
          </p>
        )}
        <button onClick={() => window.open("/api/auth/login?popup=1", "authPopup", "width=520,height=720")}>
          <span>Se connecter</span>
        </button>
        {config?.registrationContactEmail && (
          <p className="auth-modal__registration-contact">
            Pour demander un compte, envoyez un message à{' '}
            <a href={`mailto:${config.registrationContactEmail}`}>
              {config.registrationContactEmail}
            </a>.
          </p>
        )}
      </div>

      <div className="auth-modal__footer">
        <div className="auth-modal__warning">
          {warningText}
        </div>

        {/* GitHub Star button */}
        <a className="github-button"
           href="https://github.com/KoroKira/alcove"
           data-color-scheme="no-preference: dark_dimmed; light: dark_dimmed; dark: dark_dimmed;"
           data-icon="octicon-star"
           data-size="large"
           data-show-count="true"
           aria-label="Star KoroKira/alcove on GitHub">
          Star
        </a>
      </div>
    </div>
  );

  return (
    <div className="auth-modal__wrapper">
      <div className="auth-modal__logo-container">
        <img src="/assets/images/favicon.png" alt="Alcove logo" className="auth-modal__logo" />
        <div className="auth-modal__logo-speech-bubble">{randomMessage}</div>
      </div>
      <Dialog
        className="auth-modal"
        size="small"
        onCloseRequest={() => { }}
        title={
          <div id="modal-title" className="auth-modal__title-container">
            <h2 className="auth-modal__title">pad<span className="auth-modal__title-dot">.ws</span></h2>
          </div>
        }
        closeOnClickOutside={false}
        children={children || dialogContent}
      />
    </div>
  );
};

export default AuthDialog;
