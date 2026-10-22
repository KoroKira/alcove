import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import './SearchDialog.scss';
import { apiV1, type ApiSearchResult } from '../api/client';

type SearchResult = ApiSearchResult;

interface SearchDialogProps {
  onClose: () => void;
  onSelectPad: (padId: string) => void;
}

const SearchDialog: React.FC<SearchDialogProps> = ({ onClose, onSelectPad }) => {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestIdRef = useRef(0);

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

  useEffect(() => () => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    requestIdRef.current += 1;
  }, []);

  const search = useCallback(async (q: string, requestId: number) => {
    if (q.trim().length < 2) {
      setResults([]);
      setError(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const next = await apiV1.search(q);
      if (requestId === requestIdRef.current) setResults(next);
    } catch {
      if (requestId === requestIdRef.current) {
        setResults([]);
        setError('Recherche indisponible pour le moment. Réessaie.');
      }
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  }, []);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setQuery(val);
    const requestId = ++requestIdRef.current;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (val.trim().length < 2) {
      setResults([]);
      setError(null);
      setLoading(false);
      return;
    }
    setError(null);
    setLoading(true);
    setResults([]);
    debounceRef.current = setTimeout(() => search(val, requestId), 250);
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
          {error && <div className="search-dialog__error" role="alert">{error}</div>}
          {!loading && !error && query.trim().length >= 2 && results.length === 0 && (
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
