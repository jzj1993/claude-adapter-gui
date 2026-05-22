/*
文件说明: 提供项目标识的 SVG 片段与完整 SVG 生成函数，供主进程托盘图标和渲染进程品牌标识复用。
对应文档: Electron + Vite GUI implementation plan
*/

export const LOGO_VIEWBOX = "0 0 64 64";
export const LOGO_BACKGROUND = "#d97757";
export const LOGO_FOREGROUND = "#fff7ed";

export function logoMarkPaths(color = "currentColor") {
  return `
    <g fill="none" stroke="${color}" stroke-width="5.8" stroke-linecap="round">
      <path d="M32 9.5V25.5"/>
      <path d="M43.25 12.52L35.25 26.38"/>
      <path d="M51.48 20.75L37.62 28.75"/>
      <path d="M54.5 32H38.5"/>
      <path d="M51.48 43.25L37.62 35.25"/>
      <path d="M43.25 51.48L35.25 37.62"/>
      <path d="M32 54.5V38.5"/>
      <path d="M20.75 51.48L28.75 37.62"/>
      <path d="M12.52 43.25L26.38 35.25"/>
      <path d="M9.5 32H25.5"/>
      <path d="M12.52 20.75L26.38 28.75"/>
      <path d="M20.75 12.52L28.75 26.38"/>
    </g>`;
}

export function logoSvg(color = "currentColor", size = 64) {
  return `<svg width="${size}" height="${size}" viewBox="${LOGO_VIEWBOX}" xmlns="http://www.w3.org/2000/svg">${logoMarkPaths(color)}</svg>`;
}
