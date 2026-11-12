import { getTheme, type Theme, type ThemeName } from '@localvault/design-tokens';
import { createContext, type ReactNode, useContext, useMemo } from 'react';
import {
  type ImageStyle,
  StyleSheet,
  type TextStyle,
  useColorScheme,
  type ViewStyle,
} from 'react-native';

type NamedStyles<T> = { [P in keyof T]: ViewStyle | TextStyle | ImageStyle };

const ThemeContext = createContext<Theme>(getTheme('light'));

/** Light/dark follows the system setting. */
export function ThemeProvider({ children, force }: { children: ReactNode; force?: ThemeName }) {
  const scheme = useColorScheme();
  const name: ThemeName = force ?? (scheme === 'dark' ? 'dark' : 'light');
  const theme = useMemo(() => getTheme(name), [name]);
  return <ThemeContext.Provider value={theme}>{children}</ThemeContext.Provider>;
}

export function useTheme(): Theme {
  return useContext(ThemeContext);
}

/**
 * Typed, theme-aware stylesheet factory:
 *   const useStyles = makeStyles((t) => ({ box: { backgroundColor: t.color.surface } }));
 *   const s = useStyles();
 * Styles are recomputed only when the theme changes.
 */
export function makeStyles<T extends NamedStyles<T>>(
  // `& NamedStyles<any>` keeps literal types (flexDirection: 'row') contextually typed, like StyleSheet.create.
  // biome-ignore lint/suspicious/noExplicitAny: mirrors React Native's own StyleSheet.create signature
  factory: (theme: Theme) => T & NamedStyles<any>,
): () => T {
  const cache = new Map<string, T>();
  // biome-ignore lint/correctness/noComponentHookFactories: intentional style-hook factory (cached per theme)
  return function useStyles(): T {
    const theme = useTheme();
    const hit = cache.get(theme.name);
    if (hit !== undefined) return hit;
    const styles = StyleSheet.create(factory(theme)) as T;
    cache.set(theme.name, styles);
    return styles;
  };
}
