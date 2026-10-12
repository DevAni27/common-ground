import { useEffect, useState } from 'react';
import { CreatePage } from './pages/CreatePage.tsx';
import { LandingPage } from './pages/LandingPage.tsx';
import { JoinPage } from './pages/JoinPage.tsx';
import { OutingPage } from './pages/OutingPage.tsx';
import { CardPage } from './pages/CardPage.tsx';
import { Shell } from './ui.tsx';

function usePath() {
  const [path, setPath] = useState(window.location.pathname);
  useEffect(() => {
    const on = () => { setPath(window.location.pathname); window.scrollTo(0, 0); };
    window.addEventListener('popstate', on);
    return () => window.removeEventListener('popstate', on);
  }, []);
  return path;
}

export function App() {
  const path = usePath();
  const m = /^\/o\/([a-z0-9]{8,40})(?:\/(join|card))?\/?$/.exec(path);
  if (path === '/' || path === '') return <LandingPage />;
  if (path === '/new') return <CreatePage />;
  if (m && m[2] === 'join') return <JoinPage outingId={m[1]!} />;
  if (m && m[2] === 'card') return <CardPage outingId={m[1]!} />;
  if (m) return <OutingPage outingId={m[1]!} />;
  return <Shell><h1 className="mt-6 font-display text-3xl font-bold">Page not found</h1><p className="mt-2"><a className="font-bold text-leaf underline" href="/">Go to the home page</a></p></Shell>;
}
