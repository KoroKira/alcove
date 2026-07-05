import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import './SearchDialog.scss';

interface SearchMatch {
  element_id: string;
  text: string;
  excerpt: string;
}

interface SearchResult {
  pad_id: string;
  pad_name: string;
  name_match: boolean;
  matches: SearchMatch[];
}

interface SearchDialogProps {
  onClose: () => void;
  onSelectPad: (padId: string) => void;
}

const SearchDialog: React.FC<SearchDialogProps> = ({ onClose, onSelectPad }) => {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onClose]);

  const search = useCallback(async (q: string) => {
    if (q.trim().length < 2) { setResults([]); return; }
    setLoading(true);
    try {
      const res = await fetch(`/api/pad/search?q=${encodeURIComponent(q)}`);
      if (res.ok) setResults(await res.json());
    } finally {
      setLoading(false);
    }
  }, []);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setQuery(val);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => search(val), 250);
  };

  return (
    <div className="search-overlay" onClick={onClose}>
      <div className="search-dialog" onClick={e => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="search-dialog__input"
          type="text"
          value={query}
          onChange={handleChange}
          placeholder={t('search.placeholder')}
        />
        <div className="search-dialog__results">
          {loading && <div className="search-dialog__loading">{t('search.loading')}</div>}
          {!loading && query.trim().length >= 2 && results.length === 0 && (
            <div className="search-dialog__empty">{t('search.noResults')}</div>
          )}
          {results.map(r => (
            <div key={r.pad_id} className="search-result">
              <button
                className="search-result__header"
                onClick={() => { onSelectPad(r.pad_id); onClose(); }}
              >
                <span className="search-result__name">{r.pad_name}</span>
                {r.name_match && <span className="search-result__badge">nom</span>}
              </button>
              {r.matches.map((m, i) => (
                <div key={i} className="search-result__match" onClick={() => { onSelectPad(r.pad_id); onClose(); }}>
                  "{m.excerpt}"
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

export default SearchDialog;
