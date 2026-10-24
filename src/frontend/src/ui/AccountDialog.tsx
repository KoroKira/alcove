import React, { useState, useCallback } from "react";
import { Dialog } from "@atyrode/excalidraw";
import md5 from 'crypto-js/md5';
import "./AccountDialog.scss";
import McpConnections from './McpConnections';

// Hooks
import { useAuthStatus } from "../hooks/useAuthStatus";

interface AccountDialogProps {
  excalidrawAPI?: any;
  onClose?: () => void;
}

// Function to generate gravatar URL
const getGravatarUrl = (email: string, size = 100) => {
  const hash = md5(email.toLowerCase().trim()).toString();
  return `https://www.gravatar.com/avatar/${hash}?s=${size}&d=identicon`;
};

const AccountDialog: React.FC<AccountDialogProps> = ({
  onClose,
}) => {
  const [modalIsShown, setModalIsShown] = useState(true);

  const { user: profile, isLoading, isError } = useAuthStatus();

  const handleClose = useCallback(() => {
    setModalIsShown(false);
    if (onClose) {
      onClose();
    }
  }, [onClose]);

  // Dialog content with user profile information
  const dialogContent = (
    <div className="account-dialog__content">
      {isLoading && (
        <div className="account-dialog__loading" role="status">
          Chargement du compte…
        </div>
      )}
      
      {isError && (
        <div className="account-dialog__error" role="alert">
          Impossible de charger le compte. Réessayez dans quelques instants.
        </div>
      )}
      {profile && !isLoading && !isError && <McpConnections />}
      
      {profile && !isLoading && !isError && (
        <div className="account-dialog__profile">
          <div className="account-dialog__avatar">
            <img 
              src={getGravatarUrl(profile.email)} 
              alt=""
              className="account-dialog__gravatar" 
            />
          </div>
          <div className="account-dialog__user-info">
            <h2 className="account-dialog__name">
              {profile.name || profile.username}
            </h2>
            <p className="account-dialog__username">{profile.username}</p>
            <p className="account-dialog__user-id">{profile.id}</p>
            <a href="/api/auth/account" target="_blank" rel="noreferrer">
              Gérer le profil et le mot de passe (nouvel onglet)
            </a>
            {profile.isAdmin && (
              <a href="/api/auth/admin" target="_blank" rel="noreferrer">
                Gérer les comptes utilisateurs (nouvel onglet)
              </a>
            )}
          </div>
        </div>
      )}
    </div>
  );

  return (
    <>
      {modalIsShown && (
        <div className="account-dialog__wrapper">
          <Dialog
            className="account-dialog"
            size="small"
            onCloseRequest={handleClose}
            title={
              <div className="account-dialog__title-container">
                <h2 className="account-dialog__title">Compte et connexions</h2>
              </div>
            }
            closeOnClickOutside={true}
            children={dialogContent}
          />
        </div>
      )}
    </>
  );
};

export default AccountDialog;
