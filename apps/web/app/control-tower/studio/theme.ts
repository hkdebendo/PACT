// The PACT theme for AG Studio, built on Studio's theming API (studioTheme.withParams), with a
// light and a dark mode. Every colour points at a design token from app/globals.css, so the shell,
// Studio's chrome, grid widgets, charts and PACT's custom widgets all change together; the two
// named modes only switch what differs structurally (browser colour scheme, shadows).
// Exported to/edited with the AG Studio Theme Builder: the parameter names are the builder's.
import { studioGridTheme, studioTheme } from 'ag-studio';

const t = (name: string) => `var(--pact-${name})`;
const line = (color: string) => ({ width: 1, color: t(color) });

const palette = Object.fromEntries(
  Array.from({ length: 10 }, (_, i) => [
    [`chartPaletteFills${i + 1}Color`, t(`chart-${i + 1}`)],
    [`chartPaletteStrokes${i + 1}Color`, t(`chart-${i + 1}`)],
  ]).flat(),
);

const shared = {
  fontFamily: t('font'),
  fontSize: 14,
  textColor: t('ink'),
  foregroundColor: t('ink'),
  subtleTextColor: t('muted'),
  backgroundColor: t('surface'),
  borderColor: t('line'),
  accentColor: t('navy'),
  iconColor: t('ink-2'),
  rowHoverColor: t('paper-2'),
  borderRadius: 10,
  tooltipBackgroundColor: t('ink'),
  tooltipTextColor: t('paper'),
  tooltipBorder: false,
  menuBackgroundColor: t('surface'),
  menuBorder: line('line'),
  menuTextColor: t('ink'),

  // The canvas is the page's paper; widgets are ledger cards.
  studioWrapperBorder: false,
  studioWrapperBorderRadius: 0,
  studioWrapperSpacing: 0,
  studioWrapperBackgroundColor: 'transparent',
  studioCanvasBorder: false,
  studioCanvasBorderRadius: 0,
  studioCanvasShadow: false,
  studioCanvasBackgroundColor: 'transparent',
  studioCanvasPadding: 18,
  // Below this the canvas scrolls sideways instead of squeezing cards (edit mode, small screens).
  studioCanvasMinWidth: 1080,
  studioCanvasRowHeight: 18,
  studioCanvasFontFamily: t('font'),

  studioWidgetBackgroundColor: t('surface'),
  studioWidgetBorder: line('line'),
  studioWidgetBorderRadius: 16,
  studioWidgetPadding: 9, // the gap between cards (Studio insets each widget by this much)
  studioWidgetTitleFontFamily: t('display'),
  studioWidgetTitleFontSize: 17,
  studioWidgetTitleFontWeight: 500,
  studioWidgetTitleTextColor: t('ink'),
  studioWidgetSubtitleFontFamily: t('font'),
  studioWidgetSubtitleFontSize: 12.5,
  studioWidgetSubtitleTextColor: t('muted'),
  studioWidgetCaptionFontFamily: t('font'),
  studioWidgetCaptionFontSize: 12,
  studioWidgetCaptionTextColor: t('muted'),
  studioWidgetResizeBorderColor: t('held'),
  studioValueWidgetFontSize: 32,

  studioPanelContainerBackgroundColor: t('surface'),
  studioPanelContainerBorder: line('line'),
  studioPanelContainerBorderRadius: 0,
  studioPanelDividerColor: t('line'),
  studioPanelDividerActiveColor: t('held'),
  studioPanelSectionBorderColor: t('line'),
  studioPanelHeaderFontFamily: t('font'),
  studioPanelHeaderFontWeight: 600,
  studioPanelChevronButtonHoverBackgroundColor: t('paper-2'),
  studioPanelChevronButtonHoverColor: t('navy'),
  studioToggleButtonActiveBackgroundColor: t('paper-2'),
  studioToggleButtonActiveBorderColor: t('navy'),
  studioToggleButtonActiveColor: t('navy'),

  gridFontFamily: t('font'),
  gridFontSize: 13,
  gridCellTextColor: t('ink'),
  gridHeaderBackgroundColor: t('surface'),
  gridHeaderTextColor: t('muted'),
  gridHeaderFontWeight: 600,
  gridHeaderFontSize: 11.5,
  gridHeaderHeight: 40,
  gridRowHeight: 40,
  gridCellHorizontalPadding: 20,
  gridRowBorder: line('line-2'),
  gridHeaderRowBorder: line('line'),
  gridPinnedRowBorder: line('line'),
  gridRowHoverColor: t('paper-2'),
  gridWrapperBorder: false,

  chartFontFamily: t('font'),
  chartTextColor: t('ink'),
  chartSubtleTextColor: t('muted'),
  chartAxisLineColor: t('line'),
  chartGridLineColor: t('line-2'),
  chartChartPadding: 16,
  chartTooltipBackgroundColor: t('ink'),
  chartTooltipTextColor: t('paper'),
  chartTooltipBorder: false,
  chartTooltipBorderRadius: 10,
  ...palette,
};

export const PACT_THEME_MODES = { light: 'pact-light', dark: 'pact-dark' } as const;

export const pactStudioTheme = studioTheme
  .withParams({ ...shared, browserColorScheme: 'light' }, PACT_THEME_MODES.light)
  .withParams({ ...shared, browserColorScheme: 'dark' }, PACT_THEME_MODES.dark);

// PACT's custom grid widgets use Studio's grid theme plus the ledger look: cell padding aligned with
// the widget title, quiet column separators, a navy selection and the same tokens in both modes.
export const pactGridTheme = studioGridTheme.withParams({
  fontFamily: t('font'),
  fontSize: 13,
  foregroundColor: t('ink'),
  textColor: t('ink'),
  backgroundColor: t('surface'),
  headerBackgroundColor: t('surface'),
  headerTextColor: t('muted'),
  headerFontSize: 11.5,
  headerFontWeight: 600,
  headerHeight: 40,
  cellHorizontalPadding: 20,
  wrapperBorder: false,
  wrapperBorderRadius: 0,
  columnBorder: false,
  headerColumnBorder: false,
  headerColumnResizeHandleColor: 'transparent',
  rowBorder: { width: 1, color: t('line-2') },
  headerRowBorder: { width: 1, color: t('line') },
  rowHoverColor: t('paper-2'),
  selectedRowBackgroundColor: 'color-mix(in srgb, var(--pact-navy) 9%, transparent)',
  accentColor: t('navy'),
  iconColor: t('muted'),
  borderColor: t('line'),
  tooltipBackgroundColor: t('ink'),
  tooltipTextColor: t('paper'),
  tooltipBorder: false,
} as never);
