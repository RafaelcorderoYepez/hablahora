/** Períodos de las métricas, en días hasta hoy (fuera de Metrics.tsx para no cargar Recharts antes de tiempo). */
export const PERIODS = [7, 30, 90] as const;
export type Period = (typeof PERIODS)[number];

/** Períodos del panel de la plataforma (igual que las métricas del negocio). */
export const OVERVIEW_PERIODS = PERIODS;
export type OverviewPeriod = Period;
