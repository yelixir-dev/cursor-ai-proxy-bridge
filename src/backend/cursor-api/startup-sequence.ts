export const CURSOR_API_STARTUP_SEQUENCE = [
  '/aiserver.v1.DashboardService/GetMe',
  '/aiserver.v1.ServerConfigService/GetServerConfig',
  '/aiserver.v1.AiService/AvailableModels',
  '/aiserver.v1.AiService/GetUsableModels',
  '/aiserver.v1.AiService/GetDefaultModelForCli',
  '/aiserver.v1.DashboardService/GetMe',
  '/aiserver.v1.ServerConfigService/GetServerConfig',
  '/aiserver.v1.AnalyticsService/SubmitLogs',
  '/aiserver.v1.AnalyticsService/TrackEvents',
  '/aiserver.v1.AnalyticsService/SubmitLogs',
  '/aiserver.v1.AnalyticsService/SubmitLogs',
] as const;
