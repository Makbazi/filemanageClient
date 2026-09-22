// 主题注册与切换（需求5）：预置 5 套主题，设置里选择，data-theme 属性驱动 CSS 变量。

export interface ThemeMeta {
  id: string;
  name: string;
  /** 预览色板（设置页展示） */
  swatch: [string, string, string];
}

export const THEMES: ThemeMeta[] = [
  { id: "dark-glass", name: "深色玻璃", swatch: ["#0b0e14", "#6c7bff", "#9a6cff"] },
  { id: "light", name: "浅色简洁", swatch: ["#f5f7fb", "#4f6ef7", "#7c5cf0"] },
  { id: "nord", name: "Nord 极地", swatch: ["#2e3440", "#88c0d0", "#81a1c1"] },
  { id: "dracula", name: "Dracula", swatch: ["#282a36", "#bd93f9", "#ff79c6"] },
  { id: "ocean", name: "海洋蓝", swatch: ["#0a192f", "#38bdf8", "#0ea5e9"] },
];

export const DEFAULT_THEME = "dark-glass";

export function applyTheme(id: string) {
  const valid = THEMES.some((t) => t.id === id) ? id : DEFAULT_THEME;
  document.documentElement.dataset.theme = valid;
}
