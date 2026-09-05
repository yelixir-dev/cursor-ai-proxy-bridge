export const ROOT_TYPES = [
  'aiserver.v1.GetMeRequest',
  'aiserver.v1.GetMeResponse',
  'aiserver.v1.GetServerConfigRequest',
  'aiserver.v1.GetServerConfigResponse',
  'aiserver.v1.AvailableModelsRequest',
  'aiserver.v1.AvailableModelsResponse',
  'agent.v1.GetUsableModelsRequest',
  'agent.v1.GetUsableModelsResponse',
  'agent.v1.GetDefaultModelForCliRequest',
  'agent.v1.GetDefaultModelForCliResponse',
  'agent.v1.AgentClientMessage',
  'agent.v1.AgentServerMessage',
  'aiserver.v1.GetManagedSkillsRequest',
  'aiserver.v1.GetManagedSkillsResponse',
  'aiserver.v1.GetEffectiveUserPluginsRequest',
  'aiserver.v1.GetEffectiveUserPluginsResponse',
];

export const SERVICES = [
  {
    service: 'aiserver.v1.DashboardService',
    method: 'GetManagedSkills',
    input: 'aiserver.v1.GetManagedSkillsRequest',
    output: 'aiserver.v1.GetManagedSkillsResponse',
    kind: 'unary',
  },
  {
    service: 'aiserver.v1.DashboardService',
    method: 'GetEffectiveUserPlugins',
    input: 'aiserver.v1.GetEffectiveUserPluginsRequest',
    output: 'aiserver.v1.GetEffectiveUserPluginsResponse',
    kind: 'unary',
  },
  {
    service: 'aiserver.v1.DashboardService',
    method: 'GetMe',
    input: ROOT_TYPES[0],
    output: ROOT_TYPES[1],
    kind: 'unary',
  },
  {
    service: 'aiserver.v1.AiService',
    method: 'AvailableModels',
    input: ROOT_TYPES[4],
    output: ROOT_TYPES[5],
    kind: 'unary',
  },
  {
    service: 'aiserver.v1.ServerConfigService',
    method: 'GetServerConfig',
    input: ROOT_TYPES[2],
    output: ROOT_TYPES[3],
    kind: 'unary',
  },
  {
    service: 'aiserver.v1.AiService',
    method: 'GetUsableModels',
    input: ROOT_TYPES[6],
    output: ROOT_TYPES[7],
    kind: 'unary',
  },
  {
    service: 'aiserver.v1.AiService',
    method: 'GetDefaultModelForCli',
    input: ROOT_TYPES[8],
    output: ROOT_TYPES[9],
    kind: 'unary',
  },
  {
    service: 'agent.v1.AgentService',
    method: 'Run',
    input: ROOT_TYPES[10],
    output: ROOT_TYPES[11],
    kind: 'bidi_streaming',
  },
];

export const EXTRA_REACHABILITY_ROOTS = [
  'agent.v1.ConversationTurnStructure',
  'agent.v1.ConversationStep',
];
