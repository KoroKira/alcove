import React from 'react';
import { Home, Search, MessageCircle, Network, GraduationCap, Bookmark, Plus, PanelLeft, Palette, Command, Link as LinkIcon } from 'lucide-react';
import './AppRail.scss';

type Destination = 'home' | 'search' | 'chat' | 'graph' | 'review' | 'favorites' | null;

interface Props {
  active: Destination;
  sidebarCollapsed: boolean;
  reviewCount?: number;
  onHome: () => void; onSearch: () => void; onChat: () => void;
  onGraph: () => void; onReview: () => void; onFavorites: () => void;
  onAdd: () => void; onToggleSidebar: () => void; onCommands: () => void; onTheme: () => void;
}

const AppRail: React.FC<Props> = ({ active, sidebarCollapsed, reviewCount = 0, onHome, onSearch, onChat, onGraph, onReview, onFavorites, onAdd, onToggleSidebar, onCommands, onTheme }) => {
  const item = (id: Exclude<Destination, null>, label: string, icon: React.ReactNode, onClick: () => void, badge?: number) => (
    <button className={`app-rail__item${active === id ? ' app-rail__item--active' : ''}`} onClick={onClick} title={label} aria-label={label} aria-current={active === id ? 'page' : undefined}>
      {icon}{badge ? <span className="app-rail__badge">{badge > 99 ? '99+' : badge}</span> : null}<span className="app-rail__tip">{label}</span>
    </button>
  );
  return (
    <nav className="app-rail" aria-label="Navigation principale">
      <div className="app-rail__brand" title="Alcove"><LinkIcon size={20} /></div>
      <button className="app-rail__add" onClick={onAdd} title="Ajouter à Alcove" aria-label="Ajouter à Alcove"><Plus size={21} /></button>
      <div className="app-rail__group">
        {item('home', 'Accueil', <Home size={19} />, onHome)}
        {item('search', 'Rechercher', <Search size={19} />, onSearch)}
        {item('chat', 'Assistant', <MessageCircle size={19} />, onChat)}
        {item('graph', 'Graphe', <Network size={19} />, onGraph)}
        {item('review', 'Révisions', <GraduationCap size={19} />, onReview, reviewCount)}
        {item('favorites', 'À lire / favoris', <Bookmark size={19} />, onFavorites)}
      </div>
      <div className="app-rail__spacer" />
      <button className={`app-rail__item${sidebarCollapsed ? '' : ' app-rail__item--active'}`} onClick={onToggleSidebar} title="Afficher les fichiers" aria-label="Afficher les fichiers"><PanelLeft size={19} /><span className="app-rail__tip">Fichiers</span></button>
      <button className="app-rail__item" onClick={onCommands} title="Outils et commandes" aria-label="Outils et commandes"><Command size={19} /><span className="app-rail__tip">Outils</span></button>
      <button className="app-rail__item" onClick={onTheme} title="Apparence" aria-label="Apparence"><Palette size={19} /><span className="app-rail__tip">Apparence</span></button>
    </nav>
  );
};
export default AppRail;
