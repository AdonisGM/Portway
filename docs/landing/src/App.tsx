import { useState, type CSSProperties, type MouseEvent, type ReactNode } from 'react';
import {
  ArrowLeftRight,
  ArrowRight,
  BookOpen,
  Download,
  EyeOff,
  FileInput,
  Languages,
  Laptop,
  Lock,
  Monitor,
  Moon,
  Route,
  ScrollText,
  ShieldCheck,
  SquareTerminal,
  Sun,
  Users,
  KeyRound,
  type LucideIcon,
} from 'lucide-react';
import { GITHUB, RELEASES, copy, docsUrl, homeUrl, type Lang, type TileId } from './content';
import shots from './shots.generated.json';
import { Reveal } from './ui';

type ShotName = keyof typeof shots;

/** Layout of the feature grid: each tile spans some of 12 columns and shows one real screenshot. */
const TILES: { id: TileId; span: number }[] = [
  { id: 'tunnel', span: 8 },
  { id: 'files', span: 4 },
  { id: 'nginx', span: 8 },
  { id: 'docker', span: 4 },
  { id: 'firewall', span: 7 },
  { id: 'services', span: 5 },
  { id: 'http', span: 12 },
  { id: 'connect', span: 12 },
];

const ICONS: Record<string, LucideIcon> = {
  route: Route,
  shield: ShieldCheck,
  import: FileInput,
  arrows: ArrowLeftRight,
  terminal: SquareTerminal,
  tail: ScrollText,
  users: Users,
  moon: Moon,
  key: KeyRound,
  lock: Lock,
  eye: EyeOff,
};

/** Renders `code` spans inside copy strings. */
function Rich({ text }: { text: string }) {
  return (
    <>
      {text.split('`').map((part, i) => (i % 2 ? <code key={i}>{part}</code> : <span key={i}>{part}</span>))}
    </>
  );
}

function GithubMark({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.1.79-.25.79-.56v-2c-3.2.7-3.87-1.54-3.87-1.54-.52-1.33-1.28-1.69-1.28-1.69-1.05-.71.08-.7.08-.7 1.15.08 1.76 1.19 1.76 1.19 1.03 1.76 2.69 1.25 3.35.96.1-.74.4-1.25.73-1.54-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.28 1.19-3.09-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.17 1.18a11 11 0 0 1 5.78 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.83 1.19 3.09 0 4.42-2.69 5.39-5.25 5.68.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56A11.5 11.5 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5Z" />
    </svg>
  );
}

function Shot({ lang, name, alt }: { lang: Lang; name: ShotName; alt: string }) {
  const { width, height } = shots[name];
  return <img src={`/shots/${lang}/${name}.webp`} alt={alt} width={width} height={height} loading="lazy" decoding="async" style={{ maxWidth: width }} />;
}

function Header({ lang }: { lang: Lang }) {
  const c = copy[lang];
  const other: Lang = lang === 'vi' ? 'en' : 'vi';
  const toggleTheme = () => {
    const d = document.documentElement;
    const next = d.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
    d.setAttribute('data-theme', next);
    try {
      localStorage.setItem('pw-theme', next);
    } catch {
      /* private mode: the choice just is not remembered */
    }
  };
  return (
    <header className="nav">
      <div className="wrap nav-in">
        <a href={homeUrl(lang)} className="brand" aria-label="Portway">
          <span className="brand-mark" aria-hidden="true" />
          Portway
        </a>
        <nav className="nav-links" aria-label="Primary">
          <a href="#features">{c.nav.features}</a>
          <a href="#details">{c.nav.details}</a>
          <a href="#security">{c.nav.security}</a>
          <a href="#download">{c.nav.download}</a>
          <a href={docsUrl(lang)}>{c.nav.docs}</a>
        </nav>
        <div className="nav-actions">
          <a className="icon-btn" href={homeUrl(other)} hrefLang={other} aria-label={c.nav.language} title={c.nav.language}>
            <Languages size={17} />
            <span className="lang-code">{other.toUpperCase()}</span>
          </a>
          <button type="button" className="icon-btn" onClick={toggleTheme} aria-label={c.nav.theme} title={c.nav.theme}>
            <Sun size={17} className="ic-sun" />
            <Moon size={17} className="ic-moon" />
          </button>
          <a className="icon-btn" href={GITHUB} aria-label="GitHub" title="GitHub" target="_blank" rel="noreferrer">
            <GithubMark />
          </a>
        </div>
      </div>
    </header>
  );
}

function Tilt({ children }: { children: ReactNode }) {
  const [style, setStyle] = useState<CSSProperties>({});
  const move = (e: MouseEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width - 0.5;
    const y = (e.clientY - r.top) / r.height - 0.5;
    setStyle({ '--rx': `${(-y * 4).toFixed(2)}deg`, '--ry': `${(x * 6).toFixed(2)}deg` } as CSSProperties);
  };
  return (
    <div className="tilt" style={style} onMouseMove={move} onMouseLeave={() => setStyle({})}>
      {children}
    </div>
  );
}

function Hero({ lang }: { lang: Lang }) {
  const c = copy[lang];
  return (
    <section className="hero">
      <div className="wrap hero-in">
        <a className="badge" href="#features">
          <span className="badge-dot" />
          {c.hero.badge}
          <ArrowRight size={14} />
        </a>
        <h1>
          <span>{c.hero.title[0]}</span>
          <span className="grad">{c.hero.title[1]}</span>
        </h1>
        <p className="lead">{c.hero.sub}</p>
        <div className="cta">
          <a className="btn primary" href={RELEASES} target="_blank" rel="noreferrer">
            <Download size={17} /> {c.hero.primary}
          </a>
          <a className="btn" href={docsUrl(lang)}>
            <BookOpen size={17} /> {c.hero.secondary}
          </a>
          <a className="btn ghost" href={GITHUB} target="_blank" rel="noreferrer">
            <GithubMark size={17} /> {c.hero.github}
          </a>
        </div>
        <p className="note">{c.hero.note}</p>
      </div>
      <div className="wrap stage">
        <Tilt>
          <div className="hero-shot">
            <img src={`/shots/${lang}/hero.webp`} alt={c.hero.alt} width={shots.hero.width} height={shots.hero.height} decoding="async" fetchPriority="high" />
          </div>
        </Tilt>
      </div>
      <div className="wrap stats">
        {c.stats.map((s) => (
          <div key={s.label} className="stat-big">
            <b>{s.value}</b>
            <span>{s.label}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

function Features({ lang }: { lang: Lang }) {
  const c = copy[lang].showcase;
  return (
    <section id="features" className="section">
      <div className="wrap">
        <Reveal>
          <p className="eyebrow">{c.eyebrow}</p>
          <h2>{c.title}</h2>
          <p className="sub">{c.sub}</p>
        </Reveal>
        <div className="bento">
          {TILES.map((t, i) => {
            const text = c.tiles[t.id];
            return (
              <Reveal key={t.id} delay={(i % 2) * 70} className={`span-${t.span}`}>
                <article className="tile">
                  <div className="tile-shot">
                    <Shot lang={lang} name={t.id} alt={`${text.title} (${c.shot})`} />
                  </div>
                  <div className="tile-copy">
                    <h3>{text.title}</h3>
                    <p>
                      <Rich text={text.text} />
                    </p>
                  </div>
                </article>
              </Reveal>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function Details({ lang }: { lang: Lang }) {
  const c = copy[lang].details;
  return (
    <section id="details" className="section tight">
      <div className="wrap">
        <Reveal>
          <p className="eyebrow">{c.eyebrow}</p>
          <h2>{c.title}</h2>
        </Reveal>
        <Reveal delay={60}>
          <ul className="detail-list">
            {c.items.map((it) => {
              const Icon = ICONS[it.icon] ?? Route;
              return (
                <li key={it.title}>
                  <span className="mini-ic">
                    <Icon size={18} />
                  </span>
                  <div>
                    <b>{it.title}</b>
                    <p>
                      <Rich text={it.text} />
                    </p>
                  </div>
                </li>
              );
            })}
          </ul>
        </Reveal>
      </div>
    </section>
  );
}

function Trust({ lang }: { lang: Lang }) {
  const c = copy[lang].trust;
  return (
    <section id="security" className="section">
      <div className="wrap">
        <Reveal>
          <p className="eyebrow">{c.eyebrow}</p>
          <h2>{c.title}</h2>
          <p className="sub">
            <Rich text={c.text} />
          </p>
        </Reveal>
        <Reveal delay={60}>
          <ul className="points">
            {c.points.map((pt) => {
              const Icon = ICONS[pt.icon] ?? Lock;
              return (
                <li key={pt.title}>
                  <span className="mini-ic">
                    <Icon size={18} />
                  </span>
                  <div>
                    <b>{pt.title}</b>
                    <p>{pt.text}</p>
                  </div>
                </li>
              );
            })}
          </ul>
        </Reveal>
      </div>
    </section>
  );
}

function DownloadSection({ lang }: { lang: Lang }) {
  const c = copy[lang].download;
  return (
    <section id="download" className="section">
      <div className="wrap">
        <Reveal>
          <div className="dl">
            <p className="eyebrow">{c.eyebrow}</p>
            <h2>{c.title}</h2>
            <p className="sub">{c.sub}</p>
            <div className="dl-cards">
              {[
                { Icon: Laptop, ...c.mac },
                { Icon: Monitor, ...c.win },
              ].map(({ Icon, name, req }) => (
                <a key={name} className="dl-card" href={RELEASES} target="_blank" rel="noreferrer">
                  <Icon size={28} />
                  <div>
                    <b>{name}</b>
                    <span>{req}</span>
                  </div>
                  <span className="btn primary small">
                    <Download size={15} /> {c.button}
                  </span>
                </a>
              ))}
            </div>
            <p className="note">
              {c.server} ·{' '}
              <a href={GITHUB} target="_blank" rel="noreferrer">
                {c.source}
              </a>
            </p>
          </div>
        </Reveal>
      </div>
    </section>
  );
}

function Footer({ lang }: { lang: Lang }) {
  const c = copy[lang].footer;
  return (
    <footer className="foot">
      <div className="wrap foot-in">
        <div>
          <a href={homeUrl(lang)} className="brand">
            <span className="brand-mark" aria-hidden="true" />
            Portway
          </a>
          <p>{c.tagline}</p>
        </div>
        <nav aria-label="Footer">
          <a href={docsUrl(lang)}>{c.guide}</a>
          <a href={GITHUB} target="_blank" rel="noreferrer">
            {c.source}
          </a>
          <a href={`${GITHUB}/issues`} target="_blank" rel="noreferrer">
            {c.issues}
          </a>
        </nav>
        <span className="ver mono">
          {c.version} {__APP_VERSION__}
        </span>
      </div>
    </footer>
  );
}

export function App({ lang }: { lang: Lang }) {
  return (
    <>
      <div className="bg" aria-hidden="true" />
      <Header lang={lang} />
      <main>
        <Hero lang={lang} />
        <Features lang={lang} />
        <Details lang={lang} />
        <Trust lang={lang} />
        <DownloadSection lang={lang} />
      </main>
      <Footer lang={lang} />
    </>
  );
}
