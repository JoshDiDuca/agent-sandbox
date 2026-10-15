// Dark or light follows the operating system (Bootstrap's data-bs-theme).
export type Theme = 'dark' | 'light';

const query = window.matchMedia('(prefers-color-scheme: dark)');

export function currentTheme(): Theme {
  return query.matches ? 'dark' : 'light';
}

export function followSystemTheme(onChange: (theme: Theme) => void = () => undefined): void {
  const apply = (): void => {
    document.documentElement.setAttribute('data-bs-theme', currentTheme());
    onChange(currentTheme());
  };
  apply();
  query.addEventListener('change', apply);
}
