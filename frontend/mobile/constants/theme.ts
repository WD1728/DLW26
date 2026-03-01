/**
 * Below are the colors that are used in the app. The colors are defined in the light and dark mode.
 * There are many other ways to style your app. For example, [Nativewind](https://www.nativewind.dev/), [Tamagui](https://tamagui.dev/), [unistyles](https://reactnativeunistyles.vercel.app), etc.
 */

import { Platform } from 'react-native';

export const SafeFlowPalette = {
  primary: '#2C5B82',
  primaryMid: '#367098',
  neutral: '#D4D7D1',
  accent: '#79BBCF',
  primaryDeep: '#183A4F',
};

const tintColorLight = SafeFlowPalette.primaryMid;
const tintColorDark = SafeFlowPalette.accent;

export const Colors = {
  light: {
    text: SafeFlowPalette.primaryDeep,
    background: SafeFlowPalette.neutral,
    tint: tintColorLight,
    icon: SafeFlowPalette.primary,
    tabIconDefault: SafeFlowPalette.primary,
    tabIconSelected: tintColorLight,
  },
  dark: {
    text: '#FFFFFF',
    background: SafeFlowPalette.primaryDeep,
    tint: tintColorDark,
    icon: SafeFlowPalette.accent,
    tabIconDefault: SafeFlowPalette.accent,
    tabIconSelected: tintColorDark,
  },
};

export const Fonts = Platform.select({
  ios: {
    /** iOS `UIFontDescriptorSystemDesignDefault` */
    sans: 'system-ui',
    /** iOS `UIFontDescriptorSystemDesignSerif` */
    serif: 'ui-serif',
    /** iOS `UIFontDescriptorSystemDesignRounded` */
    rounded: 'ui-rounded',
    /** iOS `UIFontDescriptorSystemDesignMonospaced` */
    mono: 'ui-monospace',
  },
  default: {
    sans: 'normal',
    serif: 'serif',
    rounded: 'normal',
    mono: 'monospace',
  },
  web: {
    sans: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
    serif: "Georgia, 'Times New Roman', serif",
    rounded: "'SF Pro Rounded', 'Hiragino Maru Gothic ProN', Meiryo, 'MS PGothic', sans-serif",
    mono: "SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
  },
});
