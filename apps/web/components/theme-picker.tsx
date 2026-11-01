import { Check, ChevronDown, Palette } from 'lucide-react';
import { useCallback, useRef, useState, type KeyboardEvent } from 'react';
import { themes, type ThemeId } from '../lib/theme';
import { useTheme } from './theme-provider';
import { Modal } from './ui';

function ThemeScene({ theme }: { theme: ThemeId }) {
  return <span className={`theme-scene theme-scene-${theme}`} aria-hidden="true">
    <span className="theme-scene-wordmark">oneshot</span>
    {theme === 'original' && <><span className="scene-orbit scene-orbit-one" /><span className="scene-orbit scene-orbit-two" /><span className="scene-orbit scene-orbit-three" /><span className="scene-message">Original</span></>}
    {theme === 'onyx' && <><span className="scene-dial"><i /><i /><i /><i /></span><span className="scene-message">Onyx</span></>}
    {theme === 'champagne' && <><span className="scene-paper-ring" /><span className="scene-paper-ring scene-paper-ring-two" /><span className="scene-message">Champagne</span></>}
    {theme === 'vice' && <><span className="scene-sun" /><svg className="scene-palms" viewBox="0 0 180 160" fill="currentColor"><path d="M126 163c-4-43-5-74 4-110l7 1c-7 39-5 72 2 109z" /><path d="M132 53C108 29 90 35 80 50c19-6 34-2 47 9-26-7-44 2-49 21 18-12 33-15 50-19-17 16-19 34-12 49 3-19 7-30 17-49 7 19 20 26 35 26-15-11-22-19-30-29 17 5 29 5 42-3-18-7-29-8-42-4 14-15 19-30 15-44-13 12-20 24-21 46z" /><path d="M169 164c-1-22 2-42 8-60l4 1c-3 23-2 39 2 59zM178 105c-17-18-29-16-38-6 14-1 23 2 34 9-18-1-29 6-32 19 13-8 23-12 34-15-8 12-8 22-3 32 1-14 2-22 6-31 8 9 17 13 28 11-12-7-19-12-24-17 13 1 23-2 29-9-15-3-24-1-31 5 6-12 6-22 2-31-6 10-7 21-5 33z" /></svg><span className="scene-message">Vice</span></>}
  </span>;
}

export function ThemePicker() {
  const { theme, currentTheme, setTheme, preferenceSaved } = useTheme();
  const [open, setOpen] = useState(false);
  const cards = useRef<(HTMLButtonElement | null)[]>([]);
  const close = useCallback(() => setOpen(false), []);

  function navigate(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    let next: number;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (index + 1) % themes.length;
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = (index + themes.length - 1) % themes.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = themes.length - 1;
    else return;
    event.preventDefault();
    setTheme(themes[next].id);
    cards.current[next]?.focus();
  }

  return <>
    <button className="appearance-trigger" type="button" onClick={() => { setTheme(theme); setOpen(true); }} aria-label={`Change appearance, current theme: ${currentTheme.name}`} aria-haspopup="dialog" aria-expanded={open} title="Change appearance">
      <Palette size={15} strokeWidth={1.7} /><span>Appearance</span><span className={`appearance-swatch appearance-swatch-${theme}`} aria-hidden="true" /><ChevronDown className="appearance-chevron" size={12} />
    </button>
    {open && <Modal className="theme-dialog" title="Appearance" description="Choose a theme for this device." onClose={close}>
      <div className="theme-studio">
        <div className="theme-options" role="radiogroup" aria-label="Appearance">
          {themes.map((option, index) => <button ref={element => { cards.current[index] = element; }} key={option.id} type="button" role="radio" aria-checked={theme === option.id} aria-label={option.name} aria-describedby={`theme-description-${option.id}`} tabIndex={theme === option.id ? 0 : -1} className={`theme-option ${theme === option.id ? 'theme-option-selected' : ''}`} onClick={() => setTheme(option.id)} onKeyDown={event => navigate(event, index)}>
            <ThemeScene theme={option.id} />
            <span className="theme-option-details"><span className="theme-option-title">{option.name}<span className="theme-option-check" aria-hidden="true">{theme === option.id && <Check size={12} strokeWidth={2.5} />}</span></span><span className="theme-option-description" id={`theme-description-${option.id}`}>{option.description}</span><span className="theme-option-palette" aria-hidden="true">{option.colors.map(color => <i key={color} style={{ backgroundColor: color }} />)}</span></span>
          </button>)}
        </div>
        <div className="theme-studio-footer"><div role="status" aria-live="polite"><Check size={14} /><span><strong>{currentTheme.name}</strong> applied<small>{preferenceSaved ? 'Your choice is saved on this device.' : 'Active for this visit. Browser storage is unavailable.'}</small></span></div><button className="button button-secondary" type="button" onClick={close}>Done <Check size={14} /></button></div>
      </div>
    </Modal>}
  </>;
}
