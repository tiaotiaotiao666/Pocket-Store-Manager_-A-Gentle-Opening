import themeDoc from '../../templates/base/ordering-base/1.0.0/theme.tokens.json' with { type: 'json' };

const STYLE_TO_PRESET = {
  warm: 'warm-orange',
  fresh: 'deep-green',
  minimal: 'ink-blue',
  night: 'night-neon',
};

export const THEME_PRESETS = themeDoc.presets.map((preset) => ({
  id: preset.id,
  name: preset.name,
  tokens: { ...preset.tokens },
}));

export function resolveThemeTokens(styleId) {
  const presetId = STYLE_TO_PRESET[styleId] || 'warm-orange';
  const preset = THEME_PRESETS.find((item) => item.id === presetId) || THEME_PRESETS[0];
  return {
    presetId: preset.id,
    presetName: preset.name,
    tokens: { ...preset.tokens },
    fallback: !STYLE_TO_PRESET[styleId],
  };
}

export function listThemePresets() {
  return THEME_PRESETS.map((preset) => ({ id: preset.id, name: preset.name }));
}