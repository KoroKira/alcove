import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Trash2 } from 'lucide-react';
import { DOCUMENT_TEMPLATES, type DocumentTemplate } from '../constants/documentTemplates';
import { loadUserTemplates, deleteUserTemplate, type UserDocTemplate } from '../constants/userTemplates';
import './DocumentTemplateDialog.scss';

interface Props {
  onSelect: (template: DocumentTemplate) => void;
  onSelectUser?: (template: UserDocTemplate) => void;
  onClose: () => void;
}

const DocumentTemplateDialog: React.FC<Props> = ({ onSelect, onSelectUser, onClose }) => {
  const { t } = useTranslation();
  const overlayRef = useRef<HTMLDivElement>(null);
  const [userTpls, setUserTpls] = useState<UserDocTemplate[]>(loadUserTemplates);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  const handleDeleteUser = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    deleteUserTemplate(id);
    setUserTpls(loadUserTemplates());
  };

  const handleSelectUser = (tpl: UserDocTemplate) => {
    if (onSelectUser) {
      onSelectUser(tpl);
    } else {
      // Adapter: convert UserDocTemplate to DocumentTemplate shape
      onSelect({
        id: tpl.id,
        icon: tpl.icon,
        titleKey: tpl.title,
        descKey: tpl.createdAt.slice(0, 10),
        content: () => tpl.content,
      });
    }
  };

  return (
    <div
      className="doc-tmpl-overlay"
      ref={overlayRef}
      onClick={e => { if (e.target === overlayRef.current) onClose(); }}
    >
      <div className="doc-tmpl">
        <div className="doc-tmpl__header">
          <h2 className="doc-tmpl__title">{t('templates.title')}</h2>
          <p className="doc-tmpl__subtitle">{t('templates.subtitle')}</p>
        </div>

        {/* Built-in templates */}
        <div className="doc-tmpl__grid">
          {DOCUMENT_TEMPLATES.map(tmpl => (
            <button key={tmpl.id} className="doc-tmpl__card" onClick={() => onSelect(tmpl)}>
              <span className="doc-tmpl__card-icon">{tmpl.icon}</span>
              <span className="doc-tmpl__card-title">{t(tmpl.titleKey)}</span>
              <span className="doc-tmpl__card-desc">{t(tmpl.descKey)}</span>
            </button>
          ))}
        </div>

        {/* User templates */}
        {userTpls.length > 0 && (
          <>
            <p className="doc-tmpl__section-label">Mes templates</p>
            <div className="doc-tmpl__grid">
              {userTpls.map(tpl => (
                <button
                  key={tpl.id}
                  className="doc-tmpl__card doc-tmpl__card--user"
                  onClick={() => handleSelectUser(tpl)}
                >
                  <span className="doc-tmpl__card-icon">{tpl.icon}</span>
                  <span className="doc-tmpl__card-title">{tpl.title}</span>
                  <span className="doc-tmpl__card-desc">{tpl.createdAt.slice(0, 10)}</span>
                  <button
                    className="doc-tmpl__card-del"
                    onClick={e => handleDeleteUser(e, tpl.id)}
                    title="Supprimer ce template"
                  >
                    <Trash2 size={12} />
                  </button>
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
};

export default DocumentTemplateDialog;
