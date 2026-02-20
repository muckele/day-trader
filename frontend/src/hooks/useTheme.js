import { useEffect, useState } from 'react';

const STORAGE_KEY = 'daytrader-theme';

export function useTheme() {
  const [theme, setTheme] = useState('dark');

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, 'dark');
    setTheme('dark');
    document.documentElement.classList.add('dark');
  }, []);

  const toggleTheme = () => {
    localStorage.setItem(STORAGE_KEY, 'dark');
    setTheme('dark');
    document.documentElement.classList.add('dark');
  };

  return { theme, toggleTheme };
}
